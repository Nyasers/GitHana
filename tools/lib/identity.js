// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/identity.js — 提交者身份推导纯函数。
 *
 * 身份来源：`gh api user` → { id, login, name }（该端点不需要任何权限）。
 * 提交邮箱用 GitHub 官方 noreply 格式 {id}+{login}@users.noreply.github.com；
 * 提交者名字走三级推导链（见 deriveNameFromUser）：
 *
 *   显式 name 参数 → gh api user 的 name 字段 → login
 *
 * 例：login = ProjectNyaser、name = Nyaser → 隔离 gitconfig 写 user.name = Nyaser，
 * 邮箱仍是 {id}+{login}@users.noreply.github.com。
 *
 * 调用点只有两处，且都走本文件的同一组函数（避免两处逻辑跑偏）：
 *   - tools/gpg-keygen.js（生成/轮换密钥时写隔离 gitconfig）
 *   - lib/routes/actions.js 的 /actions/identity（设置页「读取身份」）
 *
 * 插件不配置邮箱/名字（拒绝多余配置键），keygen 时自动推导；keygen 的 email/name 参数可显式覆盖。
 */

/**
 * 由 GitHub 用户 {id, login} 推导 noreply 提交邮箱（GitHub 官方格式）。
 * @param {number|string} id 用户数字 id（gh api user → user.id）
 * @param {string} login 用户名（gh api user → user.login）
 * @returns {string} {id}+{login}@users.noreply.github.com
 */
export function noreplyEmailFromUser(id, login) {
  return String(id) + "+" + String(login) + "@users.noreply.github.com";
}

/**
 * 由 login 推导提交者名字：login 原样（如 ProjectNyaser）。
 * 三级推导链的最后一级兜底。
 * @param {string} login
 * @returns {string}
 */
export function deriveNameFromLogin(login) {
  return String(login || "").trim();
}

/**
 * 由 gh api user 的响应推导提交者名字（三级链的第二级）。
 * name 字段为空/纯空白时回落 deriveNameFromLogin(login)。
 * @param {{ id?: number|string, login?: string, name?: string } | null | undefined} user
 * @returns {string}
 */
export function deriveNameFromUser(user) {
  const name = user && typeof user.name === "string" ? user.name.trim() : "";
  if (name) return name;
  return deriveNameFromLogin(user && user.login);
}

/**
 * 由邮箱推导提交者名字（显式 email 参数时兜底用）：
 * - noreply 邮箱（{id}+{login}@users.noreply.github.com）→ 取 + 与 @ 之间段（ProjectNyaser）；
 * - 普通邮箱 → 取 @ 前段；
 * - 解析不出返回 ""。
 * @param {string} email
 * @returns {string}
 */
export function deriveNameFromEmail(email) {
  const e = String(email || "").trim();
  if (!e) return "";
  const at = e.indexOf("@");
  if (at <= 0) return "";
  const local = e.slice(0, at);
  const plus = local.lastIndexOf("+");
  const cand = plus >= 0 ? local.slice(plus + 1) : local;
  return cand || "";
}
