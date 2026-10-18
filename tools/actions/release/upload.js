// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/upload：把本地文件作为发布资产上传。
 *
 * ## 两跳：先定位 release，再把字节发到 uploads 域
 *
 * 定位那一跳是纯 JSON（`GET /releases/tags/{tag}` 拿 release id），走 api.github.com。
 * 上传那一跳不一样：端点是 `POST https://uploads.github.com/repos/{o}/{r}/releases/{id}/assets?name=<资产名>`
 * ——**不是 api.github.com**（GitHub 把资产上传单独摆了一个域，凭据仍是同一枚 Bearer）。
 * 请求体是**原始二进制**，不是 multipart；带 `Content-Type: application/octet-stream`。
 *
 * ## 字节怎么过去：worker 读、worker 发
 *
 * 这里只把**路径**交给 worker（请求字段 `file`）：由它 `fs.createReadStream` 那条流作 fetch 的
 * body，并显式带 `Content-Length`——文件不进 App 进程的内存，也不走分块编码。App 进程读不到
 * 许可根外的文件，worker 读得到（它是我们 spawn 的，`rest.js` 会按本请求的路径放行那个目录）。
 *
 * ## 上限、报错与「不白传」
 *
 * GitHub 对单个资产的硬限是 **< 2 GiB**。这条限在 worker 侧**发请求前**就比（AC11）：几百 MB
 * 传完再被拒是纯粹的浪费。2 GiB 是 GitHub 的硬限、翻不过去，也没有分片 / 断点续传可绕
 * （它的资产 API 没有这个语义，重试即重传）。
 *
 * 同名资产已存在回 422，这里按 AC13 指引「先 delete-asset 再传」。
 *
 * `digest` 这条线：`contentType` 由调用方给，缺省 `application/octet-stream`（不做扩展名推断
 * ——猜错比不猜更坏）。本地 sha256 **由 worker 顺带算**（App 进程通常读不到那个文件），
 * 上传成功后与响应里的 `digest` 对照报出来（AC4 的核对入口）；响应不带 digest 就如实说明
 * 「这次没有远端摘要可核对」，不假装核对过。
 *
 * ## 为什么它返回句柄而不是「已经传好了」
 *
 * 上传比下载慢（出网带宽通常小于入网，且 worker 还要先读一遍算 sha256），而工具回调只有
 * 30 秒。所以与 `githana_run(action="watch")` 同形：建宿主后台任务、把上传丢后台、立即返回
 * 句柄，结束后由宿主把结论贴回来源会话。细节见 `tools/lib/transfer-task.js`。
 *
 * 注意：后台化之后，**422 同名冲突这类需要人看着办的错**也是在结论里回来，不再是同步报错。
 * 文案仍然保留了「先 delete-asset 再传」的指引，只是晚一步到手上。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { locateRelease } from "../../lib/release.js";
import { uploadsUrl } from "../../lib/rest.js";
import { MAX_ASSET_BYTES, normalizeAbsolutePath, parseDigest } from "../../lib/transfer.js";
import { taskCapabilityError } from "../../lib/tasks.js";
import { startTransferTask, makeRestUpload } from "../../lib/transfer-task.js";

export const command = "upload";
export const summary = "Upload a release asset in the background (local file → uploads.github.com, bytes streamed); returns a task handle and posts the result back to this session";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  file: z.string().describe("Absolute path to the local file (the asset to upload)"),
  assetName: z.string().optional().describe("Optional: asset name after upload (defaults to the file name)"),
  contentType: z.string().optional().describe("Optional: Content-Type (defaults to application/octet-stream; no extension-based guessing)"),
  // 叫 assetLabel 而不是 label：后者在本工具里已经是**路由层的报错前缀**（surface.js 拼的
  // "githana_release(upload)"，经 run() 的第三个参数进来），同一个词指两件事会让读的人先愣一下。
  // 它对应 gh 的 `--label` 与 REST 资产载荷里的 `label` 字段。
  assetLabel: z.string().optional().describe("Optional: display label for the asset (corresponds to gh's --label / the label field in the REST asset payload)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Upload a release asset to remote GitHub (creates a new asset object): modifies remote GitHub state, confirm repo, tag and the local file before running",
  ruleId: "github-toolkit-release-upload",
};

