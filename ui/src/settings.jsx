// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * ui/src/settings.jsx — GitHana 设置页（React，复用宿主组件）。
 *
 * 用 @hana/app-sdk/components 里的宿主组件搭页面，而不是手抄样式：
 *   AppUiProvider（主题 / reduced-motion）+ SettingsPage / SettingsSection / SettingRow /
 *   SaveButton / Button / TextInput，与宿主设置页同一套原语。
 *   注意：**报到（hana.ready()）不在这套组件里**，得本页自己发，见文件末尾。
 *
 * 数据仍然走 App 自己的已认证路由（页面拿不到 ctx.config）：
 *   GET  /api/apps/githana/routes/settings/state   → 授权摘要 + 环境状态 + Client ID
 *   POST /api/apps/githana/routes/settings/client-id → 保存 Client ID 覆盖值（非机密）
 *   POST /api/apps/githana/routes/settings/legacy-pat/clear → 清除已停用的旧 PAT 记录
 *   POST /api/apps/githana/routes/actions/oauth/start|revoke → device flow 授权
 *   GET  /api/apps/githana/routes/actions/oauth/poll → 轮询授权结果（页面按 interval 自轮询）
 *   GET  /api/apps/githana/routes/actions/*        → 身份 / gh 状态 / 公钥 / 密钥 / 发布
 *
 * 凭据**不在页面出现**：OAuth 令牌只由服务端 device flow 拿到，页面只展示 user_code 与
 * 账号摘要；页面没有任何「粘贴令牌」的入口（PAT 通道已删除）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppUiProvider,
  Button,
  Grid,
  Inline,
  SaveButton,
  SettingRow,
  SettingsPage,
  SettingsSection,
  TextInput,
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
  if (!res.ok) throw new Error(data.text || data.error || data.message || `HTTP ${res.status}`);
  return data;
}

async function postJson(path, body) {
  const base = baseOrThrow();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.text || data.error || data.message || `HTTP ${res.status}`);
  return data;
}

/** 凭据来源的人类可读名（来源由 gh 输出里的括号标注推断）。 */
const AUTH_SOURCE_LABEL = { env: "用户登录的 OAuth 令牌", keyring: "系统 keyring", file: "配置文件明文" };

/** 从 gh 的输出里读认证态（gh 会把凭据来源写在括号里，如 "(keyring)" / "GH_TOKEN"）。
 *  gh 可能同时列出多条账号（本 App 注入的 GH_TOKEN + 用户自己的 keyring），所以要取
 *  「Active account: true」那一段来判来源，否则会把不生效的那条当成来源。 */
