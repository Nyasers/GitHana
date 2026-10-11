// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/oauth.js — GitHub App device flow 授权与令牌保活（服务端）。
 *
 * ## 为什么走 `gh api` 而不是 App 自己的网络
 *
 * `gh api` 接受完整 URL 并支持 `--method POST`，可直连 github.com 的 OAuth 端点
 * （注意不是 api.github.com）。因此本模块不需要 `network` 声明、不需要新能力，
 * 沿用清单里已授予的 `app/process.spawn` 即可。
 *
 * 两条实测约束：
 *   1. 必须加 `-H "Accept: application/json"`，否则端点回 form-encoded；
 *   2. 这两个端点无需认证，调用时传 `omitToken: true`（不必把令牌送到非 API 端点）。
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
import { runCli } from "../tools/lib/exec.js";
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
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** 剩余有效期低于这个值就刷新（AC5：不足 5 分钟自动换新） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** device/code 的兜底值（端点未回时用；正常都能拿到） */
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRES_IN_SEC = 900;

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
 * 从 runCli 结果里抠出 JSON 对象。
 * `gh api` 对 4xx 会写 stderr 并非零退出，所以两个通道都要看；OAuth 端点有时把错误
 * 包在 200 里，有时是 4xx，两种都得能解析。
 */
function extractJson(r) {
  for (const channel of [r && r.stdout, r && r.stderr]) {
    const s = String(channel || "").trim();
    if (!s) continue;
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
  }
  return null;
}

/** 命令输出合成可读诊断（不含令牌）。 */
function outputText(r) {
  return [r && r.stdout, r && r.stderr].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
}

/** OAuth 错误码 → 中文可读提示（透出 GitHub 原文，不吞）。 */
function oauthErrorMessage(code, description) {
  const desc = description ? `（GitHub：${description}）` : "";
  switch (code) {
    case "device_flow_disabled":
      return `GitHub App 未启用 Device Flow，请到 App 设置页开启后重试：${APP_SETTINGS_URL}${desc}`;
    case "incorrect_client_credentials":
      return `Client ID 无效（GitHub 拒绝了这个 client_id），请在设置页核对后重试。${desc}`;
    case "incorrect_device_code":
      return `device code 无效或已被使用，请重新发起授权。${desc}`;
    case "access_denied":
      return `你拒绝了本次授权。如属误操作，点「用 GitHub 登录」重新发起。${desc}`;
    case "expired_token":
      return `授权已超时（device code 过期），请重新发起授权。${desc}`;
    case "unsupported_grant_type":
      return `GitHub 不接受该 grant_type，请确认 App 的 Device Flow 已启用。${desc}`;
    case "bad_refresh_token":
    case "expired":
      return `refresh_token 已失效（超 6 个月或授权被撤销），需重新授权。${desc}`;
    default:
      return `GitHub 返回错误 ${code || "unknown"}${desc}`;
  }
}

/** 调一个 github.com 的 OAuth 端点（非 API 端点，omitToken）。 */
async function postOAuthEndpoint(url, fields) {
  const args = ["api", "--method", "POST", url, "-H", "Accept: application/json"];
  for (const [k, v] of Object.entries(fields)) {
    args.push("-f", `${k}=${v}`);
  }
  return runCli("gh", args, { timeoutSec: 30, omitToken: true });
}

/** 读 GitHub 用户 { id, login, name }（该端点不需要任何权限）。 */
async function fetchUser() {
  const r = await runCli("gh", ["api", "user"], { timeoutSec: 30 });
  if (!r.ok) return null;
  const user = extractJson(r);
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
 * @param {{ clientId?: string, dataDir?: string }} args
 * @returns {Promise<{ flowId: string, userCode: string, verificationUri: string, interval: number, expiresIn: number }>}
 *   失败抛 Error（中文可读）；clientId 非法抛 Error（路由映射成 400）。
 */
export async function startDeviceFlow({ clientId, dataDir } = {}) {
  const dir = dataDir || getToolDataDir();
  const id = String(clientId === undefined || clientId === null ? "" : clientId).trim();
  if (!id) {
    throw new Error("Client ID 为空：请先在设置页填写 GitHub App 的 Client ID（可留空使用内置默认值）。");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Client ID 格式不合法：应为字母/数字/连字符/下划线组成的字符串（如 Iv23li0dA1IaFVs6klAc）。");
  }

  const r = await postOAuthEndpoint(DEVICE_CODE_URL, { client_id: id });
  const data = extractJson(r);
  if (!data) {
    throw new Error(
      "调用 GitHub device/code 端点失败（无 JSON 响应）：" +
        (outputText(r) || (r && r.message) || "未知错误"),
    );
  }
  if (data.error) {
    throw new Error(oauthErrorMessage(String(data.error), data.error_description));
  }
  const deviceCode = String(data.device_code || "");
  const userCode = String(data.user_code || "");
  if (!deviceCode || !userCode) {
    throw new Error("GitHub 返回的 device/code 响应缺少 device_code / user_code，请稍后重试。");
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

  const r = await postOAuthEndpoint(ACCESS_TOKEN_URL, {
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
        "调用 GitHub access_token 端点失败（无 JSON 响应）：" +
        (outputText(r) || (r && r.message) || "未知错误"),
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
      message: "GitHub 未返回 access_token，请重新发起授权。",
    };
  }

  // 先落盘（写密文 + 把令牌放进进程缓存），这样紧接着的 gh api user 才有 GH_TOKEN 可用。
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
      message: "授权成功但凭据写入失败：" + String((e && e.message) || e),
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

/** 退出授权：清凭据（clientId 覆盖值另存 oauth.json，保留）。 */
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
 *     client_id 已不可用，唯一出路是重新授权 —— 打 `needsReauth` 并清进程内令牌（不再注入 GH_TOKEN）。
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

    const r = await postOAuthEndpoint(ACCESS_TOKEN_URL, {
      client_id: cred.meta.clientId || readClientId(dir),
      grant_type: "refresh_token",
      refresh_token: cred.refreshToken,
    });
    const data = extractJson(r);
    if (!data) {
      return {
        ok: false,
        reason: "transport_error",
        message: outputText(r) || (r && r.message) || "未知错误",
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
      return { ok: false, reason: "no_token", message: "GitHub 未返回新的 access_token。" };
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
