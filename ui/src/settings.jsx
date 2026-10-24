// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * ui/src/settings.jsx — GitHana 设置页（React，复用宿主组件）。
 *
 * 用 @hana/app-sdk/components 里的宿主组件搭页面，而不是手抄样式：
 *   AppUiProvider（主题 / reduced-motion）+ SettingsPage / SettingsSection / SettingRow /
 *   Button / Collapse / SettingsStack，与宿主设置页同一套原语。
 *   注意：**报到（hana.ready()）不在这套组件里**，得本页自己发，见文件末尾。
 *
 * 数据仍然走 App 自己的已认证路由（页面拿不到 ctx.config）：
 *   GET  /api/apps/githana/routes/settings/state   → 账号摘要 + 环境状态 + Client ID
 *   POST /api/apps/githana/routes/settings/legacy-pat/clear → 清除已停用的旧 PAT 记录
 *   POST /api/apps/githana/routes/actions/oauth/start|revoke → device flow 登录
 *   GET  /api/apps/githana/routes/actions/oauth/poll → 轮询登录结果（页面按 interval 自轮询）
 *   GET  /api/apps/githana/routes/actions/*        → 账号信息 / 公钥 / 密钥 / 发布
 *
 * 凭据**不在页面出现**：OAuth 令牌只由服务端 device flow 拿到，页面只展示 user_code 与
 * 账号摘要；页面没有任何「粘贴令牌」的入口（PAT 通道已删除）。Client ID 与署名身份也不收集：
 * 前者是本 App 注册的常量，后者由已登录账号推导。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppUiProvider,
  Button,
  Collapse,
  Inline,
  SettingRow,
  SettingsPage,
  SettingsSection,
  SettingsStack,
} from "@hana/app-sdk/components";
import "@hana/app-sdk/components.css";
import { hana } from "@hana/app-sdk/ui";
import "./settings.css";

/** 后端基址：本 App 的路由根（/api/apps/<appId>/routes/）。 */
function apiBase() {
  const m = /^(\/api\/apps\/[^/]+\/)ui(?:\/|$)/.exec(window.location.pathname || "");
  return m ? `${m[1]}routes/` : null;
}

/**
 * 本页的 surface 凭证：页面挂在租约路径下（/api/apps/<id>/ui/_surface/<token>/…），
 * 页面对自己后端路由的请求不会自动带凭证（没有 cookie）——凭证就在路径里那段。
 * 查询串形态优先（appSurfaceSession）。两种携带方式宿主都认，这里用 header。
 */
function surfaceCredential() {
  const fromQuery = new URLSearchParams(window.location.search).get("appSurfaceSession");
  if (fromQuery) return fromQuery;
  const m = /\/ui\/_surface\/([^/]+)\//.exec(window.location.pathname || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function authHeaders(extra) {
  const cred = surfaceCredential();
  return cred ? { ...(extra || {}), "X-Hana-App-Surface-Session": cred } : { ...(extra || {}) };
}

function baseOrThrow() {
  const base = apiBase();
  if (!base) throw new Error("本页不在 App 资源路径下，无法定位后端端点");
  return base;
}

