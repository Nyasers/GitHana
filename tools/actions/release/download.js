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
 *
 * ## 为什么它返回句柄而不是「已经下好了」
 *
 * 工具回调有 30 秒硬上限。大资产（实测 31.5 MB 的发布包）里挂上去就撞线，而撞线意味着
 * 调用方永远收不到回执——尽管 worker 可能已经把字节完整写进盘。所以与
 * `githana_run(action="watch")` 同形：建宿主后台任务、把下载丢后台、立即返回句柄，
 * 结束后由宿主按 `next-step` 档位把结论贴回来源会话。下载细节见 `tools/lib/transfer-task.js`。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { locateRelease, findAsset, assetLine } from "../../lib/release.js";
import { apiUrl } from "../../lib/rest.js";
import { taskCapabilityError } from "../../lib/tasks.js";
import { startTransferTask, resolveTargetPath, makeRestTransfer } from "../../lib/transfer-task.js";

export const command = "download";
export const summary = "Download release assets in the background (streamed to disk: path or dir, optionally assetName); returns a task handle and posts the result back to this session";

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
    "Read the contents of remote GitHub release assets and write them to the local disk (creates local files): does not modify remote state, but writes local files — confirm repo, tag and target path before running. Returns a background task handle; the result is posted back to this session",
  ruleId: "github-toolkit-release-download",
};

/** 组目标路径：path 优先；否则 dir（或 cwd）+ 资产名。 */
function targetPathFor(input, assetName) {
  return resolveTargetPath(input, assetName);
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

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

  // 目标集先在这里收成「任务项」——路径、id、名字全部定好，之后的事交给后台。
  // 这一跳仍然在回调里做，因为它是纯 JSON（定位 release）加本地路径计算，耗时可忽略；
  // 真正会超时的只有字节落盘那一段。
  const items = [];
  const invalid = [];
  for (const a of targets) {
    const assetName = a && a.name ? String(a.name) : "";
    if (!assetName) {
      invalid.push("  ! the asset response has no name, so the file name on disk cannot be determined (id " + (a && a.id !== undefined ? a.id : "?") + ").");
      continue;
    }
    if (a.id === undefined || a.id === null) {
      invalid.push("  ! " + assetName + ": the asset response has no id, so the endpoint for fetching bytes cannot be built.");
      continue;
    }
    const target = targetPathFor(input, assetName);
    if (target.error) {
      invalid.push("  ! " + assetName + ": " + target.error);
      continue;
    }
    items.push({
      name: assetName,
      target: target.path,
      fromPath: target.fromPath === true,
      digest: a.digest ? String(a.digest) : null,
      run: makeRestTransfer({
        id: "asset-" + String(a.id),
        url: apiUrl(repo, "/releases/assets/" + encodeURIComponent(String(a.id))),
        target: target.path,
        overwrite,
        timeoutSec,
      }),
    });
  }

  // 全部目标都在回调这一跳就失败了（没有可跑的东西）：直接报，不值得建任务。
  if (items.length === 0) {
    return [
      label + " (" + repoLabel + " · " + (rel.tag_name || "?") + "):",
      "nothing to download:",
      ...invalid,
    ].join("\n");
  }

  const callToken = input && input.context && input.context.callToken ? String(input.context.callToken) : "";
  if (!callToken) {
    return (
      label + " cannot start: this call did not carry the host-injected callToken (which binds the background task to the source session).\n" +
      "This verb downloads in the background so the tool callback does not hit its 30s limit; without a token the result has no session to come back to."
    );
  }
  const capErr = taskCapabilityError(label);
  if (capErr) return capErr;

  const started = await startTransferTask(input, {
    label: label + " download " + (rel.tag_name || "?"),
    callToken,
    repo,
    repoLabel,
    scenario: rel.tag_name || "?",
    items,
    overwrite,
    timeoutSec,
    meta: { verb: "release.download" },
  });
  if (started.error) return label + " execution failed: " + started.error;

  const out = [
    label + " download started (" + repoLabel + " · " + (rel.tag_name || "?") + ") — **it does not wait for the bytes to land**; this call ends here:",
    "handle: taskId " + started.taskId + " (host background task; delivery=" + String(started.record && started.record.delivery ? started.record.delivery : "next-step") + ")",
    "targets: " + items.length + (overwrite ? " (overwriting same-named files is allowed)" : " (existing targets are not overwritten)"),
  ];
  for (const it of items) {
    out.push("  · " + it.name + " → " + it.target + (it.fromPath ? "" : it.digest ? "" : ""));
    if (!it.fromPath && !input?.dir) out.push("     note: no path / dir was given, so it lands in this process's current directory.");
  }
  if (invalid.length) {
    out.push("");
    out.push("skipped (not handed to the background task):");
    out.push(...invalid);
  }
  out.push("");
  out.push("where the conclusion goes: when every file is written (or the first failure settles it), the host posts the result back to **this session**'s next input point.");
  out.push("to stop it midway: cancel it from this session's background task item — remaining files are skipped; a transfer already in flight runs to completion (the REST worker is a separate process with no mid-stream abort).");
  return out.join("\n");
}
