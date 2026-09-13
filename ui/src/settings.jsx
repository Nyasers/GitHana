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
 *   GET  /api/apps/githana/routes/settings/state   → 认证状态 + 环境状态 + 令牌保护信息
 *   POST /api/apps/githana/routes/settings/token   → 保存 / 清除令牌（服务端加密落盘）
 *   GET  /api/apps/githana/routes/actions/*        → 身份 / gh 状态 / 公钥 / 生成密钥
 * 令牌**不经过宿主设置表**：App 侧用平台加密后端（Windows = DPAPI CurrentUser）写进自己的
 * 数据目录，页面只显示「配没配 / 怎么保护的 / 放在哪」，不回显明文。
 */
import { useCallback, useEffect, useState } from "react";
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
  if (!res.ok) throw new Error(data.text || data.error || `HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(data.text || data.error || `HTTP ${res.status}`);
  return data;
}

/** 凭据来源的人类可读名（来源由 gh 输出里的括号标注推断）。 */
const AUTH_SOURCE_LABEL = { env: "本 App 注入的 token", keyring: "系统 keyring", file: "配置文件明文" };

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

/** 状态短语：已配置 / 未配置。 */
function StatusText({ ok, on, off }) {
  return <span className={ok ? "gh-val gh-ok" : "gh-val gh-off"}>{ok ? on : off}</span>;
}

/** 等宽的值文本（版本号、路径、指纹）。 */
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

function GitHanaSettings() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // 令牌：页面只做一次性输入 → 服务端加密落盘；不回显已存值。
  const [token, setToken] = useState("");
  const [saveStatus, setSaveStatus] = useState("idle");
  const [message, setMessage] = useState(null);

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
  const [keyText, setKeyText] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);

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

  /** 保存令牌：服务端用平台加密后端写进 App 数据目录，并清掉旧版明文配置。
   *  空值**不**清空已有令牌：输入框永远不回显旧值，误按保存（或回车）就会静默清掉凭据。
   *  清除是显式动作，走「清除」按钮（传 { clear: true }）。 */
  const submit = useCallback(
    async (value, opts = {}) => {
      const text = String(value || "").trim();
      if (!text && !opts.clear) {
        setSaveStatus("idle");
        setMessage("请输入令牌；要清除已有令牌请点「清除」。");
        return;
      }
      setSaveStatus("saving");
      setMessage(null);
      try {
        const res = await postJson("settings/token", { token: text });
        setToken("");
        setSaveStatus("saved");
        setMessage(text ? "已加密保存" : "已清除");
        setState((prev) => (prev ? { ...prev, tokenConfigured: Boolean(res.tokenConfigured) } : prev));
        setAuth({ known: false, authed: false, source: null });
        setIdentity({ loading: false, data: null, text: null });
        setIdentityTried(false);
        await refresh();
      } catch (e) {
        setSaveStatus("idle");
        setMessage(`保存失败：${String((e && e.message) || e)}`);
      }
    },
    [refresh],
  );

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
        // 所以这里宁可报「注入的 token」，也不留一个「来源：未知」让人怀疑令牌没生效。
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
    try {
      const res = await postJson("actions/keygen", { name: kgName.trim(), email: kgEmail.trim() });
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
  }, [kgName, kgEmail, refresh]);

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

  // token 已配置且还没读过身份时，自动读一次（失败不重试，用户可手动点）。
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

  return (
    <SettingsPage>
      <SettingsSection
        title="GitHub 认证"
        description="令牌用于按次注入 GH_TOKEN（gh CLI 认证）与推导提交者身份。它不进宿主设置表，而是由本 App 用自己的数据目录 + 平台加密后端保存。"
      >
        <SettingRow
          label="认证状态"
          control={<StatusText ok={state.tokenConfigured} on="已配置" off="未配置" />}
          hint={state.tokenConfigured ? "gh 调用时会带上 GH_TOKEN" : "留空则生成密钥时需显式传邮箱"}
        />
        <SettingRow
          label="令牌保护"
          control={<MonoText>{protectionLabel(secret.protection)}</MonoText>}
          hint={secret.location ? `存放：${secret.location}` : null}
        />
        {secret.readable === false && secret.configured ? (
          <SettingRow
            label="提示"
            hintVariant="warn"
            hint="当前后端读不出这份密文（可能是别的平台加密写入的）。重新保存一次即可迁移到本机后端。"
            control={<MonoText>需重新保存</MonoText>}
          />
        ) : null}
        {secret.backendAvailable === false ? (
          <SettingRow
            label="提示"
            hintVariant="warn"
            hint="本平台暂无可用的加密后端，保存会被拒绝（不会以明文落盘）。macOS / Linux 后端待接。"
            control={<MonoText>无加密后端</MonoText>}
          />
        ) : null}
        <SettingRow
          label="个人访问令牌"
          layout="stacked"
          hint="已存值不回显；换新令牌 = 粘贴后保存（输入框为空时不会清空已有令牌）。"
          control={
            <TextInput
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴新的 GitHub PAT"
              aria-label="GitHub 个人访问令牌"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveStatus !== "saving") submit(token.trim());
              }}
            />
          }
        />
        <SettingRow
          label="令牌操作"
          control={
            <Inline gap="sm" align="center">
              <SaveButton
                status={saveStatus}
                labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
                onSavedFeedbackEnd={() => setSaveStatus("idle")}
                disabled={saveStatus === "saving" || secret.backendAvailable === false}
                onClick={() => submit(token)}
              />
              <Button
                variant="secondary"
                disabled={saveStatus === "saving" || secret.tokenConfigured !== true}
                onClick={() => submit("", { clear: true })}
              >
                清除
              </Button>
              {message ? <span className="gh-msg">{message}</span> : null}
            </Inline>
          }
        />
        <SettingRow
          label="GitHub 身份"
          hint="用已配置的令牌调 gh api user 读取；提交邮箱取 GitHub noreply 格式。不隐式轮询，点按钮才跑。"
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
        description="密钥只落在本 App 的数据目录，不碰系统或个人 GPG 环。"
      >
        <SettingRow
          label="公钥"
          control={<StatusText ok={Boolean(pk.present)} on="已生成" off="未生成" />}
          hint={pk.present ? null : "在下方点「生成 / 轮换密钥」初始化"}
        />
        {pk.fpr ? <SettingRow label="完整指纹" truncateText control={<MonoText title={pk.fpr}>{pk.fpr}</MonoText>} /> : null}
        {pk.uid ? <SettingRow label="身份（UID）" control={<MonoText>{pk.uid}</MonoText>} /> : null}

        <SettingRow
          label="生成 / 轮换密钥"
          layout="stacked"
          hint="不可逆：轮换后 GitHub 上已上传的旧公钥立即失效，需重新上传。身份不填时用已配置的 token 自动推导。"
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
              <Button variant="secondary" disabled={!pk.present} onClick={copyPubkey}>
                复制公钥
              </Button>
              {copyMsg ? <span className="gh-msg">{copyMsg}</span> : null}
            </Inline>
          }
        />
        {showKey ? <pre className="gh-out">{keyText || "读取中…"}</pre> : null}
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
