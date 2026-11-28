// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/app-auth.js — 通过服务器签发 installation token，以 GitHana App 身份调用 GitHub API。
 *
 * 为什么要这一层：要产出 **Verified 的 bot 提交**，只能由 GitHub 在「请求认证为 App/bot」
 * 时用 web-flow 密钥代签（官方文档：Signature verification for bots will only work if the
 * request is verified and authenticated as the GitHub App or bot and contains no custom author /
 * committer / signature information）。用户 OAuth 令牌做不到这一点，于是需要 installation token。
 *
 * 私钥只放在服务器上（deploy/githana-token-server.mjs）：客户端用已登录的 GitHub 用户令牌调
 * `POST <ISSUER_URL>/token`，换回 1 小时有效的 installation token。私钥永远不进客户端、不进仓库。
 *
 * 令牌只留在进程内 Map，按仓库缓存，过期前 5 分钟刷新；不落文件、不进日志、不进返回值。
 */
import { callRest } from "../tools/lib/rest.js";
import crypto from "node:crypto";
import { getToolSecretToken } from "../tools/lib/context.js";

/** installation token 缓存：`凭据指纹|owner/repo` → { token, expiresAt, installationId }。 */
const tokenCache = new Map();

/** 当前凭据的指纹：缓存按它分桶，换账号后不会接着用上一张 installation token。 */
function credentialKey() {
  const secret = String(getToolSecretToken() || "");
  if (!secret) return "anonymous";
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * 公共签发服务地址。写死：客户端没有改地址的入口，自建服务需要改这里并重新打包
 * （部署见 deploy/README.md）。地址必须是 https，因此不再需要运行期协商。
 */
export const ISSUER_URL = "https://githana.nyase.ru";
if (!ISSUER_URL.startsWith("https://")) {
  throw new Error("ISSUER_URL must be https: " + ISSUER_URL);
}

/** bot 身份的兜底值（服务端 /identity 不可达时用）。 */
const FALLBACK_BOT = {
  login: "githana-app[bot]",
  name: "githana-app[bot]",
  email: "340878445+githana-app[bot]@users.noreply.github.com",
};

/** /identity 的进程内缓存。 */
let botCache = { identity: null, expiresAt: 0 };

/**
 * 向签发服务换 token：`POST <ISSUER_URL>/token`，Bearer 用**用户自己的 GitHub 令牌**（本进程 OAuth
 * 登录缓存）。服务端用 `GET /user` 验证后再签发，无需额外共享 secret。
 * 请求走 Node 原生 REST 通道（tools/lib/rest.js 的 callRest → 随包 rest.worker.mjs 子进程）。
 * AppHost 开了 Node Permission Model，进程内 fetch 的 DNS 会被拒（getaddrinfo ERR_ACCESS_DENIED），
 * 只有补了 `--allow-net` 的 worker 子进程能联网。令牌经 callRest 的 token 参数交给 worker 的
 * stdin，不进 argv、不进进程列表。
 */
async function getTokenViaHttp({ owner, repo }) {
  const url = ISSUER_URL;
  const secret = getToolSecretToken();
  if (!secret) {
    throw new Error(
      "GitHub authorization is not complete yet (no OAuth token in this process): go to the GitHana settings page, click \"Sign in with GitHub\", and retry.",
    );
  }
  const r = await callRest(
    [{ method: "POST", url: url + "/token", json: { owner, repo }, timeoutMs: 25_000 }],
    { token: secret, timeoutSec: 30 },
  );
  if (!r.ok) {
    throw new Error("the token issuer " + url + " is unreachable: " + String(r.message || "no output"));
  }
  const res = r.results[0];
  const status = res && typeof res.status === "number" ? res.status : null;
  if (!res || status === null) {
    // 连接层失败（DNS / 连接被拒 / 超时）：没有 HTTP 状态可报，按「不可达」处理。
    const raw = String((res && res.error) || "").trim().split("\n").filter(Boolean);
    throw new Error("the token issuer " + url + " is unreachable: " + (raw[0] || "no output"));
  }
  const text = String(res.text || "").trim();
  let payload = res.json;
  if (payload === null || typeof payload !== "object") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error("the token issuer returned no JSON (first 200 chars): " + text.slice(0, 200));
  }
  if (status < 200 || status >= 300) {
    throw new Error("the token issuer refused (HTTP " + status + "): " + String((payload && payload.error) || text.slice(0, 200)));
  }
  if (!payload.token) throw new Error("the token issuer returned no token.");
  return {
    token: String(payload.token),
    expiresAt: payload.expires_at ? Math.floor(Date.parse(payload.expires_at) / 1000) || 0 : 0,
    installationId: payload.installation_id || null,
    bot: payload.bot && payload.bot.email ? payload.bot : null,
  };
}

/**
 * 取某个仓库的 installation token。
 *
 * @param {{ dataDir: string, owner: string, repo: string }} args
 * @returns {Promise<{ token: string, expiresAt: number, installationId: number|null }>}
 */
export async function getInstallationToken({ owner, repo }) {
  const cacheKey = credentialKey() + "|" + owner + "/" + repo;
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - 300 > now) return hit;

  const entry = await getTokenViaHttp({ owner, repo });
  const record = {
    token: entry.token,
    expiresAt: entry.expiresAt || now + 3300,
    installationId: entry.installationId,
    bot: entry.bot || null,
  };
  if (entry.bot) botCache = { identity: entry.bot, expiresAt: Date.now() + 3600_000 };
  tokenCache.set(cacheKey, record);
  return record;
}

/**
 * 取 bot 身份（login/name/email），用于 Co-authored-by 规范行。
 * 优先问服务端 `/identity`（自建 App 时身份不同）；不可达时用写死的 githana-app 身份。
 * @returns {Promise<{ login: string, name: string, email: string }>}
 */
export async function getBotIdentity() {
  const now = Date.now();
  if (botCache.identity && botCache.expiresAt > now) return botCache.identity;

  // 先看 token 缓存里有没有顺带带回来的 bot 信息。
  for (const record of tokenCache.values()) {
    if (record.bot && record.bot.email) {
      botCache = { identity: record.bot, expiresAt: now + 3600_000 };
      return record.bot;
    }
  }

  try {
    const r = await callRest([{ url: ISSUER_URL + "/identity", timeoutMs: 15_000 }], { token: "", timeoutSec: 20 });
    if (r.ok && r.results[0] && r.results[0].ok) {
      const j = r.results[0].json;
      if (j && j.login && j.email) {
        const identity = { login: String(j.login), name: String(j.name || j.login), email: String(j.email) };
        botCache = { identity, expiresAt: now + 3600_000 };
        return identity;
      }
    }
  } catch {
    /* 回退到写死身份 */
  }
  return FALLBACK_BOT;
}

/** 清空 installation token 缓存（凭据变更时用）。 */
export function clearInstallationTokenCache() {
  tokenCache.clear();
}
