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
export const summary = "下载发布资产（流式写盘：path 或 dir，可指定 assetName）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetNameOptional.describe("可选：要下载的资产名；缺省 = 该 release 的全部资产"),
  assetId: z.number().int().min(1).optional().describe("可选：按数字 id 指定资产（与 assetName 二选一；assetName 优先不用它）"),
  path: z.string().optional().describe("可选：目标文件绝对路径（只取一个资产时用；与 dir 二选一，path 优先）"),
  dir: z.string().optional().describe("可选：目标目录（缺省 = 本进程 cwd）；落盘文件名取资产名"),
  overwrite: z.boolean().optional().describe("可选：目标文件已存在时是否覆盖（缺省 false：不覆盖，报错让你改名或显式覆盖）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "读取 GitHub 远端发布资产的内容并写入本地磁盘（新建本地文件）：不修改远端状态，但会写本地文件，执行前请确认 repo、tag 与目标路径",
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
        label + " 参数错误：" + found.error,
        "该 release 的资产：",
        (found.list.length ? found.list.map(assetLine).join("\n") : "  （没有任何资产）"),
      ].join("\n");
    }
    targets = [found.asset];
  }

  if (targets.length === 0) {
    return label + "：" + repoLabel + " · tag " + (rel.tag_name || "?") + " 这个 release 没有任何资产。";
  }

  // path 只对「取一个资产」有意义：两个资产写同一个文件必然是错的（后者会覆盖前者）。
  const singlePath = input?.path !== undefined && input?.path !== null && String(input.path).trim() !== "";
  if (singlePath && targets.length > 1) {
    return [
      label + " 参数错误：path 只能配一个资产，而这次选中了 " + targets.length + " 个。",
      "要么传 assetName / assetId 点名一个，要么改用 dir（每个资产各落在它自己的文件名下）。",
      "该 release 的资产：",
      targets.map(assetLine).join("\n"),
    ].join("\n");
  }

  const overwrite = input?.overwrite === true;

  // 每个资产一个请求，但如果落点重名（同一目录下两个资产同名不可能）就不是问题；
  // 这里逐个请求，是为了让「哪一个失败了」清楚——一个成、一个败比整批失败有用。
  const lines = [
    label + "（" + repoLabel + " · " + (rel.tag_name || "?") + "）：",
    "目标 " + targets.length + " 个资产" + (overwrite ? "（已允许覆盖同名文件）" : "（目标已存在时不覆盖）"),
  ];

  let done = 0;
  let failed = 0;
  for (const a of targets) {
    const assetName = a && a.name ? String(a.name) : "";
    if (!assetName) {
      lines.push("");
      lines.push("  ! 资产响应里没有 name，无法确定落盘文件名（id " + (a && a.id !== undefined ? a.id : "?") + "）。");
      failed += 1;
      continue;
    }
    if (a.id === undefined || a.id === null) {
      lines.push("");
      lines.push("  ! " + assetName + "：资产响应里没有 id，无法拼取字节的端点。");
      failed += 1;
      continue;
    }

    const target = targetPathFor(input, assetName);
    if (target.error) {
      lines.push("");
      lines.push("  ! " + assetName + "：" + target.error);
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
      lines.push("  ! " + assetName + "：执行失败：" + r.message);
      failed += 1;
      continue;
    }
    const res = r.results[0];
    const byCode = transferFailureText(res);
    if (byCode) {
      lines.push("  ! " + assetName + "：落盘失败 —— " + target.path);
      lines.push("    " + byCode);
      failed += 1;
      continue;
    }
    if (!res || !res.ok) {
      lines.push("  ! " + assetName + "：GitHub 返回 HTTP " + (res ? res.status : "?") + " —— " + describeFailure(res, repoLabel));
      failed += 1;
      continue;
    }

    lines.push("  ✓ " + assetName + " → " + target.path);
    if (res.bytes !== null && res.bytes !== undefined) lines.push("     写入 " + res.bytes + " 字节（" + formatSize(res.bytes) + "）");
    if (target.fromPath === false && !singlePath && !input?.dir) {
      lines.push("     说明：没给 path / dir，落在本进程的当前目录。要指定落点请传 dir 或 path。");
    }
    if (a.digest) lines.push("     远端摘要：" + String(a.digest) + "（要核对本地副本用 verify-asset）");
    done += 1;
  }

  lines.push("");
  lines.push(
    done === targets.length
      ? "完成：" + done + " 个资产已写盘。"
      : "完成 " + done + " 个 / 失败 " + failed + " 个（逐条见上）。",
  );
  if (done > 0 && !overwrite) {
    lines.push("说明：这次没有覆盖任何已存在的文件（overwrite 缺省 false）。要覆盖请显式传 overwrite=true。");
  }
  return lines.join("\n");
}
