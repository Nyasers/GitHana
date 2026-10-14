// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/transfer.js — 二进制资产的现状（不可用，及原因）与本地文件读取的统一处理。
 *
 * ## 二进制通道不存在（三条硬限制，逐条在这里写清，供各动作如实回报）
 *
 *   1. **载荷是 JSON，不是 multipart**。tools/lib/rest.js 把 `{ token, requests: [...] }` 一行
 *      JSON 写进 worker 的 stdin，每个请求只能带 `json` / `form`（urlencoded）/ `body`
 *      （**字符串**）。二进制放进 JSON 只剩 base64 一条形态，而 worker 不会把它解回字节——
 *      body 到 fetch 时按普通字符串走，非 UTF-8 字节当场被改写。手拼 multipart 也不成立：
 *      分隔符之间的原始字节同样过不去这条字符串通道。
 *   2. **主机不在出站白名单**。上传端点是 `POST https://uploads.github.com/...`，而 worker 的
 *      `ALLOWED_HOSTS` 只有 `api.github.com` 与 `github.com` → 起始请求即被拒
 *      （「拒绝请求：uploads.github.com 不在允许的主机」）。下载侧正好相反：release 资产与
 *      Actions 日志/产物都会 302 到 `objects.githubusercontent.com` /
 *      `release-assets.githubusercontent.com` / `*.blob.core.windows.net`，而 `REDIRECT_HOSTS`
 *      只比白名单多一个 `codeload.github.com`。
 *   3. **响应体按 UTF-8 有界读取**。worker 的 `readBounded` 上限 2MB，且把字节
 *      `Buffer.concat(...).toString("utf8")` —— 即使主机放行，二进制也会被破坏并截断。
 *
 * 结论：`release` 的 upload / download 与 `run` 的 download，**网络那一半**本期不可用；
 * `githana_api` 不是逃生门——它走同一条 worker、同一份主机白名单。补这条通道要动 worker 的
 * 协议与白名单。
 *
 * ## 本地文件
 *
 * tools/lib/exec.js 的 `checkCwd` 遇到 ERR_ACCESS_DENIED 是**放行**的，因为那个路径最终交给
 * git 子进程——外部命令不继承 Node 权限模型，能自由访问任意目录。本地文件读取没有这条退路：
 * 读只能在本进程里做，而 AppHost 的许可根只有安装目录（只读）与 dataDir。所以这里直接读、
 * 被拒时给**点名的可读错误**（明确说这不是「文件不存在」），不把路径塞给子进程去绕——
 * 没有哪个子进程能替我们算 sha256。
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
    "无法" + what + "本地文件 " + p + "：AppHost 的 Node 权限模型只放行两个许可根（" +
    (roots.length ? roots.join(" / ") : "安装目录 / App 数据目录") +
    "），根之外的裸 fs 读写被运行时拒绝（ERR_ACCESS_DENIED）。\n" +
    "这不是「文件不存在」——文件在磁盘上可能好好的，只是本进程无权碰它。\n" +
    "可行做法：把文件放到 App 数据目录（" + dir + "）下再重试。"
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
  if (!raw) return { error: what + "必填（本地文件的绝对路径）。" };
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
      if (code === "ERR_ACCESS_DENIED" || code === "EPERM") return resolve({ error: deniedMessage(p, "读取") });
      return resolve({ error: what + "读取失败（" + String(code || "未知") + "）：" + String((e && e.message) || e) + "。" });
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
      if (code === "ERR_ACCESS_DENIED" || code === "EPERM") return done({ error: deniedMessage(p, "读取") });
      if (code === "ENOENT" || code === "ENOTDIR") return done({ error: what + "不存在：" + p + "。" });
      if (code === "EISDIR") return done({ error: what + "指向的是目录，不是文件：" + p + "。" });
      done({ error: what + "读取失败（" + String(code || "未知") + "）：" + String((e && e.message) || e) + "。" });
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

/** 二进制通道不可用的三条硬限制（逐条可用于核对）。 */
export const BINARY_CHANNEL_LIMITS = [
  "载荷是 JSON 报文（不是 multipart）：rest.worker.mjs 从 stdin 读一行 JSON，请求只能带 json / form / body 字符串；二进制进不去，worker 也不把 base64 解回字节。",
  "主机不在出站白名单：上传端点 uploads.github.com 不在 ALLOWED_HOSTS（只有 api.github.com / github.com）；下载侧 302 到 objects.githubusercontent.com 等，也不在 REDIRECT_HOSTS。",
  "响应体按 UTF-8 有界读取：readBounded 上限 2MB 并 toString(\"utf8\")，即使主机放行，二进制也会被破坏。",
];

/** 三条限制的排版块（保留位文案与各动作的错误文案共用）。 */
export function binaryUnavailableText() {
  return BINARY_CHANNEL_LIMITS.map((l) => "  · " + l).join("\n");
}

