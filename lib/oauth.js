// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/oauth.js — GitHub App device flow 授权与令牌保活（服务端）。
 *
 * ## 为什么走自写 REST 通道而不是 gh CLI
 *
 * device flow 的两个端点在 `github.com`（不是 `api.github.com`），且**不校验 Authorization**，
 * 所以不需要任何额外能力：走已授予的 `app/process.spawn` 起 REST worker 即可（见
 * tools/lib/rest.js 与 tools/lib/rest.worker.mjs）。
 *
 * 两条实测约束：
 *   1. 必须带 `Accept: application/json`，否则端点回 form-encoded；
 *   2. 这两个端点不校验 Authorization，但仍需要一个非空值才肯走通（GitHub 侧对空 Authorization
 *      的响应形态不一致），所以给一个固定占位值（bin.js 的 inertToken 语义）。
 *      占位值是常量、不是凭据，真令牌仍不出这道门。
 *
 * ## 轮询由页面驱动，服务端只做单次查询
 *
 * 不在服务端起长循环：App 进程生命周期不稳定，长任务还会撞宿主回调超时。所以
 *   POST /actions/oauth/start → 调 device/code，`device_code` 存模块级 Map（key = flowId），
 *                               只把 user_code / verification_uri / interval / expires_in 回给页面；
 *   GET  /actions/oauth/poll  → 调一次 access_token，返回 pending / ready / error。
 * `device_code` 不出服务端；flow 状态在内存，进程重启即失效（页面拿到 404 后提示重发）。
 *
 * ## 刷新不需要 client_secret
 *
 * device flow 签发的令牌用 `grant_type=refresh_token` 换新，不带 client_secret。刷新走
 * `ensureFresh()`（挂在 tools/lib/context.js 的 initToolContext 上，每次工具/路由调用都跑），
 * 单飞避免并发工具调用同时消费同一个 refresh_token。刷新失败 → 打 `needsReauth` 并清掉
 * 进程内令牌；**不降级**到其它凭据（也没有其它凭据），后续 gh 调用会如实报未登录。
 *
 * ## 敏感材料
 *
 * access_token / refresh_token 只在进程缓存与加密文件之间流转：不进日志、不进设置页回显、
 * 不进对话流。日志只记状态（pending / ready / 错误码）。
 */
import crypto from "node:crypto";
import { callRest, webUrl, INERT_REST_TOKEN } from "../tools/lib/rest.js";
import {
  getToolDataDir,
  getToolSecretToken,
  getToolOAuthMeta,
  setToolSecretToken,
  setToolOAuthMeta,
} from "../tools/lib/context.js";
import {
  readCredential,
  saveCredential,
  updateCredentialMeta,
  clearSecret,
  readClientId,
} from "./secret.js";
/** device flow 端点（github.com，不是 api.github.com） */
const DEVICE_CODE_PATH = "/login/device/code";
const ACCESS_TOKEN_PATH = "/login/oauth/access_token";

/** 剩余有效期低于这个值就刷新（AC5：不足 5 分钟自动换新） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** device/code 的兜底值（端点未回时用；正常都能拿到） */
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRES_IN_SEC = 900;

/**
 * device/code 的请求上限。
 *
 * 它是一串交互动作的第一屏：用户点了「登录」就在等按钮变状态，所以给它比一般 REST
 * 更短的上限（每次 15s，连接失败最多 3 次尝试，外层 20s），让「网络不通」在半分钟内变成
 * 一句可读的话，而不是一个一直转圈的按钮。REST 缺省的 30s × 3 次会把这段拖到近两分钟。
 *
 * 两个数分工不同：`timeoutMs` 是**单次**尝试的时限（worker 侧 `AbortSignal.timeout`），
 * `timeoutSec` 是**整批**的封顶（App 侧到点 kill worker，它不知道里面在重试）。重试次数
 * 由 worker 的 `CONNECT_RETRIES = 2` 决定（attempt 0/1/2，共 3 次），不在这里配。
 */