/** 从路径里取文件名（Windows 与 POSIX 分隔符都认）。 */
function baseName(p) {
  return String(p).split(/[\\/]/).pop() || String(p);
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const norm = normalizeAbsolutePath(input?.file, "file");
  if (norm.error) return label + " argument error: " + norm.error;
  const file = norm.path;

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  if (rel.id === undefined || rel.id === null) {
    return label + " execution failed: the release response has no id, so the asset upload endpoint cannot be built.";
  }

  // 资产名缺省取文件名：GitHub 的资产名与本地文件名是两件事，但「不说就用文件名」是 gh 的行为。
  const nameIn = input?.assetName !== undefined && input?.assetName !== null ? String(input.assetName).trim() : "";
  const assetName = nameIn || baseName(file);

  const query = "?name=" + encodeURIComponent(assetName) + (input?.assetLabel ? "&label=" + encodeURIComponent(String(input.assetLabel)) : "");
  const url = uploadsUrl("/repos/" + repo + "/releases/" + encodeURIComponent(String(rel.id)) + "/assets" + query);

  const callToken = input && input.context && input.context.callToken ? String(input.context.callToken) : "";
  if (!callToken) {
    return (
      label + " cannot start: this call did not carry the host-injected callToken (which binds the background task to the source session).\n" +
      "This verb uploads in the background so the tool callback does not hit its 30s limit; without a token the result has no session to come back to."
    );
  }
  const capErr = taskCapabilityError(label);
  if (capErr) return capErr;

  // 上传与下载共用同一个后台任务机制：一个 item、一次 RPC，只是字段不同（见 transfer-task.js）。
  const item = {
    name: assetName,
    target: file,
    run: makeRestUpload({
      id: "upload",
      url,
      file,
      contentType: input?.contentType ? String(input.contentType) : "application/octet-stream",
      maxFileBytes: MAX_ASSET_BYTES,
      timeoutSec,
    }),
  };

  const started = await startTransferTask(input, {
    label: label + " upload " + assetName,
    callToken,
    repo,
    repoLabel,
    scenario: (rel.tag_name || input?.tag || "?") + " · " + assetName,
    items: [item],
    overwrite: false,
    timeoutSec,
    meta: { verb: "release.upload" },
    // 上传的结论不是「写了几字节」，而是与远端摘要的对照，以及 422 这种要人看着办的错。
    describeResult: (r) => describeUploadResult(r, { label, repoLabel, rel, assetName, file, url, input }),
  });
  if (started.error) return label + " execution failed: " + started.error;

  return [
    label + " upload started (" + repoLabel + " · " + (rel.tag_name || "?") + ") — **it does not wait for the bytes to leave**; this call ends here:",
    "handle: taskId " + started.taskId + " (host background task; delivery=" + String(started.record && started.record.delivery ? started.record.delivery : "next-step") + ")",
    "file: " + file + " → asset \"" + assetName + "\"",
    "",
    "where the conclusion goes: when the upload settles (success or failure), the host posts the result back to **this session**'s next input point — including the remote-digest comparison, and for a 422 the delete-asset guidance.",
    "to stop it midway: cancel it from this session's background task item — a transfer already in flight runs to completion (the REST worker is a separate process with no mid-stream abort).",
  ].join("\n");
}

/** 上传成功 / 失败时的结论文本（在后台任务里拼，这里拿得到 res.json 与 res.sha256）。 */
function describeUploadResult(r, { label, repoLabel, rel, assetName, file, url, input }) {
  if (!r.ok) {
    if (r.status === 422) {
      const detail = r.json ? JSON.stringify(r.json) : "(no body)";
      return [
        label + " execution failed: GitHub rejected this upload (422). The most common cause is that **an asset with the same name already exists** —",
        "asset names are unique within a release. GitHub raw message: " + detail,
        "What to do: delete that asset first, then upload —",
        "  githana_release(action=\"delete-asset\", tag=\"" + (rel.tag_name || input?.tag || "?") + "\", assetName=\"" + assetName + "\", confirm=true)",
        "Or use a different asset name (pass assetName).",
      ].join("\n");
    }
    return [label + " execution failed: " + r.message, "(upload endpoint " + url + ")"].join("\n");
  }

  const res = r.res;
  const asset = r.json && typeof r.json === "object" ? r.json : {};
  const out = [
    label + " uploaded (" + repoLabel + " · " + (rel.tag_name || "?") + "):",
    "asset: " + (asset.name || assetName) + (asset.id !== undefined ? " · id " + asset.id : ""),
    "HTTP " + (res ? res.status : "?") + " (a newly created asset should be 201)",
  ];
  if (asset.size !== undefined) out.push("remote size: " + asset.size + " bytes");
  if (res && res.size !== null && res.size !== undefined && asset.size !== undefined && Number(asset.size) !== res.size) {
    out.push("      note: does not match the local size of " + res.size + " bytes; please double-check.");
  }
  if (asset.content_type) out.push("type: " + asset.content_type);
  if (asset.state) out.push("state: " + asset.state);
  if (asset.label) out.push("label: " + asset.label);
  if (asset.browser_download_url) out.push("direct link: " + String(asset.browser_download_url));

  // GitHub 会重命名含特殊字符 / 前后空格的资产名，如实说一声（响应里的 name 才是权威值）。
  if (asset.name && String(asset.name) !== assetName) {
    out.push("note: GitHub changed the asset name from " + assetName + " to " + String(asset.name) + " (the name in the response is authoritative).");
  }

  out.push("");
  out.push("local file: " + file + (res && res.size !== null && res.size !== undefined ? " (" + res.size + " bytes)" : ""));
  const localHex = res ? res.sha256 : null;
  const remote = parseDigest(asset.digest);
  if (localHex) out.push("local sha256: " + localHex);
  if (remote && remote.algorithm === "sha256" && localHex) {
    out.push("remote sha256: " + remote.hex);
    out.push(
      remote.hex === localHex
        ? "conclusion: **the bytes match** — what was uploaded is exactly this local file."
        : "conclusion: **they differ** — the remote digest differs from the local one; please double-check (and consider verifying again with verify-asset).",
    );
  } else if (asset.digest) {
    out.push("the remote records " + String(asset.digest) + ", which is not a comparable form.");
  } else {
    out.push("note: the response has no digest field, so there is no remote digest to check this upload's bytes against.");
    out.push("      To compare against the local copy use githana_release(action=\"verify-asset\", tag=\"" + (rel.tag_name || input?.tag || "?") + "\", assetName=\"" + (asset.name || assetName) + "\", file=\"" + file + "\").");
  }
  return out.join("\n");
}
