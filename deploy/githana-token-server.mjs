// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * deploy/githana-token-server.mjs — GitHub App installation token 的 HTTP 签发服务。
 *
 * 部署形态：podman 容器，私钥只读挂载进容器，默认只监听 127.0.0.1，外层由 Cloudflare
 * Tunnel 暴露成 HTTPS。容器里必须用 BIND_HOST=0.0.0.0 让端口发布可达，再由 `-p 127.0.0.1:8787:8787`
 * 把它收回宿主回环；裸机运行保持默认值即可。客户端拿自己的 GitHub 用户令牌调用 `POST /token`，
 * 换 1 小时有效的 installation token；私钥永远不出容器。
 *
 * 环境变量：
 *   ALLOWED_LOGINS  可选，逗号分隔的 GitHub 登录名白名单（不设则允许任何有效令牌）
 *   ALLOWED_OWNERS  可选，逗号分隔的仓库 owner 白名单（不设则不限制，由 App 安装范围兜底）
 *   REQUIRE_PUSH    默认 true：签发前用用户令牌校验他对目标仓库有 push 权限
 *   BOT_LOGIN / BOT_NAME / BOT_EMAIL  可选，bot 身份（默认 githana-app[bot] 与它的 noreply 邮箱）
 *   APP_KEY_FILE    私钥路径（默认 /key/privkey.pem）
 *   GITHUB_APP_ID   App id（默认 5271075）
 *   REDIRECT_URL    未匹配路径的 302 目标（默认 https://github.com/Nyasers/GitHana）
 *   PORT            监听端口（默认 8787）
 *   BIND_HOST       监听地址（默认 127.0.0.1；容器内设为 0.0.0.0，由 -p 绑定收回回环）
 *
 * 认证：客户端用**自己的 GitHub 用户令牌**（GitHana 已经通过 OAuth 登录拿到的那个）调
 * `POST /token`；服务端用 `GET /user` 验证令牌真实性，再用同一令牌核对他对目标仓库的
 * push 权限。任何能把 `githana-app` 装到自己仓库、并有写权限的人都能用，不需要共享 secret。
 *
 * 端点：
 *   GET  /health  -> { ok: true }
 *   POST /token   -> { token, expires_at, installation_id, permissions, repository_selection }
 *                    body: { owner, repo }；Authorization: Bearer <GitHub user token>
 *
 * 不记录 token 与 secret；请求体限 4KB；全局限流 120 次/分钟。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const APP_ID = process.env.GITHUB_APP_ID || "5271075";
const KEY_FILE = process.env.APP_KEY_FILE || "/key/privkey.pem";
const ALLOWED_LOGINS = (process.env.ALLOWED_LOGINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_OWNERS = (process.env.ALLOWED_OWNERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const REQUIRE_PUSH = process.env.REQUIRE_PUSH !== "false";
const PORT = Number(process.env.PORT || 8787);
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const REDIRECT_URL = process.env.REDIRECT_URL || "https://github.com/Nyasers/GitHana";

/** bot 身份（同时也是 CoA 的规范行）。 */
const BOT_LOGIN = process.env.BOT_LOGIN || "githana-app[bot]";
const BOT_NAME = process.env.BOT_NAME || BOT_LOGIN;
const BOT_EMAIL = process.env.BOT_EMAIL || "340878445+githana-app[bot]@users.noreply.github.com";

if (ALLOWED_LOGINS.length === 0 && ALLOWED_OWNERS.length === 0) {
  console.log("no ALLOWED_LOGINS / ALLOWED_OWNERS configured: any valid GitHub user with push access can request a token");
}

/** 用户令牌验证缓存：sha256(token) → { login, expiresAt }。 */
const loginCache = new Map();
const LOGIN_CACHE_MS = 5 * 60_000;

let privateKey;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE, "utf8"));
} catch (e) {
  console.error("cannot load the App private key at " + KEY_FILE + ": " + String((e && e.message) || e));
  process.exit(1);
}
if (privateKey.asymmetricKeyType !== "rsa") {
  console.error("the App private key must be an RSA key");
  process.exit(1);
}

const tokenCache = new Map();
let windowStart = Date.now();
let windowCount = 0;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }));
  const data = header + "." + payload;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(data), privateKey);
  return data + "." + b64url(signature);
}

/**
 * 用 GitHub 验证用户令牌并取 login。结果缓存 5 分钟，避免同一个令牌每次换 token 都调一次。
 * @returns {Promise<string|null>} login（小写）或 null
 */
async function verifyUserToken(token) {
  const now = Date.now();
  // 顺手清过期项：令牌轮换后旧条目不该无限堆积。
  for (const [k, v] of loginCache) if (v.expiresAt <= now) loginCache.delete(k);
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = loginCache.get(key);
  if (hit && hit.expiresAt > now) return hit.login;
  const res = await github("/user", { token });
  if (!res.ok || !res.body || !res.body.login) return null;
  const login = String(res.body.login).toLowerCase();
  loginCache.set(key, { login, expiresAt: Date.now() + LOGIN_CACHE_MS });
  return login;
}