const DEVICE_CODE_TIMEOUT_MS = 15_000;
const DEVICE_CODE_TIMEOUT_SEC = 20;

/** `slow_down` 时下次轮询间隔的增量（GitHub 要求） */
const SLOW_DOWN_STEP_SEC = 5;

/** App 权限设置页（403 / device_flow_disabled 的引导指向）。 */
const APP_SETTINGS_URL = "https://github.com/organizations/Nyasers/settings/apps/githana-app";

/**
 * 待完成 flow：flowId → { deviceCode, interval, expiresAt, clientId }。
 * `device_code` 只存在这里，不回给页面。
 */
const flows = new Map();

/** 刷新单飞：并发调用共享同一个 Promise，避免同一 refresh_token 被并发消费。 */
let refreshInflight = null;

// ───────────────────────────── 输出解析 ─────────────────────────────

/**
 * 从 REST 结果里抠出 JSON 对象。
 * OAuth 端点有时把错误包在 200 里，有时是 4xx；两种都得能解析，且文本兜底。
 */
function extractJson(r) {
  if (r && r.json && typeof r.json === "object") return r.json;
  const s = String((r && r.text) || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* 不是纯 JSON：往下找片段 */
  }
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {
      /* 片段也不是 JSON */
    }
  }
  return null;
}

/** 命令输出合成可读诊断（不含令牌）。 */
function outputText(r) {
  return String((r && r.text) || "").trim() || String((r && r.error) || "").trim();
}

/**
 * 带 code 的错误：路由层据此给不同的 HTTP 状态，页面据此给不同的下一步。
 * 不吞 GitHub 原文，code 只是让上层能分类。
 */
function oauthFailure(code, message) {
  const e = new Error(message);
  e.code = String(code || "oauth_error");
  return e;
}

/** OAuth 错误码 → 中文可读提示（透出 GitHub 原文，不吞）。 */
function oauthErrorMessage(code, description) {
  const desc = description ? ` (GitHub: ${description})` : "";
  switch (code) {
    case "device_flow_disabled":
      return `Device Flow is not enabled for the GitHub App; enable it on the App settings page and retry: ${APP_SETTINGS_URL}${desc}`;
    case "incorrect_client_credentials":
      return `Invalid Client ID (GitHub rejected this client_id); check it on the settings page and retry.${desc}`;
    case "incorrect_device_code":
      return `Invalid or already-used device code; start the authorization again.${desc}`;
    case "access_denied":
      return `You denied this authorization. If that was a mistake, click "Sign in with GitHub" to start again.${desc}`;
    case "expired_token":
      return `Authorization timed out (the device code expired); start the authorization again.${desc}`;
    case "unsupported_grant_type":
      return `GitHub does not accept this grant_type; make sure Device Flow is enabled for the App.${desc}`;
    case "bad_refresh_token":
    case "expired":
      return `The refresh_token is no longer valid (older than 6 months or the authorization was revoked); re-authorize.${desc}`;
    default:
      return `GitHub returned error ${code || "unknown"}${desc}`;
  }
}

/**
 * 调一个 github.com 的 OAuth 端点。
 *
 * 用固定占位值而不是真令牌：这两个端点不校验 Authorization，但需要一个非空值走通。
 * 占位值是常量、不是凭据，真令牌仍不出这道门。
 */
async function postOAuthEndpoint(path, fields, { timeoutMs = 30_000, timeoutSec = 30 } = {}) {
  const r = await callRest(
    [
      {
        method: "POST",
        url: webUrl(path),
        form: fields,
        headers: { Accept: "application/json" },
        auth: true,
        timeoutMs,
      },
    ],
    { token: INERT_REST_TOKEN, timeoutSec },
  );
  if (!r.ok) {
    return { ok: false, status: null, json: null, text: "", error: r.message };
  }
  return r.results[0] || { ok: false, status: null, json: null, text: "", error: "no result" };
}

