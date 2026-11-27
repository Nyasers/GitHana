// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 设置页里「提交署名」的偏好（非机密）。
 *
 * 存在 data.db：commit_settings（通道）+ commit_co_authors（署名集合）。
 *
 *   defaultVia   "local" | "api"
 *   coAuthors    一套署名组合，两种通道共用
 *
 * 只存一套的理由：本地提交的作者就是用户，用户那一项会被自署规则去掉，于是
 * ["user","hanaagent"] 在本地落到 [hanaagent]、在 App bot 通道落到 [user, hanaagent]，
 * 正好是各自该有的组合。按通道存两份只会让两边的设定漂移。
 */
import { getCommitSettings, setCommitSettings } from "./db.js";

/** 与 tools/actions/git/commit.js 的署名取值一致。 */
const CREDIT_KEYS = ["user", "hanaagent", "githana-bot"];

/** 内置默认：署用户与 HanaAgent；本地提交时用户那项按自署规则自动去掉。 */
export const DEFAULT_COMMIT_PREFS = {
  defaultVia: "local",
  coAuthors: ["user", "hanaagent"],
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
 * @returns {{ defaultVia: "local"|"api", coAuthors: string[] }}
 */
export function readCommitPrefs(dataDir) {
  const stored = getCommitSettings(dataDir);
  const commit = stored && typeof stored === "object" ? stored : {};
  return {
    defaultVia: commit.defaultVia === "api" ? "api" : "local",
    coAuthors: normalizeCoAuthors(commit.credits, DEFAULT_COMMIT_PREFS.coAuthors),
  };
}

/**
 * 写入提交偏好。返回写入后的值。
 * @throws Error 参数不合法或数据库写不进去时抛出可读错误。
 */
export function saveCommitPrefs(dataDir, patch = {}) {
  const current = readCommitPrefs(dataDir);
  const next = { defaultVia: current.defaultVia, coAuthors: [...current.coAuthors] };

  if (patch.defaultVia !== undefined) {
    if (patch.defaultVia !== "local" && patch.defaultVia !== "api") {
      throw new Error('defaultVia must be "local" or "api".');
    }
    next.defaultVia = patch.defaultVia;
  }
  if (patch.coAuthors !== undefined) {
    if (!Array.isArray(patch.coAuthors)) throw new Error("coAuthors must be an array.");
    next.coAuthors = normalizeCoAuthors(patch.coAuthors, next.coAuthors);
  }

  if (!dataDir) throw new Error("the app data directory is not available.");
  setCommitSettings(dataDir, { defaultVia: next.defaultVia, credits: next.coAuthors });
  return next;
}
