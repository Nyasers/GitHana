// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/transfer.js — 二进制资产通道的现状与本地文件读取的统一处理。
 *
 * ## 二进制通道已可用（字节原样进、字节原样出）
 *
 * 发布资产的 upload / download 与 run 的 download 都走 worker 的二进制通道：
 *
 *   1. **二进制请求体**。worker 的请求字段收一个 `file`（本地路径）形态——它用
 *      `fs.createReadStream` 作 fetch 的 body、显式带 `Content-Length`，文件不进内存也不走
 *      分块编码。发布资产端点要的正是原始二进制体（不是 multipart），所以这条路对得上。
 *   2. **主机白名单**。出站白名单含 `uploads.github.com`（上传端点与 api 不同域）；
 *      `REDIRECT_HOSTS` 含下载侧的跳转目标（`release-assets.githubusercontent.com`、
 *      `objects.githubusercontent.com`、`results-receiver.actions.githubusercontent.com`，
 *      以及 `*.blob.core.windows.net` 这条后缀）。
 *   3. **二进制响应体**。下载时由 worker 把响应流式写进 `toFile` 指名的路径，不经过
 *      `Buffer.concat(...).toString("utf8")`、也不套那个 2MB 的有界读。
 *
 * 两条路都要求 worker 能读写调用方指名的那个目录——那由 `rest.js` 在 spawn 时按请求现算
 * `--allow-fs-read` / `--allow-fs-write`（worker 是我们 spawn 的，宿主的许可根不约束它）。
 *
 * 单文件上限是 GitHub 的硬限（< 2 GiB）：超限的文件由 worker **在发请求前**拒掉，
 * 不白传一遍。不做分片、不做断点续传——GitHub 的资产 API 没有这个语义（重试 = 重传）。
 *
 * ## 本地文件
 *
 * App 进程读不了许可根外的文件：`tools/lib/exec.js` 的 `checkCwd` 遇到 ERR_ACCESS_DENIED 是
 * **放行**的，因为那个路径最终交给 git 子进程——外部命令不继承 Node 权限模型，能自由访问任意
 * 目录。本进程内的裸 fs 没有这条退路：AppHost 的许可根只有安装目录（只读）与 dataDir。
 *
 * 所以两条路分工明确：
 *   · **算摘要这类「在本进程里做」的活**（sha256File / normalizeLocalPath）：直接读，被拒时给
 *     **点名的可读错误**（明确说这不是「文件不存在」）；
 *   · **搬字节这类「交给 worker 做」的活**（upload / download）：路径交给 worker，由它在
 *     spawn 放行过的目录里读写——App 进程碰都不碰那个文件。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { getToolDataDir } from "./context.js";
import { pluginRoot } from "./bin.js";

/** 本 App 在 AppHost 里的两个许可根（安装目录只读 / dataDir）：报错时点名它们。 */
function permittedRoots() {
  const roots = [];
  try {
    const root = pluginRoot();
    if (root) roots.push(root);
  } catch {
    /* 安装根推导失败：只报 dataDir */
  }
  const dataDir = getToolDataDir();
  if (dataDir) roots.push(dataDir);
  return roots;
}

/** 许可根之外的裸 fs 失败 → 可读错误（点明这不是「文件不存在」）。 */
export function deniedMessage(p, what) {
  const roots = permittedRoots();
  const dir = getToolDataDir() || "<HANA_HOME>/app-data/githana";
  return (
    "cannot " + what + " the local file " + p + ": the AppHost Node permission model only grants two permitted roots (" +
    (roots.length ? roots.join(" / ") : "installation directory / App data directory") +
    "), and raw fs reads/writes outside those roots are denied by the runtime (ERR_ACCESS_DENIED).\n" +
    "this is not \"the file does not exist\" — the file may be perfectly fine on disk, this process just is not allowed to touch it.\n" +
    "what works: put the file under the App data directory (" + dir + ") and retry."
  );
}