/** 读 GitHub 用户 { id, login, name }（该端点不需要任何权限）。 */
async function fetchUser() {
  const r = await callRest([{ url: "https://api.github.com/user", timeoutMs: 30_000 }], { timeoutSec: 30 });
  if (!r.ok) return null;
  const res = r.results[0];
  if (!res || !res.ok) return null;
  const user = res.json;
  if (!user || !user.login) return null;
  return {
    id: user.id === undefined || user.id === null ? null : user.id,
    login: String(user.login),
    name: user.name ? String(user.name) : "",
  };
}

/** 当前时刻 ISO（秒级精度足够，且比毫秒可读）。 */
function isoFromNow(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 1000).toISOString();
}

// ─────────────────────────── device flow ───────────────────────────

/** 清理过期 flow（内存里的待完成授权不该无限堆积）。 */
function pruneFlows() {
  const now = Date.now();
  for (const [id, f] of flows) {
    if (f.expiresAt <= now) flows.delete(id);
  }
}

/**
 * 发起 device flow：向 GitHub 要一组设备码，把 device_code 留在服务端。
 *
 * Client ID 用本 App 注册的那一个（lib/secret.js 的常量），不接受入参：
 * 改它只会让登录指向别的 GitHub App，而权限与发布链路都绑在注册的那个上。
 *
 * @param {{ dataDir?: string }} args
 * @returns {Promise<{ flowId: string, userCode: string, verificationUri: string, interval: number, expiresIn: number }>}
 *   失败抛 Error（中文可读）。
 */
export async function startDeviceFlow({ dataDir } = {}) {
  const dir = dataDir || getToolDataDir();
  const id = readClientId();
  if (!id) {
    throw new Error("Client ID is not configured: this App has no registered Client ID, so sign-in cannot be started.");
  }

  const r = await postOAuthEndpoint(
    DEVICE_CODE_PATH,
    { client_id: id },
    { timeoutMs: DEVICE_CODE_TIMEOUT_MS, timeoutSec: DEVICE_CODE_TIMEOUT_SEC },
  );
  const data = extractJson(r);
  if (!data) {
    const text = outputText(r);
    // 超时与「端点回了非 JSON」对调用方是两件事：前者是网络/代理，后者是 GitHub 侧异常。
    // 页面据 code 给出不同的下一步，所以这里区分开，不糊成一句。
    //
    // 两种超时形态都得认（都是实测形态）：
    //   · 外层封顶：REST worker 整体被 kill，文案是 "GitHub REST call timed out (20s)"；
    //   · 内层连接：undici 自己的 connect timeout，文案是 "Connect Timeout Error ..."。
    const timedOut = /timed out|connect timeout/i.test(text);
    throw oauthFailure(
      timedOut ? "timeout" : "transport_error",
      timedOut
        ? "connecting to github.com timed out (" +
            DEVICE_CODE_TIMEOUT_MS / 1000 +
            "s): the device-code request never reached GitHub."
        : "calling the GitHub device/code endpoint failed (no JSON response): " + (text || "unknown error"),
    );
  }
  if (data.error) {
    throw oauthFailure(String(data.error), oauthErrorMessage(String(data.error), data.error_description));
  }
  const deviceCode = String(data.device_code || "");
  const userCode = String(data.user_code || "");
  if (!deviceCode || !userCode) {
    throw oauthFailure(
      "bad_response",
      "the device/code response from GitHub is missing device_code / user_code; retry shortly.",
    );
  }

  const interval = Number(data.interval) > 0 ? Number(data.interval) : DEFAULT_INTERVAL_SEC;
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_EXPIRES_IN_SEC;
  pruneFlows();
  const flowId = crypto.randomUUID();
  flows.set(flowId, {
    deviceCode,
    interval,
    expiresAt: Date.now() + expiresIn * 1000,
    clientId: id,
    dataDir: dir,
  });

  return {
    flowId,
    userCode,
    verificationUri: String(data.verification_uri || "https://github.com/login/device"),
    interval,
    expiresIn,
  };
}

