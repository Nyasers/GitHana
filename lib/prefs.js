// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 「谁来做这件事」的偏好（非机密）。
 *
 * 存在 data.db 的 settings 表里，key 就是 author —— 这也是它在这一层的身份：
 *
 *   author → {
 *     commit:  "user" | "app"           谁是这个提交的作者
 *     coa:     ["user"|"app"|"agent"]   共同作者，按固定顺序
 *     comment: "user" | "app"           评论、回复、resolve 用谁的名义
 *     pr:      "user" | "app"           谁创建拉取请求
 *   }
 *
 * commit / comment / pr 各自只能是一个身份；coa 是自由多选。agent（HanaAgent）
 * 没有 GitHub 身份，只能出现在 coa 里。
 */
import { getRecord, setRecord } from "./db.js";

const STORE_KEY = "author";

const IDENTITIES = ["user", "app"];

const CREDITS = ["user", "app", "agent"];

const CHOICES = ["commit", "comment", "pr"];

/** 内置默认：用户提交、用户建 PR、App 评论；user 与 agent 作为共同作者。 */
export const DEFAULT_AUTHOR_PREFS = {
  commit: "user",
  coa: ["user", "agent"],
  comment: "app",
  pr: "user",
};

function asIdentity(value, fallback) {
  const v = String(value ?? "").trim().toLowerCase();
  return IDENTITIES.includes(v) ? v : fallback;
}

/** 只保留已知署名、去重、按固定顺序排好；未知项丢弃。 */
function asCredits(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const picked = new Set();
  for (const raw of value) {
    const key = String(raw ?? "").trim().toLowerCase();
    if (CREDITS.includes(key)) picked.add(key);
  }
  return CREDITS.filter((k) => picked.has(k));
}

function normalize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    commit: asIdentity(src.commit, DEFAULT_AUTHOR_PREFS.commit),
    coa: asCredits(src.coa, DEFAULT_AUTHOR_PREFS.coa),
    comment: asIdentity(src.comment, DEFAULT_AUTHOR_PREFS.comment),
    pr: asIdentity(src.pr, DEFAULT_AUTHOR_PREFS.pr),
  };
}

/**
 * 读署名偏好。不抛：读不到就用内置默认。
 * @returns {{commit: "user"|"app", coa: string[], comment: "user"|"app", pr: "user"|"app"}}
 */
export function readAuthorPrefs(dataDir) {
  return normalize(getRecord(dataDir, STORE_KEY));
}

/**
 * 保存署名偏好（可只给其中几项）。返回整理后的值。
 * @throws Error 参数不合法或数据库写不进去时抛出可读错误。
 */
export function saveAuthorPrefs(dataDir, patch = {}) {
  const current = readAuthorPrefs(dataDir);
  const src = patch && typeof patch === "object" ? patch : {};
  const next = { ...current, coa: [...current.coa] };

  for (const key of CHOICES) {
    if (src[key] === undefined) continue;
    if (!IDENTITIES.includes(src[key])) throw new Error(key + ' must be "user" or "app".');
    next[key] = src[key];
  }
  if (src.coa !== undefined) {
    if (!Array.isArray(src.coa)) throw new Error("coa must be an array.");
    next.coa = asCredits(src.coa, next.coa);
  }

  if (!dataDir) throw new Error("the app data directory is not available.");
  setRecord(dataDir, STORE_KEY, next);
  return next;
}
