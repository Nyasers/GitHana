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
 * 两条实测约束决定了这个形态（不是偏好）：
 *   1. GitHub 的 device/code 响应只有 `verification_uri`，**不返回** RFC 8628 的
 *      `verification_uri_complete`，所以没有「码已嵌好」的 URL 可用；
 *   2. `/login/device` 不接受 `?user_code=` 预填入参，码必须由用户手动粘/敲。
 *      gh 官方（cli/oauth + cli/cli 的 authflow）也是这么做的：打开裸 URL，再把码
 *      写进剪贴板让用户粘。这里沿用同一形态。
 *
 * 剪贴板优先走宿主的 `hana.clipboard.writeText`（设置页是 App iframe，有账本可查、
 * 拿得到宿主确认）；宿主不可用时回退浏览器原生 API。开外链同理走 `hana.external.open`，
 * 由宿主用系统默认浏览器打开，而不是 `window.open`。
 *
 * 两件事都不阻断授权：失败只回报文本，轮询照常进行——用户仍可手动打开/手动输码。
 */
async function sendToVerification(verificationUri, userCode) {
  const notes = [];

  try {
    const r = await hana.clipboard.writeText({ text: userCode });
    notes.push(r && r.written ? "验证码已复制到剪贴板" : "验证码未能复制，请手动输入");
  } catch {
    try {
      await navigator.clipboard.writeText(userCode);
      notes.push("验证码已复制到剪贴板");
    } catch {
      notes.push("验证码未能复制，请手动输入");
    }
  }

  try {
    const r = await hana.external.open({ url: verificationUri });
    notes.push(r && r.opened ? "已在浏览器打开验证页" : "请手动打开验证页");
  } catch {
    notes.push("未能自动打开浏览器，请手动打开验证页");
  }

  return notes.join("；");
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

  // device flow 授权
  const [oauth, setOauth] = useState(OAUTH_IDLE);
  const [remaining, setRemaining] = useState(0);
  const [handoff, setHandoff] = useState(null);
  const intervalRef = useRef(5);

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
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
    setOauth({ ...OAUTH_IDLE, starting: true });
    setNoticeMsg(null);
    setHandoff(null);
    try {
      const res = await postJson("actions/oauth/start", {});
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
      // 先把浏览器与剪贴板推给用户，再做别的：验证码有 15 分钟寿命，越早到手越好。
      setHandoff(await sendToVerification(res.verificationUri, res.userCode));
      await refresh();
    } catch (e) {
      setOauth({ ...OAUTH_IDLE, status: "error", error: String((e && e.message) || e) });
    }
  }, [refresh]);

  const cancelLogin = useCallback(() => {
    setOauth(OAUTH_IDLE);
    setHandoff(null);
  }, []);

  const revokeLogin = useCallback(async () => {
    setOauth(OAUTH_IDLE);
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
  const rest = status.rest || {};
  const signing = status.signing || {};
  const pk = status.pubkey || {};
  const published = (pk && pk.publishedInfo) || {};
  const authorized = !!state.tokenConfigured;
  const needsReauth = !!secret.needsReauth;
  const waiting = oauth.status === "waiting";

  return (
    <SettingsPage>
      <SettingsSection
        title="GitHub 账号"
        description="连接后，提交会用你的账号署名，签名公钥也直接发布到账号。"
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
              <Button variant={authorized ? "secondary" : "primary"} disabled={oauth.starting || waiting} onClick={startLogin}>
                {oauth.starting ? "正在打开…" : waiting ? "等待浏览器…" : authorized ? "重新登录" : "登录"}
              </Button>
              {waiting ? (
                <Button variant="secondary" onClick={cancelLogin}>
                  取消
                </Button>
              ) : null}
              {authorized && !waiting ? (
                <Button variant="ghost" onClick={revokeLogin}>
                  退出登录
                </Button>
              ) : null}
            </Inline>
          }
          hint={
            authorized
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
              hint="已复制到剪贴板，到浏览器页面粘贴并批准即可。"
              control={<span className="gh-usercode">{oauth.userCode}</span>}
            />
            <SettingRow
              label="剩余时间"
              control={<MonoText>{formatCountdown(remaining)}</MonoText>}
              hint={remaining <= 0 ? "已超时，请重新登录" : `${oauth.verificationUri || ""}（每 ${oauth.interval} 秒自动查询一次）`}
            />
            {handoff ? <SettingRow label="交接状态" control={<span className="gh-msg">{handoff}</span>} /> : null}
          </>
        ) : null}
        {oauth.status === "ready" ? (
          <SettingRow label="登录结果" hint="已取得令牌，可以生成密钥或发布公钥了。" control={<span className="gh-val gh-ok">登录成功</span>} />
        ) : null}
        {oauth.status === "error" && oauth.error ? <pre className="gh-out">{oauth.error}</pre> : null}
      </SettingsSection>

      <SettingsSection
        title="签名密钥"
        description="给提交签名。密钥只保存在 GitHana 自己的目录里，不动系统上的其它 GPG 密钥。"
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
                    {kgBusy ? "执行中…" : "确认重新生成（旧密钥作废）"}
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
                  {kgBusy ? "执行中…" : pk.present ? "重新生成密钥" : "生成签名密钥"}
                </Button>
              )}
              {pk.present ? (
                <Button variant="secondary" onClick={toggleKeyText}>
                  {showKey ? "收起公钥" : "查看公钥"}
                </Button>
              ) : null}
            </Inline>
          }
          hint={
            !authorized
              ? "先在上方登录 GitHub 账号；密钥的署名身份从那个账号推导。"
              : pk.present
                ? published.published
                  ? "提交会自动签名，并在 GitHub 上显示为 Verified。"
                  : "展开公钥可手动上传；在补齐之前，提交不会显示为 Verified。"
                : "生成后会直接发布到账号；两边始终一致，不会留单边残留。"
          }
        />
        {pk.present && pk.uid ? <SettingRow label="签名身份" control={<MonoText>{pk.uid}</MonoText>} /> : null}
        {showKey ? (
          <>
            <pre className="gh-out">{keyText || "读取中…"}</pre>
            <Inline gap="sm" align="center" wrap>
              <Button variant="secondary" onClick={copyPubkey}>
                复制公钥
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
              {copyMsg ? <span className="gh-msg">{copyMsg}</span> : null}
            </Inline>
          </>
        ) : null}
        {kgText ? <pre className="gh-out">{kgText}</pre> : null}
      </SettingsSection>

      {/* 收起时用 plain：容器内容高度归零，card 形态会留下一道 2px 高的空描边。
          展开后恢复 card，与其它区块外形一致。 */}
      <SettingsSection
        title="高级"
        description="一般不需要改动这里的任何东西。安装是否完整、签名与连网是否就绪，都在这一层，出问题时供排查。"
        surface={advancedOpen ? "card" : "plain"}
        context={
          <Button variant="secondary" onClick={() => setAdvancedOpen((v) => !v)}>
            {advancedOpen ? "收起" : "展开"}
          </Button>
        }
      >
        <Collapse open={advancedOpen}>
          <SettingsStack gap="md">
            {/* ── 账号与凭据明细 ── */}
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
              hint="点「读取」才向 GitHub 查一次；平时不会自行请求。"
            />
            {identity.data ? (
              <SettingRow label="提交者名字" control={<MonoText>{identity.data.name || "—"}</MonoText>} hint="账号 name 为空时用登录名" />
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
            {identity.text ? <pre className="gh-out">{identity.text}</pre> : null}

            {secret.expiresAt ? (
              <SettingRow label="登录到期" control={<MonoText>{formatTime(secret.expiresAt)}</MonoText>} />
            ) : null}
            {secret.refreshExpiresAt ? (
              <SettingRow label="续期凭证到期" control={<MonoText>{formatTime(secret.refreshExpiresAt)}</MonoText>} hint="到期后需重新登录" />
            ) : null}
            <SettingRow
              label="凭据保护方式"
              control={<MonoText>{protectionLabel(secret.protection)}</MonoText>}
              hint={secret.location ? `存放：${secret.location}` : null}
            />

            <SettingRow
              label="Client ID"
              control={<MonoText>{state.clientId || "—"}</MonoText>}
              hint="GitHana 注册的 GitHub App，权限与发布链路都绑在它上面，不开放修改。"
            />

            {/* ── 密钥明细 ── */}
            {pk.keyId ? <SettingRow label="密钥 ID" control={<MonoText>{pk.keyId}</MonoText>} /> : null}
            {pk.fpr ? <SettingRow label="完整指纹" truncateText control={<MonoText>{pk.fpr}</MonoText>} /> : null}
            {published.keyId ? <SettingRow label="已发布 key_id" control={<MonoText>{published.keyId}</MonoText>} /> : null}
            {published.uploadedAt ? <SettingRow label="上传时间" control={<MonoText>{formatTime(published.uploadedAt)}</MonoText>} /> : null}
            {published.login ? <SettingRow label="发布账号" control={<MonoText>@{published.login}</MonoText>} /> : null}
            <SettingRow
              label="密钥署名"
              hint="重新生成会作废旧密钥，并替换账号上本 App 发布的那一把，不可逆。"
              control={<MonoText>{pk.uid || "—"}</MonoText>}
            />
            {published.pending ? (
              <SettingRow
                label="待清理的旧公钥"
                hintVariant="warn"
                hint="下次上传或移除时会自动重试清理。"
                control={<MonoText>{published.pending} 把</MonoText>}
              />
            ) : null}
            {!published.published && pk.present ? (
              <SettingRow
                label="公钥未在账号上"
                hint="在补齐之前，提交不会显示为 Verified。可在这里补传（只影响本 App 自己那把）。"
                control={
                  <Button variant="secondary" disabled={pubBusy} onClick={publishPubkey}>
                    {pubBusy ? "处理中…" : "上传公钥"}
                  </Button>
                }
              />
            ) : null}
            {pubText ? <pre className="gh-out">{pubText}</pre> : null}

            {/* ── 运行环境 ── */}
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
            <SettingRow
              label="允许访问的域名"
              control={<MonoText>{(rest.allowedHosts || []).join(" · ") || "—"}</MonoText>}
              hint="主动请求只打这些域；下载时的 302 跳转另有一份更窄的白名单（release-assets.githubusercontent.com / objects.githubusercontent.com / *.blob.core.windows.net）。"
            />
            <SettingRow label="数据目录" truncateText control={<MonoText title={status.dataDir || ""}>{status.dataDir || "—"}</MonoText>} />
          </SettingsStack>
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