/**
 * 查询一次授权结果。页面按 interval 自轮询，拿到 ready / error 即停。
 *
 * @returns {Promise<
 *   { status: "not_found" } |
 *   { status: "pending", interval: number } |
 *   { status: "ready", login: string, name: string } |
 *   { status: "error", code: string, message: string }>}
 */
export async function pollDeviceFlow(flowId) {
  const key = String(flowId || "");
  const flow = flows.get(key);
  if (!flow) return { status: "not_found" };
  if (flow.expiresAt <= Date.now()) {
    flows.delete(key);
    return { status: "error", code: "expired_token", message: oauthErrorMessage("expired_token") };
  }

  const r = await postOAuthEndpoint(ACCESS_TOKEN_PATH, {
    client_id: flow.clientId,
    device_code: flow.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const data = extractJson(r);
  if (!data) {
    return {
      status: "error",
      code: "transport_error",
      message:
        "calling the GitHub access_token endpoint failed (no JSON response): " + (outputText(r) || "unknown error"),
    };
  }

  const code = data.error ? String(data.error) : "";
  if (code === "authorization_pending") {
    return { status: "pending", interval: flow.interval };
  }
  if (code === "slow_down") {
    // 轮询过快：按 GitHub 要求加长间隔（下次轮询由页面按新 interval 发起）。
    flow.interval += SLOW_DOWN_STEP_SEC;
    return { status: "pending", interval: flow.interval };
  }
  if (code) {
    // expired_token / access_denied / device_flow_disabled …：流程终结，清掉待完成项。
    flows.delete(key);
    return { status: "error", code, message: oauthErrorMessage(code, data.error_description) };
  }

  const token = String(data.access_token || "");
  if (!token) {
    flows.delete(key);
    return {
      status: "error",
      code: "no_token",
      message: "GitHub did not return an access_token; start the authorization again.",
    };
  }

  // 先落盘（写密文 + 把令牌放进进程缓存），这样紧接着的 /user 请求才有令牌可用。
  const meta = {
    clientId: flow.clientId,
    expiresAt: isoFromNow(data.expires_in),
    refreshExpiresAt: isoFromNow(data.refresh_token_expires_in),
    authorizedAt: new Date().toISOString(),
  };
  try {
    await saveCredential({
      dataDir: flow.dataDir,
      token,
      refreshToken: String(data.refresh_token || ""),
      meta,
    });
  } catch (e) {
    flows.delete(key);
    return {
      status: "error",
      code: "save_failed",
      message: "authorization succeeded but writing the credential failed: " + String((e && e.message) || e),
    };
  }
  flows.delete(key);

  // 取账号信息写进 meta（非机密；设置页显示 @login 用）。失败不影响授权本身。
  const user = await fetchUser();
  if (user) {
    updateCredentialMeta(flow.dataDir, { login: user.login, name: user.name || user.login });
  }
  return { status: "ready", login: user ? user.login : "", name: user ? user.name || user.login : "" };
}

/** 退出授权：清凭据。 */
export async function revokeOAuth({ dataDir } = {}) {
  const dir = dataDir || getToolDataDir();
  flows.clear();
  await clearSecret({ dataDir: dir });
  return { ok: true };
}

// ───────────────────────────── 令牌保活 ─────────────────────────────

/**
 * 用 refresh_token 换新令牌。单飞：并发调用共享同一个 Promise。
 *
 * 失败分两类，处置不同：
 *   - 终结性（`bad_refresh_token` / `expired` / `incorrect_client_credentials`）：refresh_token 或
 *     client_id 已不可用，唯一出路是重新授权 —— 打 `needsReauth` 并清进程内令牌（后续请求不再带凭据）。
 *   - 非终结性（其它 `data.error`、传输层失败）：refresh_token 本身可能仍有效，**不动凭据与 meta**，
 *     只把失败如实回报。下一次工具调用会再试，避免一次瞬时故障就把用户赶去重新授权。
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function refreshAccessToken({ dataDir } = {}) {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    const dir = dataDir || getToolDataDir();
    const cred = await readCredential(dir);
    if (!cred) return { ok: false, reason: "no_credential" };
    if (!cred.refreshToken) return { ok: false, reason: "no_refresh_token" };

    const r = await postOAuthEndpoint(ACCESS_TOKEN_PATH, {
      client_id: readClientId(),
      grant_type: "refresh_token",
      refresh_token: cred.refreshToken,
    });
    const data = extractJson(r);
    if (!data) {
      return {
        ok: false,
        reason: "transport_error",
        message: outputText(r) || "unknown error",
      };
    }
    if (data.error) {
      const code = String(data.error);
      const message = oauthErrorMessage(code, data.error_description);
      // 只有这些错误码说明 refresh_token / client_id 已不可用，必须重新授权。
      // 其余错误（如 GitHub 侧瞬时故障）不动凭据：refresh_token 可能仍然有效，
      // 贸然打 needsReauth 会让用户白白重走一次授权。
      const terminal = code === "bad_refresh_token" || code === "expired" || code === "incorrect_client_credentials";
      if (terminal) {
        updateCredentialMeta(dir, { needsReauth: true });
        setToolSecretToken("");
        const next = { ...(getToolOAuthMeta() || {}), needsReauth: true };
        setToolOAuthMeta(next);
      }
      return { ok: false, reason: code, terminal, message };
    }
    const token = String(data.access_token || "");
    if (!token) {
      return { ok: false, reason: "no_token", message: "GitHub did not return a new access_token." };
    }

    const meta = {
      ...cred.meta,
      expiresAt: isoFromNow(data.expires_in),
      refreshExpiresAt: isoFromNow(data.refresh_token_expires_in) || cred.meta.refreshExpiresAt || null,
      refreshedAt: new Date().toISOString(),
      needsReauth: false,
    };
    await saveCredential({
      dataDir: dir,
      token,
      // GitHub 在 refresh 响应里给新 refresh_token；极少数情况不回则沿用旧的。
      refreshToken: String(data.refresh_token || cred.refreshToken),
      meta,
    });
    return { ok: true };
  })();
  try {
    return await refreshInflight;
  } finally {
    refreshInflight = null;
  }
}

/**
 * 令牌保活检查：挂在 initToolContext 上，每次工具/路由调用都跑。
 * 只在「有 OAuth 凭据」且「expiresAt - now < 5 分钟」时才真正发请求；其余情况立刻返回。
 * 永不抛出（刷新失败不该阻断工具调用本身）。
 *
 * @returns {Promise<{ checked: boolean, refreshed?: boolean, reason?: string }>}
 */
export async function ensureFresh() {
  try {
    const dir = getToolDataDir();
    if (!dir) return { checked: false, reason: "no_data_dir" };
    const meta = getToolOAuthMeta();
    if (!meta) return { checked: false, reason: "no_credential" };
    if (meta.needsReauth === true) return { checked: false, reason: "needs_reauth" };
    if (!getToolSecretToken()) return { checked: false, reason: "no_token" };
    if (!meta.expiresAt) return { checked: false, reason: "no_expiry" };

    const expiresAt = Date.parse(String(meta.expiresAt));
    if (!Number.isFinite(expiresAt)) return { checked: false, reason: "bad_expiry" };
    if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return { checked: true, refreshed: false };

    const r = await refreshAccessToken({ dataDir: dir });
    return { checked: true, refreshed: r.ok === true, reason: r.ok ? undefined : r.reason };
  } catch {
    // 网络中断 / 后端异常：按「本次没刷成」处理，不阻断工具调用。
    return { checked: true, refreshed: false, reason: "exception" };
  }
}

/** 仅供测试/诊断：清空内存里的待完成 flow。 */
export function _resetFlows() {
  flows.clear();
}