/**
 * 归一本地路径参数：只要求非空字符串。
 *
 * **不强制绝对路径**：相对路径相对的是 App 进程的 cwd，而那不是调用方的仓库（不可预测），
 * 所以描述里写明要绝对路径；判据留给 fs——真正读得到才算数。
 */
export function normalizeLocalPath(value, what) {
  const raw = value !== undefined && value !== null ? String(value).trim() : "";
  if (!raw) return { error: what + " is required (absolute path of a local file)." };
  return { path: raw };
}

/**
 * 流式计算本地文件的 sha256（十六进制小写）。
 *
 * 用流而不是 `readFileSync`：校验的对象可能是几百 MB 的发布包，整块读进内存没有收益
 * （摘要只需一遍）。
 * @returns {Promise<{ hex: string, size: number } | { error: string }>}
 */
export function sha256File(p, what) {
  return new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(p);
    } catch (e) {
      const code = e && e.code;
      if (code === "ERR_ACCESS_DENIED" || code === "EPERM") return resolve({ error: deniedMessage(p, "read") });
      return resolve({ error: what + "read failed (" + String(code || "unknown") + "): " + String((e && e.message) || e) + "." });
    }
    const hash = createHash("sha256");
    let size = 0;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", (e) => {
      const code = e && e.code;
      if (code === "ERR_ACCESS_DENIED" || code === "EPERM") return done({ error: deniedMessage(p, "read") });
      if (code === "ENOENT" || code === "ENOTDIR") return done({ error: what + " does not exist: " + p + "." });
      if (code === "EISDIR") return done({ error: what + " points to a directory, not a file: " + p + "." });
      done({ error: what + "read failed (" + String(code || "unknown") + "): " + String((e && e.message) || e) + "." });
    });
    stream.on("end", () => done({ hex: hash.digest("hex"), size }));
  });
}

/**
 * 解析 GitHub 给的 digest 串（形如 `sha256:<hex>`）。
 * @returns {{ algorithm: string, hex: string } | null}
 */
export function parseDigest(digest) {
  const raw = digest !== undefined && digest !== null ? String(digest).trim() : "";
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null;
  return { algorithm: raw.slice(0, idx).toLowerCase(), hex: raw.slice(idx + 1).toLowerCase() };
}

/**
 * 把远端给的文件名收成一个**安全的单段文件名**（写盘落点用）。
 *
 * 远端给的名字是**外部输入**，而它会拼进本地路径。不处理的话，一个叫 `../../x` 或
 * `a/b` 的资产名就能把文件写到目标目录之外——而资产名是发布者能随便定的（GitHub 只对少数
 * 特殊字符改名，不保证不含路径分隔符）。
 *
 * 做法：取最后一段（两个分隔符都认），去掉 Windows 上的保留形态（`..` / 空 / 盘符冒号），
 * 兜底给一个中性名。**不做** URL 解码之类会再造出分隔符的变换。
 */