async function getJson(path) {
  const base = baseOrThrow();
  const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}ts=${Date.now()}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: authHeaders({ Accept: "application/json" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.text || data.error || data.message || `HTTP ${res.status}`);
    // status / code 必须在这里就带上：调用方靠它们分辨「流程已不在服务端（404，重试无意义）」
    // 与「网络或服务端抖动（可重试）」。不带走的话 `e.status === 404` 永远为假。
    err.code = data.code || (res.status === 504 ? "timeout" : "http_" + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function postJson(path, body, { signal } = {}) {
  const base = baseOrThrow();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.text || data.error || data.message || `HTTP ${res.status}`);
    // 错误码要活到 catch 之外：页面据此决定给「重试」还是「去改设置」，
    // 而不是把所有失败都摊成同一行红字。
    err.code = data.code || (res.status === 504 ? "timeout" : "http_" + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 加密后端的人类可读名。 */
function protectionLabel(protection) {
  switch (protection) {
    case "dpapi-current-user":
      return "DPAPI（当前用户）";
    case "keychain":
      return "macOS 钥匙串";
    case "libsecret":
      return "Linux 密钥环";
    case "plaintext(legacy)":
      return "明文（旧版遗留，重新保存即迁移）";
    default:
      return protection || "—";
  }
}

/** 时间戳 → 本地可读（解析失败原样返回）。 */
function formatTime(value) {
  const s = String(value || "").trim();
  if (!s) return "—";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return s;
  }
}

/** 剩余秒数 → mm:ss。 */
function formatCountdown(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 状态短语：已配置 / 未配置。 */
function StatusText({ ok, on, off }) {
  return <span className={ok ? "gh-val gh-ok" : "gh-val gh-off"}>{ok ? on : off}</span>;
}

/** 等宽的值文本（版本号、路径、密钥 ID）。 */
function MonoText({ children, title }) {
  return (
    <span className="gh-val gh-mono" title={title || undefined}>
      {children}
    </span>
  );
}

/**
 * 把用户送到 GitHub 的验证页，并尽量把验证码送进剪贴板。
 *
 * 两条实测约束决定了这个形态：
 *   1. GitHub 的 device/code 响应只有 `verification_uri`，**不返回** RFC 8628 的
 *      `verification_uri_complete`，所以没有「码已嵌好」的 URL 可用；
 *   2. `/login/device` 不接受 `?user_code=` 预填入参，码必须由用户手动粘/敲。
 *      gh 官方（cli/oauth + cli/cli 的 authflow）也是这么做的。
 *
 * 两件事各自独立成败，所以各自回报：合成一句话会让「浏览器没开」和「剪贴板没写成」
 * 混成一团，而这两件对用户的下一步不一样（前者要手动点链接，后者要手动输码）。
 * 两件都不阻断授权：页面上的链接与验证码始终可手动使用。
 *
 * @returns {Promise<{ clipboard: {ok: boolean, text: string}, browser: {ok: boolean, text: string} }>}
async function sendToVerification(verificationUri, userCode) {
  const out = { clipboard: { ok: false, text: "" }, browser: { ok: false, text: "" } };

  try {
    const r = await hana.clipboard.writeText({ text: userCode });
    out.clipboard = r && r.written
      ? { ok: true, text: "验证码已复制" }
      : { ok: false, text: "验证码未能复制，请手动输入" };
  } catch {
    try {
      await navigator.clipboard.writeText(userCode);
      out.clipboard = { ok: true, text: "验证码已复制" };
    } catch {
      out.clipboard = { ok: false, text: "验证码未能复制，请手动输入" };
    }
  }

  try {
    const r = await hana.external.open({ url: verificationUri });
    out.browser = r && r.opened
      ? { ok: true, text: "已在浏览器打开验证页" }
      : { ok: false, text: "没能自动打开浏览器，请点「重新打开」" };
  } catch {
    out.browser = { ok: false, text: "没能自动打开浏览器，请点「重新打开」" };
  }

  return out;
}

/**
 * 再开一次验证页（等待期间用户可能提前关了那个标签页）。
 * @returns {Promise<string>} 给用户看的一句话
 */
async function reopenVerification(verificationUri) {
  try {
    const r = await hana.external.open({ url: verificationUri });
    return r && r.opened ? "已再次打开验证页" : "没能自动打开，请复制链接手动访问";
  } catch {
    return "没能自动打开，请复制链接手动访问";
  }
}

/** 轮询遇到传输层故障时最多重试几次（之后再判失败）。 */
const POLL_TRANSIENT_RETRIES = 3;

/** 需要去 GitHub App 设置页才能解决的问题，直接给出地址而不是叫用户自己找。 */
const APP_SETTINGS_HINT = "https://github.com/organizations/Nyasers/settings/apps/githana-app";

/** 把验证页地址送进剪贴板（自动开浏览器失败时的手动退路）。 */
async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    return "链接已复制";
  } catch {
    try {
      const r = await hana.clipboard.writeText({ text: url });
      return r && r.written ? "链接已复制" : "复制失败，请手动选中地址";
    } catch {
      return "复制失败，请手动选中地址";
    }
  }
}

/**
 * 发起失败 → 一段能直接决定下一步的话。
 *
 * 网络类失败是暂时的（重试）；配置类失败重试没用（要去改 GitHub App 设置）。
 * 把这两类写成同一行英文报错等于把判断推给用户，所以在这里分流。
 */
function startFailureText(code, message) {
  switch (code) {
    case "timeout":
      return (
        "连不上 github.com（请求超时），授权流程没有开始。" +
        "\n常见原因：代理/VPN 没开、或代理只给浏览器用而 Node 不走它。网络好了再点一次「登录」即可。" +
        "\n（原始信息：" +
        message +
        "）"
      );
    case "transport_error":
      return "与 github.com 的连接中断，授权流程没有开始。稍后重试。\n（原始信息：" + message + "）";
    case "device_flow_disabled":
      return "这个 GitHub App 没有启用 Device Flow，点多少次都没用：到 App 设置里打开它再回来。\n（原始信息：" + message + "）";
    case "incorrect_client_credentials":
      return "Client ID 不被 GitHub 认可，重试无效。\n（原始信息：" + message + "）";
    default:
      return message;
  }
}

/** device flow 的初始态。 */
const OAUTH_IDLE = {
  flowId: null,
  userCode: null,
  verificationUri: null,
  interval: 5,
  expiresAt: null,
  status: "idle", // idle | starting | waiting | ready | error
  error: null,
  errorCode: null,
};

function GitHanaSettings() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // device flow 授权
  const [oauth, setOauth] = useState(OAUTH_IDLE);
  const [remaining, setRemaining] = useState(0);
  const [handoff, setHandoff] = useState(null);
  const [reopenMsg, setReopenMsg] = useState(null);
  const intervalRef = useRef(5);
  // 发起请求的 AbortController：网络卡住时用户要能停下来，不必等它自己超时。
  const startAbortRef = useRef(null);

  // 面向用户的一条状态消息（退出授权的结果等）
  const [noticeMsg, setNoticeMsg] = useState(null);

  // GitHub 身份（REST /user）：显式读取，不隐式轮询
  const [identity, setIdentity] = useState({ loading: false, data: null, text: null });
  const [identityTried, setIdentityTried] = useState(false);

  // GPG 手动档
  const [kgBusy, setKgBusy] = useState(false);
  const [kgConfirm, setKgConfirm] = useState(false);
  const [kgText, setKgText] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [keyText, setKeyText] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubText, setPubText] = useState(null);
  const [unpubConfirm, setUnpubConfirm] = useState(false);

  // 旧 PAT 记录清除
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyMsg, setLegacyMsg] = useState(null);

  // 高级与诊断区：默认折叠，只展示用户要操心的两条主线。
  const [accountDetailOpen, setAccountDetailOpen] = useState(false);
  const [keyDetailOpen, setKeyDetailOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getJson("settings/state");
      setState(data);
      setLoadError(null);
    } catch (e) {
      setLoadError(String((e && e.message) || e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 首次拿到状态后不再需要预填：身份一律由账号推导，页面没有可编辑的身份字段。

  // ── device flow：发起 → 页面按 interval 自轮询 ──

  const startLogin = useCallback(async () => {
    // 上一次没收尾的发起请求先中止：连点两次不该有两个 flow 在飞。
    try {
      startAbortRef.current && startAbortRef.current.abort();
    } catch {
      /* 已结束 */
    }
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    startAbortRef.current = ctl;

    setOauth({ ...OAUTH_IDLE, status: "starting" });
    setNoticeMsg(null);
    setHandoff(null);
    setReopenMsg(null);
    try {
      const res = await postJson("actions/oauth/start", {}, { signal: ctl ? ctl.signal : undefined });
      intervalRef.current = Number(res.interval) > 0 ? Number(res.interval) : 5;
      setOauth({
        flowId: res.flowId,
        userCode: res.userCode,
        verificationUri: res.verificationUri,
        interval: intervalRef.current,
        expiresAt: Date.now() + (Number(res.expiresIn) || 900) * 1000,
        status: "waiting",
        error: null,
        errorCode: null,
      });
      // 先把浏览器与剪贴板推给用户，再做别的：验证码有 15 分钟寿命，越早到手越好。
      setHandoff(await sendToVerification(res.verificationUri, res.userCode));
      await refresh();
    } catch (e) {
      // 只有「本次调用仍然拥有这个槽」才能改状态。连点的第二下会把 startAbortRef 换成新
      // controller，旧请求的 catch 随后才跑到，此时它不该把新请求的 starting 摸回 idle，
      // 也不该用旧错误盖住新流程。
      if (startAbortRef.current !== ctl) return;
      if (e && e.name === "AbortError") {
        // 被 abort 的两种来源（cancelLogin / 新的 startLogin）都已经自己安排好状态。
        setOauth(OAUTH_IDLE);
        return;
      }
      const code = String((e && e.code) || "start_failed");
      setOauth({
        ...OAUTH_IDLE,
        status: "error",
        errorCode: code,
        error: startFailureText(code, String((e && e.message) || e)),
      });
    } finally {
      if (startAbortRef.current === ctl) startAbortRef.current = null;
    }
  }, [refresh]);

  const cancelLogin = useCallback(() => {
    try {
      startAbortRef.current && startAbortRef.current.abort();
    } catch {
      /* 已结束 */
    }
    startAbortRef.current = null;
    setOauth(OAUTH_IDLE);
    setHandoff(null);
    setReopenMsg(null);
  }, []);

  const reopenPage = useCallback(async () => {
    if (!oauth.verificationUri) return;
    setReopenMsg(await reopenVerification(oauth.verificationUri));
  }, [oauth.verificationUri]);

  const copyVerifyLink = useCallback(async () => {
    setReopenMsg(await copyLink(oauth.verificationUri || ""));
  }, [oauth.verificationUri]);

  // 退出登录 / 重新发起都要把上一轮请求收干净，否则一个迟到的响会盖掉新状态。
  const revokeLogin = useCallback(async () => {
    try {
      startAbortRef.current && startAbortRef.current.abort();
    } catch {
      /* 已结束 */
    }
    startAbortRef.current = null;
    setOauth(OAUTH_IDLE);
    setHandoff(null);
    setReopenMsg(null);
    setNoticeMsg(null);
    try {
      await postJson("actions/oauth/revoke", {});
      setIdentity({ loading: false, data: null, text: null });
      setIdentityTried(false);
      await refresh();
      setNoticeMsg("已退出授权");
    } catch (e) {
      setNoticeMsg(`退出授权失败：${String((e && e.message) || e)}`);
    }
  }, [refresh]);

  // 轮询：拿到 ready / 终态 error 即停；每次间隔按服务端回的 interval（slow_down 会加长）。
  //
  // 「可重试」有两个来源，两道门都要过：
  //   · 浏览器到 App 服务端失败：fetch 拓了，没有 status（网络层）；
  //   · GitHub 到 App 服务端失败：`pollDeviceFlow` 回 `status: "error"` 且 `code: "transport_error"`，
  //     此时 flow 仍在服务端活着，下一跳完全可能成功。
  // 其余错误码（expired_token / access_denied / device_flow_disabled …）是终态。
  useEffect(() => {
    if (!oauth.flowId || oauth.status !== "waiting") return undefined;
    let cancelled = false;
    let timer = null;
    let transient = 0;

    /** 服务端侧的可重试失败：flow 还在，只是这一跳没成。 */
    const retry = () => {
      transient += 1;
      if (transient <= POLL_TRANSIENT_RETRIES) {
        timer = setTimeout(tick, Math.max(2, intervalRef.current) * 1000);
        return true;
      }
      return false;
    };

    const giveUp = (errorCode, error) => {
      setOauth({ ...OAUTH_IDLE, status: "error", errorCode, error });
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await getJson(`actions/oauth/poll?id=${encodeURIComponent(oauth.flowId)}`);
        if (cancelled) return;
        if (res.status === "pending") {
          transient = 0;
          if (Number(res.interval) > 0) intervalRef.current = Number(res.interval);
          timer = setTimeout(tick, intervalRef.current * 1000);
          return;
        }
        if (res.status === "ready") {
          setOauth({ ...OAUTH_IDLE, status: "ready" });
          setIdentityTried(false);
          await refresh();
          return;
        }
        // 服务端明确说「只是这次没查成」：按可重试处理，不当终态。
        if (res.status === "error" && res.code === "transport_error" && retry()) return;
        giveUp(res.code || "poll_error", res.message || "授权失败");
      } catch (e) {
        if (cancelled) return;
        // 4xx 是客户端的错，重试也不会变（404 = flow 已不在服务端；401/403 = surface 会话失效）。
        // 只有没有 status 的网络失败与 5xx 才值得重试。
        const status = e && e.status;
        const retryable = status === undefined || status >= 500;
        if (retryable && retry()) return;
        if (status === 404) {
          giveUp("not_found", String((e && e.message) || "授权流程已失效，请重新点「登录」。"));
          return;
        }
        if (status !== undefined && status < 500) {
          giveUp("http_" + status, String((e && e.message) || `HTTP ${status}`));
          return;
        }
        giveUp(
          // 轮询中断与发起失败分开命名：两者给用户看的标题不同（一个已经拿到验证码，
          // 一个还没开始），套同一个 code 会让标题说错话。
          "poll_transport_error",
          "查询授权结果时连续失败 " +
            transient +
            " 次，已停止查询。验证码仍然有效：网络恢复后重新点「登录」即可，旧流程不影响新流程。" +
            "\n（最后一次错误：" +
            String((e && e.message) || e) +
            "）",
        );
      }
    };
    timer = setTimeout(tick, intervalRef.current * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [oauth.flowId, oauth.status, refresh]);

  // 剩余时间倒计时（只在等待授权时跑）。
  useEffect(() => {
    if (oauth.status !== "waiting" || !oauth.expiresAt) {
      setRemaining(0);
      return undefined;
    }
    const update = () => setRemaining(Math.max(0, Math.round((oauth.expiresAt - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [oauth.status, oauth.expiresAt]);

  const loadIdentity = useCallback(async () => {
    setIdentity((prev) => ({ ...prev, loading: true, text: null }));
    try {
      const data = await getJson("actions/identity");
      if (data && data.authenticated) {
        setIdentity({ loading: false, data, text: null });
      } else {
        setIdentity({ loading: false, data: null, text: (data && data.text) || "未取得身份" });
      }
    } catch (e) {
      setIdentity({ loading: false, data: null, text: String((e && e.message) || e) });
    }
  }, []);

  const runKeygen = useCallback(async () => {
    setKgBusy(true);
    setKgText(null);
    setPubText(null);
    setCopyMsg(null);
    try {
      const res = await postJson("actions/keygen", {});
      setKgText(res.text || "完成");
      setKgConfirm(false);
      await refresh();
      setShowKey(false);
      setKeyText(null);
    } catch (e) {
      setKgText(`执行失败：${String((e && e.message) || e)}`);
    } finally {
      setKgBusy(false);
    }
  }, [refresh]);

  const publishPubkey = useCallback(async () => {
    setPubBusy(true);
    setPubText(null);
    try {
      const res = await postJson("actions/gpg/publish", {});
      setPubText(res.text || "完成");
      await refresh();
    } catch (e) {
      setPubText(`上传失败：${String((e && e.message) || e)}`);
    } finally {
      setPubBusy(false);
    }
  }, [refresh]);

  const unpublishPubkey = useCallback(async () => {
    setPubBusy(true);
    setUnpubConfirm(false);
    setCopyMsg(null);
    try {
      const res = await postJson("actions/gpg/unpublish", {});
      setCopyMsg(res.text || "完成");
      await refresh();
      // 密钥已被移除，展开的公钥视图没有内容可看了。
      setShowKey(false);
      setKeyText(null);
    } catch (e) {
      setCopyMsg(`移除失败：${String((e && e.message) || e)}`);
    } finally {
      setPubBusy(false);
    }
  }, [refresh]);

  const clearLegacyPat = useCallback(async () => {
    setLegacyBusy(true);
    setLegacyMsg(null);
    try {
      const res = await postJson("settings/legacy-pat/clear", {});
      setLegacyMsg(res.cleared ? "旧 PAT 记录已清除" : res.reason || "本地没有旧 PAT 记录");
      await refresh();
    } catch (e) {
      setLegacyMsg(`清除失败：${String((e && e.message) || e)}`);
    } finally {
      setLegacyBusy(false);
    }
  }, [refresh]);

  /**
   * 展开/收起密钥明细。公钥正文跟着一起开关——它是给别人复制的材料，
   * 不是拿来读的，默认不该占页面。首次展开时才拉正文。
   */
  const toggleKeyDetail = useCallback(async () => {
    const next = !keyDetailOpen;
    setKeyDetailOpen(next);
    setShowKey(next);
    if (!next || keyText) return;
    try {
      const data = await getJson("actions/pubkey");
      setKeyText((data && data.pubkey) || "（未取到公钥）");
    } catch (e) {
      setKeyText(`读取失败：${String((e && e.message) || e)}`);
    }
  }, [keyDetailOpen, keyText]);

  const copyPubkey = useCallback(async () => {
    setCopyMsg(null);
    try {
      const data = await getJson("actions/pubkey");
      if (!data || !data.pubkey) {
        setCopyMsg("尚未生成公钥");
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(data.pubkey);
        setCopyMsg("已复制到剪贴板");
      } else {
        throw new Error("当前环境不支持剪贴板 API");
      }
    } catch (e) {
      setCopyMsg(`复制失败：${String((e && e.message) || e)}`);
    }
  }, []);

  // 已授权且还没读过身份时，自动读一次（失败不重试，用户可手动点）。
  useEffect(() => {
    const configured = !!(state && state.tokenConfigured);
    if (configured && !identityTried) {
      setIdentityTried(true);
      loadIdentity();
    }
  }, [state, identityTried, loadIdentity]);

  if (loadError) {
    return (
      <SettingsPage>
        <SettingsSection title="GitHana" description="读取设置页数据失败。">
          <SettingRow label="错误" hint="App 可能尚未加载完成，稍后重新打开本页。" control={<MonoText>{loadError}</MonoText>} />
        </SettingsSection>
      </SettingsPage>
    );
  }

  if (!state) {
    return (
      <SettingsPage>
        <SettingsSection title="GitHana" description="正在读取状态…">
          <SettingRow label="状态" control={<MonoText>读取中</MonoText>} />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const status = state.status || {};
  const secret = state.secret || {};
  const tools = status.tools || {};
  const rest = status.rest || {};
  const signing = status.signing || {};
  const pk = status.pubkey || {};
  const published = (pk && pk.publishedInfo) || {};
  const authorized = !!state.tokenConfigured;
  const needsReauth = !!secret.needsReauth;
  const waiting = oauth.status === "waiting";
  const starting = oauth.status === "starting";
  // 过期后不再自称「等待浏览器」：验证码已经作废，继续等只是让用户白等 15 分钟。
  //
  // 以 `expiresAt` 为凭据而不是 `remaining`：后者是另一个 effect 在首次渲染**之后**才写的，
  // 刚进 waiting 的那一帧它还是 0，用它判断会让「已过期」和「重新登录」闪一下。
  const expired = waiting && Boolean(oauth.expiresAt) && Date.now() >= oauth.expiresAt;

  return (
    <SettingsPage>
      <SettingsSection
        title="GitHub 账号"
        description="连接后，提交会用你的账号署名，签名公钥也直接发布到账号。"
        context={
          <Button variant="secondary" onClick={() => setAccountDetailOpen((v) => !v)}>
            {accountDetailOpen ? "收起明细" : "明细"}
          </Button>
        }
      >
        <SettingRow
          label="账号"
          control={
            <Inline gap="sm" align="center" wrap>
              {needsReauth ? (
                <StatusText ok={false} on="已连接" off="登录已过期" />
              ) : (
                <StatusText ok={authorized} on="已连接" off="未连接" />
              )}
              {authorized && secret.login ? <MonoText>@{secret.login}</MonoText> : null}
              <Button
                variant={authorized ? "secondary" : "primary"}
                disabled={starting || (waiting && !expired)}
                onClick={startLogin}
              >
                {starting
                  ? "正在连接 GitHub…"
                  : waiting
                    ? expired
                      ? "重新登录"
                      : "等待浏览器…"
                    : oauth.status === "error"
                      ? "重试登录"
                      : authorized
                        ? "重新登录"
                        : "登录"}
              </Button>
              {starting || waiting ? (
                <Button variant="secondary" onClick={cancelLogin}>
                  取消
                </Button>
              ) : null}
              {authorized && !waiting && !starting ? (
                <Button variant="ghost" onClick={revokeLogin}>
                  退出登录
                </Button>
              ) : null}
            </Inline>
          }
          hint={
            starting
              ? "正在向 GitHub 要一个验证码；连不上会在这里直接说原因，也可以点「取消」。"
              : authorized
                ? "令牌到期前会自动续期，无需手动操作。"
                : "登录后才能生成签名密钥。点「登录」，浏览器会打开验证页。"
          }
        />
        {needsReauth ? (
          <SettingRow
            label="登录已过期"
            hintVariant="warn"
            hint="刷新凭证已失效（超期或授权被撤销），不会再用于任何请求。"
            control={<MonoText>需重新登录</MonoText>}
          />
        ) : null}
        {secret.backendAvailable === false ? (
          <SettingRow
            label="凭据无法保存"
            hintVariant="warn"
            hint="本机暂不支持加密存储，登录信息无法落盘（不会以明文保存）。macOS / Linux 待接。"
            control={<MonoText>不可用</MonoText>}
          />
        ) : null}
        {secret.readable === false && secret.configured ? (
          <SettingRow
            label="登录信息不可读"
            hintVariant="warn"
            hint="本机读不出已保存的登录信息（可能来自别的平台）。"
            control={<MonoText>需重新登录</MonoText>}
          />
        ) : null}
        {secret.legacyPatPresent ? (
          <SettingRow
            label="旧版令牌记录"
            hintVariant="warn"
            hint="它已停用，不会被用于任何请求，可以清除。"
            control={
              <Inline gap="sm" align="center" wrap>
                <Button variant="secondary" disabled={legacyBusy} onClick={clearLegacyPat}>
                  {legacyBusy ? "清除中…" : "清除"}
                </Button>
                {legacyMsg ? <span className="gh-msg">{legacyMsg}</span> : null}
              </Inline>
            }
          />
        ) : null}
        {noticeMsg ? <SettingRow label="状态" control={<span className="gh-msg">{noticeMsg}</span>} /> : null}
        {waiting ? (
          <>
            <SettingRow
              label="验证码"
              layout="stacked"
              hint={
                handoff && handoff.clipboard.ok
                  ? "已复制到剪贴板，到浏览器页面粘贴并批准即可。"
                  : "没能自动复制，选中这串字自己复制到验证页。"
              }
              control={<span className="gh-usercode">{oauth.userCode}</span>}
            />
            <SettingRow
              label="验证页"
              truncateText
              control={
                <Inline gap="sm" align="center" wrap>
                  <MonoText title={oauth.verificationUri || ""}>{oauth.verificationUri || "—"}</MonoText>
                  <Button variant="secondary" onClick={reopenPage}>
                    重新打开
                  </Button>
                  <Button variant="ghost" onClick={copyVerifyLink}>
                    复制地址
                  </Button>
                </Inline>
              }
              hint={
                handoff
                  ? handoff.browser.text + (reopenMsg ? "；" + reopenMsg : "")
                  : "浏览器没弹出来时，复制这个地址到浏览器里访问。"
              }
            />
            <SettingRow
              label="剩余时间"
              control={<MonoText>{formatCountdown(remaining)}</MonoText>}
              hint={
                expired
                  ? "验证码已过期。点「重新登录」拿一枚新的；旧流程作废不影响新的。"
                  : `每 ${oauth.interval} 秒自动查一次结果，批准后本行会自动变成「登录成功」。`
              }
            />
          </>
        ) : null}
        {/*
          登录成功后不再单起一行「登录成功」：账号那行已经写着「已连接 @login」，
          而那一行跟着凭据持久存在，这句只是一次性回显。多一行不增加信息量。
        */}
        {oauth.status === "error" && oauth.error ? (
          <SettingRow
            label={oauth.errorCode === "poll_transport_error" ? "查询中断" : "登录未完成"}
            layout="stacked"
            hintVariant="warn"
            hint={<span className="gh-wrap">{oauth.error}</span>}
            control={
              <Inline gap="sm" align="center" wrap>
                <Button variant="secondary" onClick={startLogin}>
                  {oauth.errorCode === "not_found" || oauth.errorCode === "expired_token" ? "重新登录" : "重试"}
                </Button>
                {oauth.errorCode === "device_flow_disabled" || oauth.errorCode === "incorrect_client_credentials" ? (
                  <MonoText>{APP_SETTINGS_HINT}</MonoText>
                ) : null}
              </Inline>
            }
          />
        ) : null}

        {/* 账号明细：整组展开在账号区块里，不另起「高级」区。
            不用 SDK 的 dependent：它在给分隔线的同时把内容右挤 2rem、上下各加 0.5rem
            padding 和半混底色。这里只要那条线，所以自己包一层 .gh-detail。 */}
        <Collapse open={accountDetailOpen}>
          <div className="gh-detail">
            <SettingsStack gap="sm">
            <SettingRow
              label="账号信息"
              control={
                <Inline gap="sm" align="center" wrap>
                  <Button variant="secondary" disabled={identity.loading} onClick={loadIdentity}>
                    {identity.loading ? "读取中…" : identity.data ? "刷新" : "读取"}
                  </Button>
                  {identity.data ? <MonoText>@{identity.data.login}</MonoText> : null}
                </Inline>
              }
            />
            {identity.data ? (
              <SettingRow label="提交者名字" control={<MonoText>{identity.data.name || "—"}</MonoText>} />
            ) : null}
            {identity.data ? (
              <SettingRow
                label="提交邮箱"
                truncateText
                control={<MonoText title={identity.data.commitEmail || ""}>{identity.data.commitEmail || "—"}</MonoText>}
              />
            ) : null}
            {identity.data && identity.data.publicEmail ? (
              <SettingRow label="公开邮箱" control={<MonoText>{identity.data.publicEmail}</MonoText>} />
            ) : null}
            {identity.data ? (
              <SettingRow
                label="账号 ID"
                control={<MonoText>{identity.data.id === null ? "—" : String(identity.data.id)}</MonoText>}
              />
            ) : null}
            {identity.text ? <pre className="gh-out">{identity.text}</pre> : null}

            {secret.expiresAt ? (
              <SettingRow label="登录到期" control={<MonoText>{formatTime(secret.expiresAt)}</MonoText>} />
            ) : null}
            {secret.refreshExpiresAt ? (
              <SettingRow
                label="续期凭证到期"
                control={<MonoText>{formatTime(secret.refreshExpiresAt)}</MonoText>}
                hint="到期后需重新登录"
              />
            ) : null}
            <SettingRow
              label="凭据保护方式"
              control={<MonoText>{protectionLabel(secret.protection)}</MonoText>}
              hint={secret.location ? `存放：${secret.location}` : null}
            />
            <SettingRow label="Client ID" control={<MonoText>{state.clientId || "—"}</MonoText>} hint="不开放修改" />
            </SettingsStack>
          </div>
        </Collapse>
      </SettingsSection>

      <SettingsSection
        title="签名密钥"
        description="给提交签名。密钥只保存在 GitHana 自己的目录里，不动系统上的其它 GPG 密钥。"
        context={
          <Button variant="secondary" onClick={toggleKeyDetail}>
            {keyDetailOpen ? "收起明细" : "明细"}
          </Button>
        }
      >
        <SettingRow
          label="状态"
          control={
            <Inline gap="sm" align="center" wrap>
              <StatusText ok={Boolean(pk.present)} on="已生成" off="未生成" />
              {pk.present && published.published ? <StatusText ok on="已发布到 GitHub" off="未发布" /> : null}
              {pk.present && !published.published ? <StatusText ok={false} on="已发布" off="未发布到 GitHub" /> : null}
              {kgConfirm ? (
                <>
                  <Button variant="danger" disabled={kgBusy} onClick={runKeygen}>
                    {kgBusy ? "执行中…" : "确认轮换（旧密钥作废）"}
                  </Button>
                  <Button variant="ghost" disabled={kgBusy} onClick={() => setKgConfirm(false)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  variant={pk.present ? "secondary" : "primary"}
                  disabled={kgBusy || !authorized}
                  onClick={() => (pk.present ? setKgConfirm(true) : runKeygen())}
                >
                  {kgBusy ? "执行中…" : pk.present ? "轮换密钥" : "生成签名密钥"}
                </Button>
              )}
            </Inline>
          }
          hint={
            // 徽标已经说了「已发布 / 未发布」，这里不再复述那个状态，
            // 只说徽标没说清的那件事：提交会不会显示 Verified。
            !authorized
              ? "先在上方登录 GitHub 账号；密钥的署名身份从那个账号推导。"
              : pk.present
                ? published.published
                  ? "提交会自动签名，GitHub 上显示为 Verified。"
                  : "公钥还没传上去；在那之前提交不会显示为 Verified。"
                : "生成后会直接发布到账号，两边始终一致。"
          }
        />
        {pk.present && pk.uid ? (
          <SettingRow label="签名身份" control={<MonoText title={pk.uid}>{pk.uid}</MonoText>} truncateText />
        ) : null}
        {kgText ? <pre className="gh-out">{kgText}</pre> : null}

        {/* 密钥本体与明细：两者都是“从属信息”，收进同一组。

            以前公钥正文、复制/移除两个按钮、「签名身份」都铺在主区，主行只剩两行字，
            下面却排了长长一截——层级是反的。公钥正文是给别人复制的材料，不是拿来读的，
            只在摊开看时才占位；两个操作按钮跟着它走。 */}
        <Collapse open={keyDetailOpen}>
          <div className="gh-detail">
            <SettingsStack gap="sm">
            {/* 密钥标识只列两项，不把同一个值说两遍。

                本地「密钥 ID」= 指纹末 16 位（见 lib/routes/pubkey.js 的 keyId）。
                GitHub 侧的 `gpgKeyId` 也是指纹末 16 位（lib/gpg-publish.js 的
                `key.key_id || fpr.slice(-16)`）——两者是同一个值。
                而 GitHub 的 `keyId` 是它自己的数字 id（删除时才用到），跟指纹无关。

                所以：指纹列全量，末 16 位不单列（它就在指纹末尾）；
                GitHub 数字 id 标清楚它是“账号内编号”，避免与 keyId 混。 */}
            {pk.fpr ? (
              <SettingRow
                label="指纹"
                truncateText
                control={<MonoText title={pk.fpr}>{pk.fpr}</MonoText>}
                hint="GitHub 页面上的 key ID 就是它的末 16 位"
              />
            ) : null}
            {published.keyId ? (
              <SettingRow
                label="账号内编号"
                control={<MonoText>{published.keyId}</MonoText>}
                hint="GitHub 用来定位这把钥匙的数字 id，不是指纹"
              />
            ) : null}
            {published.uploadedAt ? (
              <SettingRow label="上传时间" control={<MonoText>{formatTime(published.uploadedAt)}</MonoText>} />
            ) : null}
            {published.login ? (
              <SettingRow label="发布账号" control={<MonoText>@{published.login}</MonoText>} />
            ) : null}
            {published.pending ? (
              <SettingRow
                label="待清理的旧公钥"
                hintVariant="warn"
                hint="下次上传或移除时自动重试。"
                control={<MonoText>{published.pending} 把</MonoText>}
              />
            ) : null}
            {!published.published && pk.present ? (
              <SettingRow
                label="公钥未在账号上"
                hint="补传之前，提交不会显示为 Verified。"
                control={
                  <Button variant="secondary" disabled={pubBusy} onClick={publishPubkey}>
                    {pubBusy ? "处理中…" : "上传公钥"}
                  </Button>
                }
              />
            ) : null}

            {/* 完整公钥放最后：它是长文本（几十行 armored base64），
                放在元数据前面会把下面所有行都顶下去。

                “完整公钥”做成一行、按钮放右侧，与上面“密钥 ID / 指纹 / key_id”
                共用同一套 label-右值节奏。之前两个按钮是独立一行浮在公钥框下沿，
                看着像两行无框文字，跟卡片里其他行不是一套语言。 */}
            {showKey ? (
              <>
                <SettingRow
                  label="完整公钥"
                  control={
                    <Inline gap="sm" align="center" wrap>
                      <Button variant="secondary" onClick={copyPubkey}>
                        复制
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={pubBusy || !published.published}
                        onClick={() => (unpubConfirm ? unpublishPubkey() : setUnpubConfirm(true))}
                      >
                        {pubBusy ? "处理中…" : unpubConfirm ? "确认移除（本机密钥一并删除）" : "从 GitHub 移除"}
                      </Button>
                      {unpubConfirm ? (
                        <Button variant="ghost" disabled={pubBusy} onClick={() => setUnpubConfirm(false)}>
                          取消
                        </Button>
                      ) : null}
                    </Inline>
                  }
                />
                {/* 公钥正文：不放在 SettingRow 里（没有 label），也不加左边距，
                    与这一组其他行的左边线对齐。 */}
                <pre className="gh-pubkey">{keyText || "读取中…"}</pre>
                {copyMsg ? <span className="gh-msg">{copyMsg}</span> : null}
              </>
            ) : null}
            {pubText ? <pre className="gh-out">{pubText}</pre> : null}
            </SettingsStack>
          </div>
        </Collapse>
      </SettingsSection>

      {/* 运行环境：保留一个可收起的区，因为它只在排查安装问题时才需要看。 */}
      <SettingsSection
        title="运行环境"
        description="安装是否完整、签名与连网是否就绪。出问题时供排查，平时不用看。"
        surface={envOpen ? "card" : "plain"}
        context={
          <Button variant="secondary" onClick={() => setEnvOpen((v) => !v)}>
            {envOpen ? "收起" : "展开"}
          </Button>
        }
      >
        <Collapse open={envOpen}>
          <div className="gh-flush-tail">
            <SettingsStack gap="md">
              <SettingRow
                label="git"
                truncateText
                control={<StatusText ok={Boolean(tools.git && tools.git.version)} on="可用" off="缺失" />}
                hint={<MonoText title={(tools.git && tools.git.version) || ""}>{(tools.git && tools.git.version) || "缺失"}</MonoText>}
              />
              <SettingRow
                label="签名组件"
                truncateText
                control={<StatusText ok={Boolean(signing && signing.shimPresent && signing.openpgpLibPresent)} on="就绪" off="缺失" />}
                hint={
                  signing && signing.shimPresent && signing.openpgpLibPresent ? (
                    <MonoText title={signing.shimPath || ""}>{signing.backend || "openpgp.js"}</MonoText>
                  ) : (
                    <span className="gh-msg">
                      安装不完整：缺少 {signing && !signing.shimPresent ? "bin/gpg.shim.mjs" : "bin/openpgp.min.mjs"}，请重装 GitHana。
                    </span>
                  )
                }
              />
              <SettingRow
                label="GitHub 通道"
                truncateText
                control={<StatusText ok={Boolean(rest.workerPresent)} on="就绪" off="缺失" />}
                hint={
                  rest.workerPresent ? (
                    <MonoText title={rest.workerPath || ""}>{"node " + (rest.runtimeVersion || "?")}</MonoText>
                  ) : (
                    <span className="gh-msg">安装不完整：缺少 bin/rest.worker.mjs，请重装 GitHana。</span>
                  )
                }
              />
              <SettingRow label="允许访问的域名" control={<MonoText>{(rest.allowedHosts || []).join(" · ") || "—"}</MonoText>} />
              <SettingRow label="数据目录" truncateText control={<MonoText title={status.dataDir || ""}>{status.dataDir || "—"}</MonoText>} />
            </SettingsStack>
          </div>
        </Collapse>
      </SettingsSection>
    </SettingsPage>
  );
}

function Root() {
  // AppUiProvider 跟随宿主主题与 reduced-motion；不提供页边距，页边距由宿主设置容器负责。
  return (
    <AppUiProvider className="gh-root">
      <GitHanaSettings />
    </AppUiProvider>
  );
}

// 页面报到：宿主靠这条消息把 iframe 从「加载中」切到「就绪」。设置页这类表面用的是
// readyOnTimeout=false —— 5 秒内没收到就判失败，界面上就是一句「应用加载失败」。
// @hana/app-sdk/components 的 AppUiProvider 只管主题与 reduced-motion，不负责这次报到，
// 所以必须本页自己喊（与官方脚手架 ui/assets/panel.js 里的 hana.ready() 同理）。
// 不在 App iframe 里（比如直接开文件）时 SDK 会拒绝，忽略即可，不影响页面其余逻辑。
try {
  Promise.resolve(hana.ready()).catch(() => {});
} catch {
  /* 非 App 路由：跳过报到 */
}

createRoot(document.getElementById("root")).render(<Root />);