function parseAuthOutput(text, okFlag) {
  const t = String(text || "");
  const blocks = t.split(/^\s*✓/m);
  const active = blocks.find((b) => /Active account:\s*true/i.test(b)) || t;
  return {
    known: true,
    authed: okFlag === true && /logged in to/i.test(t),
    source: /GH_TOKEN/i.test(active)
      ? "env"
      : /\(keyring\)/i.test(active)
        ? "keyring"
        : /hosts\.yml|plaintext/i.test(active)
          ? "file"
          : null,
  };
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

function ToolRow({ label, tool }) {
  const ok = Boolean(tool && tool.version);
  const src = tool ? (tool.bundled ? tool.label || "内嵌" : "系统 PATH") : "缺失";
  const text = tool && tool.version ? tool.version : src;
  return (
    <SettingRow
      label={label}
      truncateText
      control={<StatusText ok={ok} on="可用" off="缺失" />}
      hint={<MonoText title={text}>{text}</MonoText>}
    />
  );
}

/** device flow 的初始态。 */
const OAUTH_IDLE = {
  starting: false,
  flowId: null,
  userCode: null,
  verificationUri: null,
  interval: 5,
  expiresAt: null,
  status: "idle", // idle | waiting | ready | error
  error: null,
};

function GitHanaSettings() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Client ID（非机密）：输入框只放用户覆盖值，留空即回落内置默认。
  const [clientIdInput, setClientIdInput] = useState("");
  const [clientIdTouched, setClientIdTouched] = useState(false);
  const [clientIdStatus, setClientIdStatus] = useState("idle");
  const [clientIdMsg, setClientIdMsg] = useState(null);

  // device flow 授权
  const [oauth, setOauth] = useState(OAUTH_IDLE);
  const [remaining, setRemaining] = useState(0);
  const intervalRef = useRef(5);

  // gh 认证态（由「检测 gh 认证」/「读取身份」结果更新）
  const [auth, setAuth] = useState({ known: false, authed: false, source: null });
  const [ghBusy, setGhBusy] = useState(false);
  const [ghText, setGhText] = useState(null);

  // GitHub 身份（gh api user）：显式读取，不隐式轮询
  const [identity, setIdentity] = useState({ loading: false, data: null, text: null });
  const [identityTried, setIdentityTried] = useState(false);

  // GPG 手动档
  const [kgName, setKgName] = useState("");
  const [kgEmail, setKgEmail] = useState("");
  const [kgBusy, setKgBusy] = useState(false);
  const [kgConfirm, setKgConfirm] = useState(false);
  const [kgText, setKgText] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [showFpr, setShowFpr] = useState(false);
  const [keyText, setKeyText] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubText, setPubText] = useState(null);

  // 旧 PAT 记录清除
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyMsg, setLegacyMsg] = useState(null);

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

  // 首次拿到状态时把 Client ID 覆盖值填进输入框（用户编辑过就不再覆盖）。
  useEffect(() => {
    if (!state || clientIdTouched) return;
    setClientIdInput(state.clientIdOverride || "");
  }, [state, clientIdTouched]);

  const saveClientId = useCallback(async () => {
    setClientIdStatus("saving");
    setClientIdMsg(null);
    try {
      const value = clientIdInput.trim();
      const res = await postJson("settings/client-id", { clientId: value });
      setClientIdStatus("saved");
      setClientIdMsg(value ? "已保存覆盖值" : "已清除覆盖，使用内置默认值");
      setState((prev) => (prev ? { ...prev, clientId: res.clientId, clientIdOverride: res.clientIdOverride } : prev));
    } catch (e) {
      setClientIdStatus("idle");
      setClientIdMsg(`保存失败：${String((e && e.message) || e)}`);
    }
  }, [clientIdInput]);

  // ── device flow：发起 → 页面按 interval 自轮询 ──

  const startLogin = useCallback(async () => {
    setOauth({ ...OAUTH_IDLE, starting: true });
    setClientIdMsg(null);
    try {
      const value = clientIdInput.trim();
      // 先把输入框里的 Client ID 落盘（空串 = 撤销覆盖，回落内置默认），
      // 再发起授权——这样页面显示的与下次登录用的一定是同一个。
      try {
        await postJson("settings/client-id", { clientId: value });
      } catch {
        /* 覆盖值落盘失败不阻断本次授权：start 会显式带上输入框里的值 */
      }
      const res = await postJson("actions/oauth/start", { clientId: value });
      intervalRef.current = Number(res.interval) > 0 ? Number(res.interval) : 5;
      setOauth({
        starting: false,
        flowId: res.flowId,
        userCode: res.userCode,
        verificationUri: res.verificationUri,
        interval: intervalRef.current,
        expiresAt: Date.now() + (Number(res.expiresIn) || 900) * 1000,
        status: "waiting",
        error: null,
      });
      await refresh();
    } catch (e) {
      setOauth({ ...OAUTH_IDLE, status: "error", error: String((e && e.message) || e) });
    }
  }, [clientIdInput, refresh]);

  const cancelLogin = useCallback(() => {
    setOauth(OAUTH_IDLE);
  }, []);

  const revokeLogin = useCallback(async () => {
    setOauth(OAUTH_IDLE);
    setClientIdMsg(null);
    try {
      await postJson("actions/oauth/revoke", {});
      setIdentity({ loading: false, data: null, text: null });
      setIdentityTried(false);
      setAuth({ known: false, authed: false, source: null });
      await refresh();
      setClientIdMsg("已退出授权");
    } catch (e) {
      setClientIdMsg(`退出授权失败：${String((e && e.message) || e)}`);
    }
  }, [refresh]);

  // 轮询：拿到 ready / error / 404 即停；每次间隔按服务端回的 interval（slow_down 会加长）。
  useEffect(() => {
    if (!oauth.flowId || oauth.status !== "waiting") return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await getJson(`actions/oauth/poll?id=${encodeURIComponent(oauth.flowId)}`);
        if (cancelled) return;
        if (res.status === "pending") {
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
        setOauth({ ...OAUTH_IDLE, status: "error", error: res.message || "授权失败" });
      } catch (e) {
        if (cancelled) return;
        setOauth({ ...OAUTH_IDLE, status: "error", error: String((e && e.message) || e) });
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

  const runGhStatus = useCallback(async () => {
    setGhBusy(true);
    setGhText(null);
    try {
      const res = await getJson("actions/gh-status");
      setGhText(res.text || "（无输出）");
      setAuth(parseAuthOutput(res.text, res.ok));
    } catch (e) {
      setGhText(`检测失败：${String((e && e.message) || e)}`);
    } finally {
      setGhBusy(false);
    }
  }, []);

  const loadIdentity = useCallback(async () => {
    setIdentity((prev) => ({ ...prev, loading: true, text: null }));
    try {
      const data = await getJson("actions/identity");
      if (data && data.authenticated) {
        setIdentity({ loading: false, data, text: null });
        // 身份读取成功 = gh 确实在认证状态下；而本 App 的认证途径就是按次注入 GH_TOKEN，
        // 所以这里宁可报「注入的令牌」，也不留一个「来源：未知」让人怀疑令牌没生效。
        setAuth((prev) => (prev.source ? prev : { known: true, authed: true, source: "env" }));
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
    try {
      const res = await postJson("actions/keygen", { name: kgName.trim(), email: kgEmail.trim() });
      setKgText(res.text || "完成");
      setKgConfirm(false);
      await refresh();
      setShowKey(false);
      setShowFpr(false);
      setKeyText(null);
    } catch (e) {
      setKgText(`执行失败：${String((e && e.message) || e)}`);
    } finally {
      setKgBusy(false);
    }
  }, [kgName, kgEmail, refresh]);

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
    setPubText(null);
    try {
      const res = await postJson("actions/gpg/unpublish", {});
      setPubText(res.text || "完成");
      await refresh();
    } catch (e) {
      setPubText(`移除失败：${String((e && e.message) || e)}`);
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

  const toggleKeyText = useCallback(async () => {
    if (showKey) {
      setShowKey(false);
      return;
    }
    if (!keyText) {
      try {
        const data = await getJson("actions/pubkey");
        setKeyText((data && data.pubkey) || "（未取到公钥）");
      } catch (e) {
        setKeyText(`读取失败：${String((e && e.message) || e)}`);
      }
    }
    setShowKey(true);
  }, [showKey, keyText]);

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
  const pk = status.pubkey || {};
  const published = (pk && pk.publishedInfo) || {};
  const authorized = !!state.tokenConfigured;
  const needsReauth = !!secret.needsReauth;
  const waiting = oauth.status === "waiting";

  return (
    <SettingsPage>
      <SettingsSection
        title="GitHub 认证"
        description="用 GitHub App 授权（device flow）取得访问令牌。令牌不进宿主设置表，也不在页面回显：由本 App 用平台加密后端写进自己的数据目录，并按次注入 GH_TOKEN 给 gh CLI。"
      >
        <SettingRow
          label="授权状态"
          control={
            needsReauth ? (
              <StatusText ok={false} on="已授权" off="需重新授权" />
            ) : (
              <StatusText ok={authorized} on="已授权" off="未授权" />
            )
          }
          hint={
            authorized
              ? `gh 调用时会带上 OAuth 令牌${secret.login ? `（@${secret.login}）` : ""}`
              : "未授权时 gh 调用会报未登录；生成密钥也需先授权以推导提交身份"
          }
        />
        {needsReauth ? (
          <SettingRow
            label="需重新授权"
            hintVariant="warn"
            hint="刷新令牌已失效（超过 6 个月或授权被撤销）。失效令牌不会再被使用，也不会降级到其它凭据——请重新点「用 GitHub 登录」。"
            control={<MonoText>需重新授权</MonoText>}
          />
        ) : null}
        {secret.expiresAt ? (
          <SettingRow label="令牌到期" control={<MonoText>{formatTime(secret.expiresAt)}</MonoText>} hint="剩余不足 5 分钟时自动续期，无需操作" />
        ) : null}
        {secret.refreshExpiresAt ? (
          <SettingRow label="续期凭证到期" control={<MonoText>{formatTime(secret.refreshExpiresAt)}</MonoText>} hint="到期后需重新授权" />
        ) : null}
        <SettingRow
          label="令牌保护"
          control={<MonoText>{protectionLabel(secret.protection)}</MonoText>}
          hint={secret.location ? `存放：${secret.location}` : null}
        />
        {secret.readable === false && secret.configured ? (
          <SettingRow
            label="提示"
            hintVariant="warn"
            hint="当前后端读不出这份密文（可能是别的平台加密写入的）。重新授权一次即可迁移到本机后端。"
            control={<MonoText>需重新授权</MonoText>}
          />
        ) : null}
        {secret.backendAvailable === false ? (
          <SettingRow
            label="提示"
            hintVariant="warn"
            hint="本平台暂无可用的加密后端，凭据无法落盘（不会以明文保存）。macOS / Linux 后端待接。"
            control={<MonoText>无加密后端</MonoText>}
          />
        ) : null}

        <SettingRow
          label="Client ID"
          layout="stacked"
          hint="GitHub App 的 Client ID，非机密。留空则使用内置默认值；改动后点「保存」或直接点「用 GitHub 登录」都会落盘。"
          control={
            <TextInput
              value={clientIdInput}
              autoComplete="off"
              spellCheck={false}
              placeholder={`内置默认：${state.clientId || "—"}`}
              aria-label="GitHub App Client ID"
              onChange={(e) => {
                setClientIdTouched(true);
                setClientIdInput(e.target.value);
              }}
            />
          }
        />
        <SettingRow
          label="Client ID 操作"
          control={
            <Inline gap="sm" align="center" wrap>
              <SaveButton
                status={clientIdStatus}
                labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
                onSavedFeedbackEnd={() => setClientIdStatus("idle")}
                disabled={clientIdStatus === "saving"}
                onClick={saveClientId}
              />
              <MonoText>当前生效：{state.clientId || "—"}{state.clientIdOverride ? "（覆盖值）" : "（内置默认）"}</MonoText>
            </Inline>
          }
        />
        {clientIdMsg ? <SettingRow label="Client ID 状态" control={<span className="gh-msg">{clientIdMsg}</span>} /> : null}

        <SettingRow
          label="用 GitHub 登录"
          layout="stacked"
          hint="点开后按提示在浏览器完成一次授权；页面会自动轮询结果，无需手动刷新。"
          control={
            <Inline gap="sm" align="center" wrap>
              <Button variant="primary" disabled={oauth.starting || waiting} onClick={startLogin}>
                {oauth.starting ? "发起中…" : waiting ? "等待授权…" : authorized ? "重新授权" : "用 GitHub 登录"}
              </Button>
              {waiting ? (
                <Button variant="secondary" onClick={cancelLogin}>
                  取消
                </Button>
              ) : null}
              <Button variant="secondary" disabled={!authorized} onClick={revokeLogin}>
                退出授权
              </Button>
            </Inline>
          }
        />
        {waiting ? (
          <>
            <SettingRow
              label="验证码"
              layout="stacked"
              hint="在浏览器里打开下面的地址，输入这个验证码并批准授权。"
              control={<span className="gh-usercode">{oauth.userCode}</span>}
            />
            <SettingRow
              label="验证地址"
              truncateText
              control={<MonoText title={oauth.verificationUri || ""}>{oauth.verificationUri || "—"}</MonoText>}
            />
            <SettingRow
              label="剩余时间"
              control={<MonoText>{formatCountdown(remaining)}</MonoText>}
              hint={remaining <= 0 ? "已超时，请重新发起授权" : `每 ${oauth.interval} 秒自动查询一次`}
            />
          </>
        ) : null}
        {oauth.status === "ready" ? (
          <SettingRow label="授权结果" hintVariant="default" hint="已取得令牌，可以继续生成密钥或发布公钥。" control={<span className="gh-val gh-ok">授权成功</span>} />
        ) : null}
        {oauth.status === "error" && oauth.error ? <pre className="gh-out">{oauth.error}</pre> : null}

        {secret.legacyPatPresent ? (
          <SettingRow
            label="旧 PAT 通道已停用"
            hintVariant="warn"
            hint="检测到旧版个人访问令牌记录。它已不再被采用（不会注入 GH_TOKEN，也不会用于任何调用）；可以在这里清除。"
            control={
              <Inline gap="sm" align="center" wrap>
                <Button variant="secondary" disabled={legacyBusy} onClick={clearLegacyPat}>
                  {legacyBusy ? "清除中…" : "清除旧记录"}
                </Button>
                {legacyMsg ? <span className="gh-msg">{legacyMsg}</span> : null}
              </Inline>
            }
          />
        ) : null}

        <SettingRow
          label="GitHub 身份"
          hint="用已授权的令牌调 gh api user 读取；提交邮箱取 GitHub noreply 格式。不隐式轮询，点按钮才跑。"
          control={
            <Inline gap="sm" align="center">
              <Button variant="secondary" disabled={identity.loading} onClick={loadIdentity}>
                {identity.loading ? "读取中…" : identity.data ? "刷新身份" : "读取身份"}
              </Button>
              {identity.data ? <MonoText>@{identity.data.login}</MonoText> : null}
            </Inline>
          }
        />
        {identity.data ? (
          <SettingRow label="提交者名字" control={<MonoText>{identity.data.name || "—"}</MonoText>} hint="推导链：显式参数 → 账号 name → login" />
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
          <SettingRow label="账号 ID" control={<MonoText>{identity.data.id === null ? "—" : String(identity.data.id)}</MonoText>} />
        ) : null}
        <SettingRow
          label="gh 认证"
          hint="跑一次 gh auth status；认证靠本 App 按次注入的 GH_TOKEN，不改你的全局 gh 配置。"
          control={
            <Inline gap="sm" align="center">
              <Button variant="secondary" disabled={ghBusy} onClick={runGhStatus}>
                {ghBusy ? "检测中…" : "检测认证"}
              </Button>
              {auth.known ? (
                <MonoText>
                  {auth.authed ? `已登录（${AUTH_SOURCE_LABEL[auth.source] || "来源未识别"}）` : "未登录"}
                </MonoText>
              ) : null}
            </Inline>
          }
        />
        {identity.text ? <pre className="gh-out">{identity.text}</pre> : null}
        {ghText ? <pre className="gh-out">{ghText}</pre> : null}
      </SettingsSection>

      <SettingsSection title="命令行工具" description="随 App 分发的内嵌二进制；缺失时回退系统 PATH。">
        <ToolRow label="git" tool={tools.git} />
        <ToolRow label="gh" tool={tools.gh} />
        <ToolRow label="gpg" tool={tools.gpg} />
      </SettingsSection>

      <SettingsSection
        title="隔离 GPG 签名身份"
        description="密钥只落在本 App 的数据目录，不碰系统或个人 GPG 环。生成后可自动把公钥发布到 GitHub 账号。"
      >
        <SettingRow
          label="公钥"
          control={<StatusText ok={Boolean(pk.present)} on="已生成" off="未生成" />}
          hint={pk.present ? null : "在下方点「生成 / 轮换密钥」初始化"}
        />
        {pk.keyId ? <SettingRow label="密钥 ID" control={<MonoText>{pk.keyId}</MonoText>} /> : null}
        {showFpr && pk.fpr ? (
          <SettingRow label="完整指纹" truncateText control={<MonoText>{pk.fpr}</MonoText>} />
        ) : null}
        {pk.uid ? <SettingRow label="身份（UID）" control={<MonoText>{pk.uid}</MonoText>} /> : null}

        <SettingRow
          label="GitHub 发布状态"
          control={
            published.published ? (
              <StatusText ok on="已发布" off="未发布" />
            ) : (
              <StatusText ok={false} on="已发布" off="未发布" />
            )
          }
          hint="轮换时只会删除本 App 上一次上传的那一把公钥，绝不触碰账号上其它 GPG 密钥。"
        />
        {published.keyId ? <SettingRow label="已发布 key_id" control={<MonoText>{published.keyId}</MonoText>} /> : null}
        {published.gpgKeyId ? <SettingRow label="公钥 ID（页面展示）" control={<MonoText>{published.gpgKeyId}</MonoText>} /> : null}
        {published.uploadedAt ? <SettingRow label="上传时间" control={<MonoText>{formatTime(published.uploadedAt)}</MonoText>} /> : null}
        {published.login ? <SettingRow label="对应账号" control={<MonoText>@{published.login}</MonoText>} /> : null}

        <SettingRow
          label="生成 / 轮换密钥"
          layout="stacked"
          hint="不可逆：轮换后 GitHub 上已发布的旧公钥会被自动替换。身份不填时用已授权的账号自动推导。"
          control={
            <Grid columns={2} gap="sm">
              <TextInput
                value={kgName}
                autoComplete="off"
                placeholder="提交者名字（可选）"
                aria-label="提交者名字"
                onChange={(e) => setKgName(e.target.value)}
              />
              <TextInput
                value={kgEmail}
                autoComplete="off"
                placeholder="提交者邮箱（可选）"
                aria-label="提交者邮箱"
                onChange={(e) => setKgEmail(e.target.value)}
              />
            </Grid>
          }
        />
        <SettingRow
          label="密钥操作"
          control={
            <Inline gap="sm" align="center" wrap>
              {kgConfirm ? (
                <>
                  <span className="gh-msg">确认生成 / 轮换？旧密钥将被清空</span>
                  <Button variant="danger" disabled={kgBusy} onClick={runKeygen}>
                    {kgBusy ? "执行中…" : "确认执行"}
                  </Button>
                  <Button variant="secondary" disabled={kgBusy} onClick={() => setKgConfirm(false)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button variant="primary" disabled={kgBusy} onClick={() => setKgConfirm(true)}>
                  生成 / 轮换密钥
                </Button>
              )}
              <Button variant="secondary" disabled={!pk.present} onClick={toggleKeyText}>
                {showKey ? "收起公钥" : "查看公钥"}
              </Button>
              <Button variant="secondary" disabled={!pk.fpr} onClick={() => setShowFpr((v) => !v)}>
                {showFpr ? "收起指纹" : "查看指纹"}
              </Button>
              <Button variant="secondary" disabled={!pk.present} onClick={copyPubkey}>
                复制公钥
              </Button>
              {copyMsg ? <span className="gh-msg">{copyMsg}</span> : null}
            </Inline>
          }
        />
        <SettingRow
          label="GitHub 公钥操作"
          hint="上传失败时可在这里手动重试；「从 GitHub 移除」只删除本 App 发布记录里的那一把。"
          control={
            <Inline gap="sm" align="center" wrap>
              <Button variant="secondary" disabled={pubBusy || !pk.present} onClick={publishPubkey}>
                {pubBusy ? "处理中…" : "上传公钥"}
              </Button>
              <Button variant="secondary" disabled={pubBusy || !published.published} onClick={unpublishPubkey}>
                从 GitHub 移除
              </Button>
            </Inline>
          }
        />
        {showKey ? <pre className="gh-out">{keyText || "读取中…"}</pre> : null}
        {pubText ? <pre className="gh-out">{pubText}</pre> : null}
        {kgText ? <pre className="gh-out">{kgText}</pre> : null}
      </SettingsSection>

      <SettingsSection title="数据目录" description="隔离 gitconfig、GPG 环（gnupg/）与加密后的凭据（credential.json）都落在这里。">
        <SettingRow label="路径" truncateText control={<MonoText title={status.dataDir || ""}>{status.dataDir || "—"}</MonoText>} />
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
