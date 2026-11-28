// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 设置页里「提交署名」的偏好（非机密）。
 *
 * 存在 data.db 的 store 表，key 为 commit：
 *
 *   author         "user" | "app"                 谁是这个提交的作者
 *   coAuthors      ["user" | "app" | "agent"]   共同作者，按固定顺序排列
 *   commentAuthor  "user" | "app"                 评论、回复、resolve 以谁的身份发出
 *
 * commentAuthor 默认 app：工具发的评论是对外可见的陈述，不是用户本人说的话。
 *
 * 三者的内部实体 key 仍是 user / hanaagent / githana-bot，这里用对外的
 * 名字（app、agent）保存，读的地方自己映射。
 */
import { getRecord, setRecord } from "./db.js";

const AUTHOR_KEYS = ["user", "app"];

/** 与 tools/actions/git/commit.js 的署名取值一一对应。 */
const CREDIT_KEYS = ["user", "app", "agent"];

/** 内置默认：用户提交，署用户与 Agent；作者那项按自署规则自动去掉。 */
export const DEFAULT_COMMIT_PREFS = {
  author: "user",
  coAuthors: ["user", "agent"],
  commentAuthor: "app",
};

/** 只保留已知值、按固定顺序排好；未知项丢弃，不做隐式转换。 */
function normalizeCoAuthors(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const picked = new Set();
  for (const raw of value) {
    const key = String(raw ?? "").trim().toLowerCase();
    if (CREDIT_KEYS.includes(key)) picked.add(key);
  }
  return CREDIT_KEYS.filter((k) => picked.has(k));
}

/**
 * 读提交偏好。不抛：读不到就用内置默认。
 * @returns {{ author: "user"|"app", coAuthors: string[] }}
 */
export function readCommitPrefs(dataDir) {
  const stored = getRecord(dataDir, "commit");
  const commit = stored && typeof stored === "object" ? stored : {};
  return {
    author: AUTHOR_KEYS.includes(commit.author) ? commit.author : DEFAULT_COMMIT_PREFS.author,
    coAuthors: normalizeCoAuthors(commit.coAuthors, DEFAULT_COMMIT_PREFS.coAuthors),
    commentAuthor: AUTHOR_KEYS.includes(commit.commentAuthor) ? commit.commentAuthor : DEFAULT_COMMIT_PREFS.commentAuthor,
  };
}

/**
 * 写入提交偏好。返回写入后的值。
 * @throws Error 参数不合法或数据库写不进去时抛出可读错误。
 */
export function saveCommitPrefs(dataDir, patch = {}) {
  const current = readCommitPrefs(dataDir);
  const next = {
    author: current.author,
    coAuthors: [...current.coAuthors],
    commentAuthor: current.commentAuthor,
  };

  if (patch.author !== undefined) {
    if (!AUTHOR_KEYS.includes(patch.author)) {
      throw new Error('author must be "user" or "app".');
    }
    next.author = patch.author;
  }
  if (patch.coAuthors !== undefined) {
    if (!Array.isArray(patch.coAuthors)) throw new Error("coAuthors must be an array.");
    next.coAuthors = normalizeCoAuthors(patch.coAuthors, next.coAuthors);
  }
  if (patch.commentAuthor !== undefined) {
    if (!AUTHOR_KEYS.includes(patch.commentAuthor)) {
      throw new Error('commentAuthor must be "user" or "app".');
    }
    next.commentAuthor = patch.commentAuthor;
  }

  if (!dataDir) throw new Error("the app data directory is not available.");
  setRecord(dataDir, "commit", {
    author: next.author,
    coAuthors: next.coAuthors,
    commentAuthor: next.commentAuthor,
  });
  return next;
}
