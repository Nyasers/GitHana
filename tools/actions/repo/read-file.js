// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/read-file：读远端仓库里某个文件的内容（githana_repo 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/contents/<path>`（支撑权限 `contents: read`），文件形态回一个对象，
 * `content` 是 base64、`encoding` 是 "base64"。本动词解出 UTF-8 文本。
 *
 * 两条如实回报、不伪造的边界：
 *   · **大文件**：contents 端点对约 1MB 以上的文件不返回正文（`content` 为空）。这时明确说
 *     「用 raw / blob 端点取」，而不是给一个空正文假装文件是空的。
 *   · **二进制**：解出来的字节含 NUL 就只报体积与 sha，不吐乱码。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { contentsUrl, decodeText, formatBytes, TEXT_MAX } from "../../lib/repo.js";

export const command = "read-file";
export const summary = "读远端仓库某文件的内容";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  path: z.string().describe("必填：仓库内文件路径（相对仓库根，如 README.md / src/app.js）"),
  ref: z.string().optional().describe("可选：分支 / 标签 / 提交 SHA（缺省取默认分支）"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const path = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (!path) return label + " 参数错误：path 必填（仓库内文件路径，相对仓库根）。";
  const ref = input?.ref !== undefined && input?.ref !== null ? String(input.ref).trim() : "";
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const r = await callRest([{ url: contentsUrl(repo, path, ref), timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return (
        label + "：文件不存在或令牌不可见（" + repoLabel + " · " + path + (ref ? " · ref=" + ref : "") + "）。\n" +
        "GitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  // contents 端点：文件回对象，目录回数组。收到数组说明 path 指到了目录，给引导。
  if (Array.isArray(res.json)) {
    return (
      label + "：path 指向的是一个**目录**，不是文件（" + path + "）。\n" +
      "要看它的内容请用 githana_repo(action=\"read-dir\", path=\"" + path + "\"" + (ref ? ", ref=\"" + ref + "\"" : "") + ")。"
    );
  }

  const f = res.json && typeof res.json === "object" ? res.json : {};
  const size = Number.isFinite(Number(f.size)) ? Number(f.size) : null;
  const head =
    label + "（" + repoLabel + " · " + (f.path || path) + (ref ? " · ref=" + ref : "") + "）：";
  const meta = [
    "类型：" + (f.type || "?") + (size !== null ? " · 体积 " + formatBytes(size) : ""),
    f.sha ? "blob sha：" + f.sha : "",
    f.html_url ? "URL：" + f.html_url : "",
  ].filter(Boolean);

  // 大文件：contents 端点不给正文（content 为空且 encoding 也不是 base64）。
  const rawContent = f.content !== undefined && f.content !== null ? String(f.content) : "";
  if (rawContent.trim() === "") {
    // raw 形态的地址：`{owner}` / `{repo}` 占位符由 githana_api 自己替换，这里只给可直接粘的片段。
    const rawPath =
      "/repos/{owner}/{repo}/contents/" + path.split("/").map(encodeURIComponent).join("/") +
      (ref ? "?ref=" + encodeURIComponent(ref) : "");
    return [
      head,
      ...meta.map((m) => "  " + m),
      "正文未随响应返回：GitHub 的 contents 端点对约 1MB 以上的文件不内联正文（也可能这是特殊条目）。",
      "取正文走 githana_api（原始字节，自行处理编码）：",
      "  githana_api(path=\"" + rawPath + "\", repo=\"" + repo + "\")",
    ].join("\n");
  }

  const text = decodeText(rawContent);
  if (text === null) {
    return [
      head,
      ...meta.map((m) => "  " + m),
      "这是二进制文件（解出的字节含 NUL）：正文不在这里展示，避免吐乱码。",
      "要原始内容请走 githana_api 取 raw。",
    ].join("\n");
  }

  const truncated = text.length > TEXT_MAX;
  const out = [head, ...meta.map((m) => "  " + m), ""];
  out.push("—— 正文" + (truncated ? "（截断，共 " + text.length + " 字符）" : "（" + text.length + " 字符）") + " ——");
  out.push(truncated ? text.slice(0, TEXT_MAX) + "\n…（截断）" : text);
  return out.join("\n");
}
