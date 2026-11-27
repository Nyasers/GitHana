// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 设置页里「提交署名」的偏好（非机密）。
 *
 * 存在 <dataDir>/data.db 的 store 表（scope=settings, key=commit），只影响工具在
 * **没有显式传参时**的默认值：
 *   defaultVia       "local" | "api"
 *   coAuthors.local  本地提交默认的 Co-authored-by 组合
 *   coAuthors.api    API 提交默认的组合
 *
 * 工具调用里的 via / coAuthors 已不再接受（署名只由设置决定），这里就是唯一来源。
 * 记录缺失或损坏时回落内置默认，不让一次坏写把提交卡住。
 */
import { getSetting, setSetting } from "./db.js";

const KEY = "commit";

/** 与 tools/actions/git/commit.js 的署名取值一致。 */
const CREDIT_KEYS = ["user", "hanaagent", "githana-bot"];

/** 内置默认：本地只署 HanaAgent；API 提交把用户一并署上，不把用户挤出署名。 */
export const DEFAULT_COMMIT_PREFS = {
  defaultVia: "local",
  coAuthors: { local: ["hanaagent"], api: ["user", "hanaagent"] },
};

/** 只保留已知值：未知项丢弃，不做隐式转换。 */
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
 * @returns {{ defaultVia: "local"|"api", coAuthors: { local: string[], api: string[] } }}
 */
export function readCommitPrefs(dataDir) {
  const stored = getSetting(dataDir, KEY);
  const commit = stored && typeof stored === "object" ? stored : {};
  const co = commit.coAuthors && typeof commit.coAuthors === "object" ? commit.coAuthors : {};
  return {
    defaultVia: commit.defaultVia === "api" ? "api" : "local",
    coAuthors: {
      local: normalizeCoAuthors(co.local, DEFAULT_COMMIT_PREFS.coAuthors.local),
      api: normalizeCoAuthors(co.api, DEFAULT_COMMIT_PREFS.coAuthors.api),
    },
  };
}

/**
 * 写入提交偏好（整份替换）。返回写入后的值。
 * @throws Error 参数不合法或数据库写不进去时抛出可读错误。
 */
export function saveCommitPrefs(dataDir, patch = {}) {
  const current = readCommitPrefs(dataDir);
  const next = {
    defaultVia: current.defaultVia,
    coAuthors: { local: [...current.coAuthors.local], api: [...current.coAuthors.api] },
  };

  if (patch.defaultVia !== undefined) {
    if (patch.defaultVia !== "local" && patch.defaultVia !== "api") {
      throw new Error('defaultVia must be "local" or "api".');
    }
    next.defaultVia = patch.defaultVia;
  }
  if (patch.coAuthors !== undefined) {
    if (!patch.coAuthors || typeof patch.coAuthors !== "object" || Array.isArray(patch.coAuthors)) {
      throw new Error("coAuthors must be an object with local/api arrays.");
    }
    for (const via of ["local", "api"]) {
      if (patch.coAuthors[via] === undefined) continue;
      if (!Array.isArray(patch.coAuthors[via])) throw new Error("coAuthors." + via + " must be an array.");
      next.coAuthors[via] = normalizeCoAuthors(patch.coAuthors[via], next.coAuthors[via]);
    }
  }

  if (!dataDir) throw new Error("the app data directory is not available.");
  setSetting(dataDir, KEY, next);
  return next;
}
