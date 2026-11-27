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
 * `POST <url>/token`，换回 1 小时有效的 installation token。私钥永远不进客户端、不进仓库。
 *
 * 令牌只留在进程内 Map，按仓库缓存，过期前 5 分钟刷新；不落文件、不进日志、不进返回值。
 */
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../tools/lib/exec.js";
import { getToolSecretToken } from "../tools/lib/context.js";

/** installation token 缓存：`owner/repo` → { token, expiresAt, installationId }。 */
const tokenCache = new Map();

const TOKEN_FILE = "app-token.json";

/** 公共签发服务（零配置默认值）；self-host 用户在设置页覆盖。 */
export const DEFAULT_ISSUER_URL = "https://githana.nyase.ru";

/** bot 身份的兜底值（服务端 /identity 不可达时用）。 */
const FALLBACK_BOT = {
  login: "githana-app[bot]",
  name: "githana-app[bot]",
  email: "340878445+githana-app[bot]@users.noreply.github.com",
};

/** /identity 的进程内缓存：{ url, identity, expiresAt }。 */
let botCache = { url: "", identity: null, expiresAt: 0 };

/** <dataDir>/app-token.json：签发服务地址（非机密）。 */
export function tokenIssuerFilePath(dataDir) {
  return path.join(dataDir || "", TOKEN_FILE);
}

/**
 * 读签发服务地址。未配置时用公共默认值（零配置），返回 `isDefault` 供设置页区分。
 * 兼容旧记录 `{ mode: "http", url }` 与更早的 `{ mode: "ssh" | "local" }`（后者一律视为未配置）。
 * @returns {{ url: string, isDefault: boolean }}
 */
export function readTokenIssuer(dataDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(tokenIssuerFilePath(dataDir), "utf8"));
    if (rec && typeof rec.url === "string" && rec.url.trim()) {
      return { url: rec.url.trim().replace(/\/+$/, ""), isDefault: false, defaultUrl: DEFAULT_ISSUER_URL };
    }
  } catch {
    /* 未配置或损坏：用默认值 */
  }
  return { url: DEFAULT_ISSUER_URL, isDefault: true, defaultUrl: DEFAULT_ISSUER_URL };
}

/** 签发地址必须是 https；只有回环地址允许 http（令牌会以 Bearer 发出）。 */
function assertIssuerSecure(url) {
  const u = new URL(url);
  // URL.hostname 对 IPv6 保留方括号（"[::1]"），先拆掉再比。
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error("the token issuer must use https (plain http is only accepted for localhost): " + url);
  }
}

/** 写入签发服务地址（切换后清空 token 缓存，避免继续用旧来源的令牌）。 */
export function saveTokenIssuer(dataDir, { url } = {}) {
  const dir = dataDir || "";
  const u = String(url || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("the issuer URL is not a valid URL (expected https://host).");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("the issuer URL must use http or https.");
  assertIssuerSecure(u);
  fs.mkdirSync(dir, { recursive: true });
  const target = tokenIssuerFilePath(dir);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mode: "http", url: u }, null, 2), "utf8");
  fs.renameSync(tmp, target);
  tokenCache.clear();
  return { url: u };
}

/**
 * 向签发服务换 token：`POST <url>/token`，Bearer 用**用户自己的 GitHub 令牌**（本进程 OAuth
 * 登录缓存）。服务端用 `GET /user` 验证后再签发，无需额外共享 secret。
 * 请求走 curl（外部二进制，不受 AppHost 的 Node Permission Model 限制）；令牌经 stdin 的
 * curl 配置传入（-K -），不进 argv、不进进程列表。
 */
async function getTokenViaHttp({ url, owner, repo }) {
  assertIssuerSecure(url);
  const secret = getToolSecretToken();
  if (!secret) {
    throw new Error(
      "GitHub authorization is not complete yet (no OAuth token in this process): go to the GitHana settings page, click \"Sign in with GitHub\", and retry.",
    );
  }
  const config = 'header = "Authorization: Bearer ' + secret.replace(/["\\]/g, "\\$&") + '"\n';
  const body = JSON.stringify({ owner, repo });
  const r = await runCli(
    "curl",
    [
      "-sS", "-m", "25", "-K", "-", "-X", "POST", url + "/token",
      "-H", "Content-Type: application/json", "--data-binary", body,
      "-w", "\n%{http_code}",
    ],
    { input: config, timeoutSec: 40 },
  );
  if (!r.ok) {
    const raw = String(r.stderr || r.message || "").trim().split("\n").filter(Boolean);
    throw new Error("the token issuer " + url + " is unreachable: " + (raw[0] || "no output"));
  }
  const out = String(r.stdout || "").trimEnd();
  const cut = out.lastIndexOf("\n");
  const status = cut >= 0 ? Number(out.slice(cut + 1)) : 0;
  const text = cut >= 0 ? out.slice(0, cut) : out;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
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
export async function getInstallationToken({ dataDir, owner, repo }) {
  const cacheKey = owner + "/" + repo;
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - 300 > now) return hit;

  const issuer = readTokenIssuer(dataDir);
  const entry = await getTokenViaHttp({ url: issuer.url, owner, repo });
  const record = {
    token: entry.token,
    expiresAt: entry.expiresAt || now + 3300,
    installationId: entry.installationId,
    bot: entry.bot || null,
  };
  if (entry.bot) botCache = { url: issuer.url, identity: entry.bot, expiresAt: Date.now() + 3600_000 };
  tokenCache.set(cacheKey, record);
  return record;
}

/**
 * 取 bot 身份（login/name/email），用于 Co-authored-by 规范行。
 * 优先问服务端 `/identity`（self-host 时 app 不同，身份也不同）；不可达时用写死的 githana-app 身份。
 * @returns {Promise<{ login: string, name: string, email: string }>}
 */
export async function getBotIdentity(dataDir) {
  const issuer = readTokenIssuer(dataDir);
  const now = Date.now();
  if (botCache.identity && botCache.url === issuer.url && botCache.expiresAt > now) return botCache.identity;

  // 先看 token 缓存里有没有顺带带回来的 bot 信息。
  for (const record of tokenCache.values()) {
    if (record.bot && record.bot.email) {
      botCache = { url: issuer.url, identity: record.bot, expiresAt: now + 3600_000 };
      return record.bot;
    }
  }

  assertIssuerSecure(issuer.url);
  try {
    const r = await runCli("curl", ["-sS", "-m", "15", issuer.url + "/identity"], { timeoutSec: 20 });
    if (r.ok) {
      const j = JSON.parse(String(r.stdout || "{}"));
      if (j && j.login && j.email) {
        const identity = { login: String(j.login), name: String(j.name || j.login), email: String(j.email) };
        botCache = { url: issuer.url, identity, expiresAt: now + 3600_000 };
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