async function github(path, { method = "GET", token, json } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "User-Agent": "githana-token-issuer",
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function issueToken(owner, repo) {
  const key = (owner + "/" + repo).toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - 300 > now) return hit;

  const jwt = createJwt();
  const inst = await github("/repos/" + owner + "/" + repo + "/installation", { token: jwt });
  if (!inst.ok) {
    const err = new Error(
      inst.status === 404
        ? "the App is not installed on " + owner + "/" + repo
        : "installation lookup failed (HTTP " + inst.status + "): " + String((inst.body && inst.body.message) || inst.body || ""),
    );
    err.status = inst.status === 404 ? 404 : 502;
    throw err;
  }
  const installationId = inst.body && inst.body.id;
  if (!installationId) {
    const err = new Error("GitHub returned no installation id");
    err.status = 502;
    throw err;
  }

  // 把 installation token 的范围收窄到目标仓库：即使 App 安装在账号的 all repositories 上，
  // 这张 token 也只能操作这一个仓库，消除“协作者拿到 token 就能动其他仓库”的权限放大。
  const tok = await github("/app/installations/" + installationId + "/access_tokens", {
    method: "POST",
    token: jwt,
    // 只申请这个服务真正用到的权限：不限的话 GitHub 会把 App 被授予的全部权限都放进这张 token。
    // workflows / actions 是给「改 CI 配置」与「手动触发流水线」用的——GitHana 会代改
    // `.github/workflows/`（user token 改不了那里，它没有 workflow scope）并向要 actions: write。
    // 代价说清楚：这两格让 token 能改变仓库的构建与发布流程，虽然仍只限于这一个仓库。
    json: {
      repositories: [repo],
      permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
        workflows: "write",
        actions: "write",
      },
    },
  });
  if (!tok.ok || !tok.body || !tok.body.token) {
    const err = new Error(
      "creating an installation token failed (HTTP " + tok.status + "): " + String((tok.body && tok.body.message) || ""),
    );
    err.status = 502;
    throw err;
  }

  const record = {
    token: String(tok.body.token),
    expires_at: tok.body.expires_at,
    installation_id: installationId,
    permissions: tok.body.permissions || null,
    repository_selection: tok.body.repository_selection || null,
  };
  const expiresAt = tok.body.expires_at ? Math.floor(Date.parse(tok.body.expires_at) / 1000) : now + 3300;
  tokenCache.set(key, { ...record, expiresAt });
  return { ...record, expiresAt };
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    // 请求处理里的漏网异常不能带崩进程：签发服务挂了，所有客户端的 bot 提交跟着挂。
    if (!res.headersSent) json(res, 500, { error: "internal error" });
    else {
      try {
        res.destroy();
      } catch {
        /* 已经断开 */
      }
    }
    console.error("token issuer: unhandled request failure: " + String((e && e.message) || e));
  });
});

async function handleRequest(req, res) {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    return json(res, 200, { ok: true });
  }
  // bot 身份是公开信息（不等于凭据），客户端本地提交写 CoA 时需要。
  if (req.method === "GET" && req.url === "/identity") {
    return json(res, 200, { login: BOT_LOGIN, name: BOT_NAME, email: BOT_EMAIL, app_id: APP_ID });
  }
  // 其余路径不暴露服务形状：直接 302 到仓库页（公网扫路径时看到的就是个项目地址）。
  // 302 目标固定，给一个短缓存：边缘节点可以直接回这个跳转，不必每次都回源。
  if (req.url !== "/token") {
    res.writeHead(302, {
      Location: REDIRECT_URL,
      "Cache-Control": "public, max-age=300",
    });
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "method not allowed" });
  }

  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return json(res, 401, { error: "unauthorized" });
  }
  const userToken = auth.slice(7).trim();
  let login = null;
  try {
    login = await verifyUserToken(userToken);
  } catch {
    login = null;
  }
  if (!login) return json(res, 401, { error: "unauthorized" });
  if (ALLOWED_LOGINS.length && !ALLOWED_LOGINS.includes(login)) {
    return json(res, 403, { error: "login not allowed" });
  }

  // 全局固定窗口限流：这个服务只服务少量客户端，超出就是有人在猜 secret。
  const now = Date.now();
  if (now - windowStart > RATE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  if (windowCount > RATE_LIMIT) return json(res, 429, { error: "rate limited" });

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) {
      // 先回响应再关请求：反过来 destroy 会让 res 的写入失败（客户端只看到连接被重置）。
      json(res, 413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return json(res, 400, { error: "invalid json" });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { error: "owner and repo are required" });
  }
  const owner = String(body.owner || "").trim();
  const repo = String(body.repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return json(res, 400, { error: "owner and repo are required" });
  }
  if (ALLOWED_OWNERS.length && !ALLOWED_OWNERS.includes(owner.toLowerCase())) {
    return json(res, 403, { error: "owner not allowed" });
  }

  // 用同一张用户令牌校验他对目标仓库有 push 权限：拒绝“登录了但并不是该仓库协作者”的请求。
  // installation token 的权限是 App 安装范围，比单个仓库大，这一步是必要的收口。
  if (REQUIRE_PUSH) {
    const perm = await github("/repos/" + owner + "/" + repo, { token: userToken });
    if (!perm.ok) {
      return json(res, perm.status === 404 ? 404 : 403, { error: "cannot access repository" });
    }
    if (!(perm.body && perm.body.permissions && perm.body.permissions.push === true)) {
      return json(res, 403, { error: "no push permission on this repository" });
    }
  }

  try {
    const record = await issueToken(owner, repo);
    return json(res, 200, {
      token: record.token,
      expires_at: record.expires_at,
      installation_id: record.installation_id,
      permissions: record.permissions,
      repository_selection: record.repository_selection,
      bot: { login: BOT_LOGIN, name: BOT_NAME, email: BOT_EMAIL },
    });
  } catch (e) {
    return json(res, e.status || 502, { error: String((e && e.message) || e) });
  }
}

server.listen(PORT, BIND_HOST, () => {
  console.log(
    "githana token issuer listening on " + BIND_HOST + ":" + PORT +
      " (app " + APP_ID + ", owners: " + (ALLOWED_OWNERS.length ? ALLOWED_OWNERS.join(",") : "any") +
      ", push check: " + REQUIRE_PUSH + ")",
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
