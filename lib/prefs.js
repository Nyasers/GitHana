// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 「谁来做这件事」的偏好（非机密）。
 *
 * 存在 data.db 的 author 表：主键就是身份，用途摊在各列上。
 *
 *   author   TEXT PRIMARY KEY   user / app / agent
 *   commit   INTEGER            谁是这个提交的作者
 *   coa      INTEGER            是否作为共同作者（可多行同时为 1）
 *   comment  INTEGER            评论、回复、resolve 用谁的名义
 *   pr       INTEGER            谁创建拉取请求
 *
 * commit / comment / pr 是「单选列」：整列恰好一行为 1，写入端保证。
 * agent 没有 GitHub 身份，只能出现在 coa 列（建表时有 CHECK 约束）。
 *
 * 对外的读取视图仍是扁平的 { commit, coa[], comment, pr }，消费方不需要关心表形状。
 */
import { readAuthorRows, writeAuthorRows } from "./db.js";

const IDENTITIES = ["user", "app"];

const CREDITS = ["user", "app", "agent"];

/** 内置默认：用户提交、用户建 PR、App 评论；user 与 agent 作为共同作者。 */
export const DEFAULT_AUTHOR_PREFS = {
  commit: "user",
  coa: ["user", "agent"],
  comment: "app",
  pr: "user",
};

/** 三个单选列（表里名为 commit_author：commit 是 SQL 关键字）。 */
const CHOICES = ["commit", "comment", "pr"];

/** 视图名 → 表列名。 */
const COLUMN = { commit: "commit_author", comment: "comment", pr: "pr" };

/** 把表行读成扁平视图；单选列缺失或不唯一时回落到默认。 */
function toView(rows) {
  const pick = (key) => {
    const col = COLUMN[key];
    const on = rows.filter((r) => Number(r[col]) === 1 && IDENTITIES.includes(r.author));
    return on.length === 1 ? on[0].author : DEFAULT_AUTHOR_PREFS[key];
  };
  const coa = CREDITS.filter((who) => rows.some((r) => r.author === who && Number(r.coa) === 1));
  return {
    commit: pick("commit"),
    coa: coa.length ? coa : [...DEFAULT_AUTHOR_PREFS.coa],
    comment: pick("comment"),
    pr: pick("pr"),
  };
}

/**
 * 读署名偏好。不抛：读不到就用内置默认。
 * @returns {{commit: "user"|"app", coa: string[], comment: "user"|"app", pr: "user"|"app"}}
 */
export function readAuthorPrefs(dataDir) {
  const rows = readAuthorRows(dataDir);
  if (!rows || rows.length === 0) return { ...DEFAULT_AUTHOR_PREFS, coa: [...DEFAULT_AUTHOR_PREFS.coa] };
  return toView(rows);
}

/**
 * 保存署名偏好（可只给其中几项）。返回整理后的扁平视图。
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
    const picked = new Set(
      src.coa.map((v) => String(v ?? "").trim().toLowerCase()).filter((v) => CREDITS.includes(v)),
    );
    next.coa = CREDITS.filter((who) => picked.has(who));
  }

  if (!dataDir) throw new Error("the app data directory is not available.");

  const rows = CREDITS.map((author) => ({
    author,
    commit_author: author === next.commit ? 1 : 0,
    coa: next.coa.includes(author) ? 1 : 0,
    comment: author === next.comment ? 1 : 0,
    pr: author === next.pr ? 1 : 0,
  }));
  writeAuthorRows(dataDir, rows);
  return next;
}
