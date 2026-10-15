// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/download：把发布资产取到本地。
 *
 * ## 两跳：先定位资产，再把字节落到盘上
 *
 * 定位那一跳是纯 JSON（`GET /releases/tags/{tag}` 拿内嵌的 assets），走 api.github.com。
 * 取字节那一跳是 `GET /repos/{o}/{r}/releases/assets/{asset_id}` 带上
 * `Accept: application/octet-stream`（不带它返回的是资产的 JSON 元数据）。这一跳会 **302 到
 * `release-assets.githubusercontent.com`**（实测：一跳 302 → 200）——由 worker 逐跳校验白名单
 * 并跟随，且离开 api.github.com 后不带走凭据（那是公开下载域，不需要令牌）。
 *
 * ## 字节怎么下来：worker 写盘
 *
 * 这里只把**目标路径**交给 worker（请求字段 `toFile`）：它把响应体经 `Readable.fromWeb` 接到
 * `fs.createWriteStream`，字节原样落盘——不按 UTF-8 解码、不套 2MB 的有界读、不把整个资产读进
 * 内存。App 进程写不了许可根外的路径，worker 写得（`rest.js` 会按本请求的路径放行那个目录）。
 *
 * 写盘有两条安全线：`overwrite` 不为 true 且目标已存在时**拒写**（不悄悄盖掉用户手上的文件）；
 * 响应不是 2xx 时**不落盘**（把 GitHub 的错误原文按文本回报），写了一半失败则把那个半成品删掉
 * ——宁可没有文件，也不要一份「看着下好了、其实不完整」的资产。
 *
 * ## 目标路径：三种给法，优先级明确
 *
 *   · `path`——完整的目标文件路径（最直接）；
 *   · `dir` + （资产名或 `assetName`）——目录加文件名，对应 gh 的 `--dir`；
 *   · 都不给——落到本进程 cwd 下的资产名（`gh release download` 缺省就是当前目录）。
 *
 * 一次可以取一个资产（`assetName` / `assetId`）或该 release 的**全部**资产（都不给）。
 */
import path from "node:path";
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { locateRelease, findAsset, assetLine, formatSize } from "../../lib/release.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { normalizeAbsolutePath, transferFailureText, safeFileName } from "../../lib/transfer.js";

export const command = "download";
export const summary = "Download release assets (streamed to disk: path or dir, optionally assetName)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetNameOptional.describe("Optional: name of the asset to download; default = all assets of that release"),
  assetId: z.number().int().min(1).optional().describe("Optional: identify the asset by numeric id (either this or assetName; assetName takes priority over it)"),
  path: z.string().optional().describe("Optional: absolute path of the target file (used when fetching a single asset; mutually exclusive with dir, path wins)"),
  dir: z.string().optional().describe("Optional: target directory (default = this process's cwd); the file name on disk is taken from the asset name"),
  overwrite: z.boolean().optional().describe("Optional: whether to overwrite an existing target file (default false: do not overwrite; the error tells you to pick another name or overwrite explicitly)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Read the contents of remote GitHub release assets and write them to the local disk (creates local files): does not modify remote state, but writes local files — confirm repo, tag and target path before running",
  ruleId: "github-toolkit-release-download",
};

