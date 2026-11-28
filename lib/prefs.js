// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/prefs.js — 「谁来做这件事」的偏好（非机密）。
 *
 * 存在 data.db 的 store 表，key 为 identity。身份是主键，用途铺开：
 *
 *   user:  { commit, coAuthor, comment, pullRequest }
 *   app:   { commit, coAuthor, comment, pullRequest }
 *   agent: { coAuthor }                 —— HanaAgent 没有 GitHub 身份，只能署名
 *
 * 三个「只能一个身份」的场景（commit / comment / pullRequest）在保存时互斥，
 * coAuthor 是自由多选。读取方不需要关心矩阵形状，用下面的派生函数即可。
 */
import { getRecord, setRecord } from "./db.js";

const IDENTITIES = ["user", "app", "agent"];

/** 每个身份实际可用的场景：agent 只能以共同作者出现。 */
const SCENES = {
  user: ["commit", "coAuthor", "comment", "pullRequest"],
  app: ["commit", "coAuthor", "comment", "pullRequest"],
  agent: ["coAuthor"],
};

/** 同一场景只能由一个身份承担。 */
const EXCLUSIVE = ["commit", "comment", "pullRequest"];

/** 内置默认：用户提交、用户建 PR、App 评论；user 与 agent 作为共同作者。 */
export const DEFAULT_IDENTITY_PREFS = {
  user: { commit: true, coAuthor: true, comment: false, pullRequest: true },
  app: { commit: false, coAuthor: true, comment: true, pullRequest: false },
  agent: { coAuthor: true },
};

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 把任意输入整理成合法矩阵：
 * 缺项用默认补，互斥场景保证「恰好一个身份为真」。
 */
function normalize(raw) {
  const next = {};
  for (const who of IDENTITIES) {
    const src = raw && typeof raw === "object" && raw[who] && typeof raw[who] === "object" ? raw[who] : {};
    const fallback = DEFAULT_IDENTITY_PREFS[who];
    next[who] = {};
    for (const scene of SCENES[who]) next[who][scene] = asBool(src[scene], fallback[scene]);
  }

  // 互斥场景：都真 → 保留默认那一边；都假 → 回到默认。
  for (const scene of EXCLUSIVE) {
    const on = ["user", "app"].filter((who) => next[who][scene]);
    if (on.length === 1) continue;
    for (const who of ["user", "app"]) next[who][scene] = DEFAULT_IDENTITY_PREFS[who][scene];
  }
  return next;
}

/**
 * 读身份偏好。不抛：读不到就用内置默认。
 * @returns {{user: object, app: object, agent: object}}
 */
export function readIdentityPrefs(dataDir) {
  const stored = getRecord(dataDir, "identity");
  return normalize(stored);
}

/**
 * 保存身份偏好（可只给某个身份的部分场景）。返回整理后的矩阵。
 * @throws Error 参数不合法或数据库写不进去时抛出可读错误。
 */
export function saveIdentityPrefs(dataDir, patch = {}) {
  const current = readIdentityPrefs(dataDir);
  const merged = {};
  for (const who of IDENTITIES) {
    merged[who] = { ...current[who] };
    const incoming = patch && typeof patch === "object" ? patch[who] : null;
    if (!incoming || typeof incoming !== "object") continue;
    for (const scene of SCENES[who]) {
      if (incoming[scene] === undefined) continue;
      if (typeof incoming[scene] !== "boolean") {
        throw new Error("identity." + who + "." + scene + " must be a boolean.");
      }
      merged[who][scene] = incoming[scene];
    }
  }

  // 打开了某个互斥场景，另一个身份自动让位：调用方不需要自己保证互斥。
  for (const scene of EXCLUSIVE) {
    const turnedOn = ["user", "app"].filter((who) => {
      const incoming = patch && typeof patch === "object" ? patch[who] : null;
      return incoming && typeof incoming === "object" && incoming[scene] === true;
    });
    if (turnedOn.length !== 1) continue;
    const winner = turnedOn[0];
    for (const who of ["user", "app"]) if (who !== winner) merged[who][scene] = false;
  }

  const next = normalize(merged);
  if (!dataDir) throw new Error("the app data directory is not available.");
  setRecord(dataDir, "identity", next);
  return next;
}

/**
 * 派生视图：各处该用哪个身份。
 * @returns {{commitAuthor: "user"|"app", commentAuthor: "user"|"app", pullRequestAuthor: "user"|"app", coAuthors: string[]}}
 */
export function readIdentity(dataDir) {
  const prefs = readIdentityPrefs(dataDir);
  const coAuthors = IDENTITIES.filter((who) => prefs[who].coAuthor);
  return {
    commitAuthor: prefs.app.commit ? "app" : "user",
    commentAuthor: prefs.app.comment ? "app" : "user",
    pullRequestAuthor: prefs.app.pullRequest ? "app" : "user",
    coAuthors,
  };
}