export function safeFileName(name, fallback = "download.bin") {
  const raw = name !== undefined && name !== null ? String(name) : "";
  // 先按两种分隔符切，取最后一段：`a/b` 与 `a\b` 都收成 `b`。
  const seg = raw.split(/[\\/]/).pop() || "";
  // 去掉 Windows 上非法的字符（冒号还能造出盘符形态，必须去掉）。
  const cleaned = seg.replace(/[:*?"<>|]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * 本地路径参数：非空字符串 + 必须**绝对**。
 *
 * 与 normalizeLocalPath 的分工：那个只判非空（给 verify / verify-asset 用，那边相对路径也无所谓
 * ——本进程直接读，相对的是 App 的 cwd）；这个给**交给 worker 的二进制动作**用，那种场景下相对
 * 路径是错的：worker 的 cwd 与 App 的 cwd 都不是调用方的仓库，同一串相对路径在两边会指向不同的
 * 文件。与其猜，不如在入口就拒绝并说清要什么。
 */
export function normalizeAbsolutePath(value, what) {
  const norm = normalizeLocalPath(value, what);
  if (norm.error) return norm;
  if (!isAbsolutePath(norm.path)) {
    return {
      error:
        what + " needs an **absolute** path (received: " + norm.path + ").\n" +
        "this path is used by the worker subprocess, and its working directory is not your repository — a relative path would point elsewhere.",
    };
  }
  return norm;
}

/** 绝对路径判据（Windows 盘符 / UNC / POSIX 根三种形态）。 */
function isAbsolutePath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith("/");
}

/** GitHub 对**单个发布资产**的硬限：必须小于 2 GiB（文档原文 "under 2 GiB"）。 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

/** 把 worker 回的二进制通道失败 code 拼成可读文案；认不出来返回 null。 */
export function transferFailureText(result) {
  const code = result && result.code;
  const size = result && result.size;
  const human = size !== undefined && size !== null && Number.isFinite(Number(size)) ? formatBytes(Number(size)) : "?";
  switch (code) {
    case "file_unreadable":
      return (
        "cannot read this local file." +
        (result && result.cause === "EISDIR" ? " (it is a directory, not a file)" : " (the file does not exist, or the current user cannot read it)") +
        "\nnote: the reads/writes here are done by the worker subprocess; what is reported is **not** the AppHost permitted-root issue — " +
        "deniedMessage in `transfer.js` only applies to verbs that read directly in the App process (verify / verify-asset)."
      );
    case "file_too_large":
      return (
        "this file is " + human + ", above GitHub's per-file hard limit (< 2 GiB).\n" +
        "that is GitHub's hard limit, not this tool's, and there is no chunking / resumable upload to work around it (its asset API has no such semantics).\n" +
        "what works: split it into several smaller files and upload them separately, or trim large items before packing. **it was rejected before uploading, so nothing was uploaded in vain.**"
      );
    case "target_exists":
      return "the target file already exists. To overwrite it, pass overwrite=true; for another location, change path / dir.";
    case "target_unwritable":
      return (
        "cannot write to this target path (the directory does not exist, is not writable, or the path points to a directory).\n" +
        "note: here it is the worker subprocess writing, which is unrelated to the AppHost permitted roots — check whether the parent directory exists and is writable."
      );
    case "body_read_failed":
      return "the response body broke off midway (network interruption): the incomplete file on disk has been deleted, **it did not pretend to succeed**. You can retry.";
    case "download_truncated":
      return "the downloaded byte count does not match what the response declared (it was truncated): the incomplete file has been deleted, **it did not pretend to succeed**. You can retry.";
    default:
      return null;
  }
}

/** 字节 → 可读（二进制通道的报错文案用；与 release.js / ci.js 同口径）。 */
function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/**
 * 二进制通道**已支持**的能力边界（逐条可在源码里核对：worker 的白名单与 `buildBody` /
 * `streamToFile`）。
 *
 * 这不是「不可用」清单——它是「这条通道能做什么、边界在哪」，供各动作在回执里如实说明。
 * 报的是机制，不是免责声明。
 */
export const BINARY_CHANNEL_NOTES = [
  "request bodies can be binary: the worker accepts a `file` (local path) form, uses fs.createReadStream as the fetch body and sets Content-Length explicitly; the file never enters memory and chunked encoding is not used.",
  "response bodies can be binary: the worker accepts a `toFile` (local path) form and streams the response to disk, without UTF-8 decoding and without the 2MB bounded read.",
  "the host allowlist includes the upload endpoint uploads.github.com and the download-side redirect targets (release-assets.githubusercontent.com / objects.githubusercontent.com / results-receiver.actions.githubusercontent.com, plus the *.blob.core.windows.net suffix).",
  "the per-file limit is GitHub's hard limit (< 2 GiB); files above it are rejected **before the request is sent**, so nothing is uploaded in vain; there is no chunking and no resumable upload (GitHub's asset API has no such semantics — a retry means re-uploading).",
];