/** 组目标路径：path 优先；否则 dir（或 cwd）+ 资产名。 */
function targetPathFor(input, assetName) {
  const p = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (p) {
    const norm = normalizeAbsolutePath(p, "path");
    return norm.error ? { error: norm.error } : { path: norm.path, fromPath: true };
  }
  // 资产名是远端给的（外部输入），落盘文件名要收成安全的一段——见 safeFileName。
  const safe = safeFileName(assetName, "asset.bin");
  const d = input?.dir !== undefined && input?.dir !== null ? String(input.dir).trim() : "";
  if (d) {
    const norm = normalizeAbsolutePath(d, "dir");
    if (norm.error) return { error: norm.error };
    return { path: path.join(norm.path, safe), fromPath: false };
  }
  // 都不给：落到本进程 cwd 下的资产名（gh release download 的缺省就是当前目录）。
  // cwd 是 App 进程的工作目录，在许可根之外——worker 未必写得进去，但那是**可读的**失败，
  // 报错里会请调用方显式给 path 或 dir。
  return { path: path.resolve(process.cwd(), safe), fromPath: false };
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];

  // 目标集：点名一个资产，或该 release 的全部资产。
  let targets = assets;
  const named = input?.assetName !== undefined && input.assetName !== null && String(input.assetName).trim() !== "";
  const numbered = input?.assetId !== undefined && input.assetId !== null;
  if (named || numbered) {
    const found = findAsset(rel, input);
    if (found.error) {
      return [
        label + " argument error: " + found.error,
        "assets of that release:",
        (found.list.length ? found.list.map(assetLine).join("\n") : "  (no assets at all)"),
      ].join("\n");
    }
    targets = [found.asset];
  }

  if (targets.length === 0) {
    return label + ": " + repoLabel + " · tag " + (rel.tag_name || "?") + " has no assets at all in this release.";
  }

  // path 只对「取一个资产」有意义：两个资产写同一个文件必然是错的（后者会覆盖前者）。
  const singlePath = input?.path !== undefined && input?.path !== null && String(input.path).trim() !== "";
  if (singlePath && targets.length > 1) {
    return [
      label + " argument error: path can only go with a single asset, but this selection contains " + targets.length + ".",
      "Either name one with assetName / assetId, or switch to dir (each asset then lands under its own file name).",
      "assets of that release:",
      targets.map(assetLine).join("\n"),
    ].join("\n");
  }

  const overwrite = input?.overwrite === true;

  // 每个资产一个请求，但如果落点重名（同一目录下两个资产同名不可能）就不是问题；
  // 这里逐个请求，是为了让「哪一个失败了」清楚——一个成、一个败比整批失败有用。
  const lines = [
    label + " (" + repoLabel + " · " + (rel.tag_name || "?") + "):",
    "target assets: " + targets.length + (overwrite ? " (overwriting same-named files is allowed)" : " (existing targets are not overwritten)"),
  ];

  let done = 0;
  let failed = 0;
  for (const a of targets) {
    const assetName = a && a.name ? String(a.name) : "";
    if (!assetName) {
      lines.push("");
      lines.push("  ! the asset response has no name, so the file name on disk cannot be determined (id " + (a && a.id !== undefined ? a.id : "?") + ").");
      failed += 1;
      continue;
    }
    if (a.id === undefined || a.id === null) {
      lines.push("");
      lines.push("  ! " + assetName + ": the asset response has no id, so the endpoint for fetching bytes cannot be built.");
      failed += 1;
      continue;
    }

    const target = targetPathFor(input, assetName);
    if (target.error) {
      lines.push("");
      lines.push("  ! " + assetName + ": " + target.error);
      failed += 1;
      continue;
    }

    const r = await callRest(
      [
        {
          id: "asset-" + String(a.id),
          // Accept: application/octet-stream 是「取字节」的那条；不带它返回的是资产的 JSON 元数据。
          headers: { Accept: "application/octet-stream" },
          url: apiUrl(repo, "/releases/assets/" + encodeURIComponent(String(a.id))),
          toFile: target.path,
          overwrite,
          timeoutMs,
        },
      ],
      { timeoutSec },
    );

    lines.push("");
    if (!r.ok) {
      lines.push("  ! " + assetName + ": execution failed: " + r.message);
      failed += 1;
      continue;
    }
    const res = r.results[0];
    const byCode = transferFailureText(res);
    if (byCode) {
      lines.push("  ! " + assetName + ": write to disk failed — " + target.path);
      lines.push("    " + byCode);
      failed += 1;
      continue;
    }
    if (!res || !res.ok) {
      lines.push("  ! " + assetName + ": GitHub returned HTTP " + (res ? res.status : "?") + " — " + describeFailure(res, repoLabel));
      failed += 1;
      continue;
    }

    lines.push("  ✓ " + assetName + " → " + target.path);
    if (res.bytes !== null && res.bytes !== undefined) lines.push("     wrote " + res.bytes + " bytes (" + formatSize(res.bytes) + ")");
    if (target.fromPath === false && !singlePath && !input?.dir) {
      lines.push("     note: no path / dir was given, so it landed in this process's current directory. To choose a location pass dir or path.");
    }
    if (a.digest) lines.push("     remote digest: " + String(a.digest) + " (to check the local copy use verify-asset)");
    done += 1;
  }

  lines.push("");
  lines.push(
    done === targets.length
      ? "done: " + done + " asset(s) written to disk."
      : "done " + done + " / failed " + failed + " (see each line above).",
  );
  if (done > 0 && !overwrite) {
    lines.push("note: this run did not overwrite any existing file (overwrite defaults to false). To overwrite, pass overwrite=true explicitly.");
  }
  return lines.join("\n");
}
