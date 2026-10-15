// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/repo.js — githana_repo 各动词共用的渲染与路径拼接。
 *
 * 只放**真正共用**的部分：contents 端点的地址拼接（read-dir / read-file 共用）与目录项、
 * 体积、仓库元数据的渲染。每个动词自己那份请求编排留在 tools/actions/repo/<verb>.js。
 *
 * 仓库上下文解析在 tools/lib/gh.js（跨名词共用），这里不重复一份。
 */
import { apiUrl } from "./rest.js";
import { fmtTime } from "./gh.js";

/** 文本类返回值的展示上限（字符）：正文类内容超过它只截断展示，不改变已取到的数据。 */
export const TEXT_MAX = 20000;

/**
 * `GET /repos/{o}/{r}/contents/<path>` 的地址。
 *
 * 路径**逐段**编码：整串 encodeURIComponent 会把分隔用的 `/` 也编掉，而只编码空格等字符要
 * 逐段做才不误伤分隔符。ref 走查询串。
 *
 * @param {string} repo owner/repo
 * @param {string} filePath 仓库内相对路径（空串 = 仓库根）
 * @param {string} [ref] 分支 / 标签 / 提交 SHA
 */
export function contentsUrl(repo, filePath, ref) {
  const clean = String(filePath || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const suffix = clean === "" ? "" : "/" + clean.split("/").map(encodeURIComponent).join("/");
  const base = apiUrl(repo, "/contents" + suffix);
  return ref ? base + "?ref=" + encodeURIComponent(ref) : base;
}

/** 字节数 → 可读（contents 端点给的是字节）。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}

/** 目录项一行：类型标记 + 名字 + 体积（目录没有体积）。 */
export function entryLine(entry) {
  const type = String((entry && entry.type) || "?");
  const name = String((entry && entry.name) || "?");
  const mark = type === "dir" ? "[dir] " : type === "file" ? "[file]" : "[" + type + "]";
  const size = type === "file" && entry && entry.size !== undefined ? "  " + formatBytes(entry.size) : "";
  return "  " + mark + " " + name + size;
}

/** 把 base64 正文解成 UTF-8 文本；含 NUL 视为二进制（返回 null）。 */
export function decodeText(base64) {
  let buf;
  try {
    buf = Buffer.from(String(base64 || "").replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

/** 仓库元数据速览（view / create / fork 共用同一份渲染口径）。 */
export function repoSummary(json) {
  const r = json && typeof json === "object" ? json : {};
  const out = [];
  out.push("仓库：" + (r.full_name || "?") + (r.private ? "（私有 private）" : "（公开 public）"));
  if (r.description) out.push("简介：" + r.description);
  out.push("默认分支：" + (r.default_branch || "?" ) + " · 可见性：" + (r.visibility || (r.private ? "private" : "public")));
  const stats = [];
  if (r.stargazers_count !== undefined) stats.push("star " + r.stargazers_count);
  if (r.forks_count !== undefined) stats.push("fork " + r.forks_count);
  if (r.open_issues_count !== undefined) stats.push("打开 issue/PR " + r.open_issues_count);
  if (r.language) stats.push("主语言 " + r.language);
  if (r.size !== undefined) stats.push("体积 " + formatBytes(Number(r.size) * 1024));
  if (stats.length) out.push("规模：" + stats.join(" · "));
  const flags = [];
  if (r.fork) flags.push("是 fork");
  if (r.archived) flags.push("已归档 archived");
  if (r.disabled) flags.push("已停用 disabled");
  if (r.allow_forking === false) flags.push("不允许 fork");
  if (flags.length) out.push("标记：" + flags.join(" · "));
  if (r.parent && r.parent.full_name) out.push("上游：" + r.parent.full_name);
  if (r.license && (r.license.spdx_id || r.license.name)) {
    out.push("许可：" + (r.license.spdx_id || "") + " " + (r.license.name || ""));
  }
  if (r.created_at) out.push("创建于：" + fmtTime(r.created_at));
  if (r.pushed_at) out.push("最后推送：" + fmtTime(r.pushed_at));
  if (r.html_url) out.push("URL：" + r.html_url);
  return out;
}
