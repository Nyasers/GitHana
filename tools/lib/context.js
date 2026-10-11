// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/context.js — 工具执行上下文单例（隔离配置底座）。
 *
 * 背景：
 * - ctx.dataDir 工具调用时注入；dev 槽带 dev 段（plugin-data/dev/<id>），正式安装为
 *   plugin-data/<id>。
 * - 宿主设置表不参与本 App 的配置：凭据加密落 App 数据目录（lib/secret.js），不走
 *   contributes.settings 的 schema 通道（v2 首个构建声明过 token 字段，其后撤掉）。
 *
 * 用法：工具 execute 开头 `await initToolContext(ctx)` 一次（登记 dataDir/pluginDir），
 * lib/exec.js（runCli 隔离 env 组装）与各工具同步读单例，避免处处 async 化。
 * 单例为进程级：同一插件实例内共享（插件单实例，dataDir 稳定，dsh 同款 getSingleton 模式）。
 *
 * secretToken：GitHub OAuth 令牌（`ghu_`）经 DPAPI 加密后落 App 自己的数据目录（lib/secret.js）。
 * 解密是异步的，而 buildBinEnv 必须在 spawn 前同步拿到 GH_TOKEN，所以解密结果写进本单例，
 * 工具只同步读。凭据只有 OAuth 一种：无凭据就不注入 GH_TOKEN，让 gh 自己回报「未登录」。
 *
 * oauthMeta：凭据记录里那份**非机密** meta（login / expiresAt / needsReauth…）。挂在单例上
 * 是为了让刷新逻辑（lib/oauth.js）不必反复解密就能判断「要不要刷新」。
 *
 * freshChecker：令牌保活回调（index.js 注册，指向 lib/oauth.js 的 ensureFresh）。刷新是异步的，
 * 同样塞不进同步的 buildBinEnv，所以挂在 initToolContext 里——那是每次工具/路由调用都会
 * await 一次的入口。刷新失败不抛异常（无其它凭据可降级，失败就是失败，后续 gh 调用会报未登录）。
 */
let state = { dataDir: "", pluginDir: "", secretToken: "", oauthMeta: null };

/**
 * 秘密加载器（由 index.js 注册，指向 lib/secret.js），以及「是否已加载」的一次性闩。
 *
 * 为什么挂在这里而不是 apply 里：解密要跑 powershell（DPAPI），而 spawn 前必须同步拿到
 * GH_TOKEN；所以推迟到首次工具/路由调用（initToolContext）时才跑，且只跑一次。
 */
let secretLoader = null;
let secretLoaded = false;

/** 令牌保活回调（每次 initToolContext 都跑；内部自行判断是否需要真正发请求）。 */
let freshChecker = null;

/** 注册/重置秘密加载器（index.js 在 apply 里调一次）。 */
export function setSecretLoader(fn) {
  secretLoader = typeof fn === "function" ? fn : null;
  secretLoaded = false;
}

/** 注册/重置令牌保活回调（index.js 在 apply 里调一次）。 */
export function setFreshChecker(fn) {
  freshChecker = typeof fn === "function" ? fn : null;
}

/**
 * 只登记运行上下文（dataDir / pluginDir），**不触发**任何加载动作（不解密凭据、不跑保活）。
 * 给 apply 阶段用：disposer 里要靠 dataDir 定位隔离环去收尾 gpg daemon（见 tools/lib/gpg-daemon.js），
 * 而 initToolContext 是异步的、还会拉起 DPAPI 解密——那里不合适。此处只写两个字符串，纯同步。
 */
export function primeToolContext(ctx) {
  if (ctx && ctx.dataDir !== undefined && ctx.dataDir !== null) {
    state.dataDir = String(ctx.dataDir);
  }
  if (ctx && ctx.pluginDir !== undefined && ctx.pluginDir !== null) {
    state.pluginDir = String(ctx.pluginDir);
  }
}

/**
 * 初始化上下文单例：记录 dataDir/pluginDir。
 * 幂等，可重复调用（后调覆盖先调）。
 *
 * 每次调用都：首次解密凭据（一次性）→ 令牌保活检查（每次都跑，内部按剩余有效期短路）。
 */
export async function initToolContext(ctx) {
  if (ctx && ctx.dataDir !== undefined && ctx.dataDir !== null) {
    state.dataDir = String(ctx.dataDir);
  }
  if (ctx && ctx.pluginDir !== undefined && ctx.pluginDir !== null) {
    state.pluginDir = String(ctx.pluginDir);
  }

  // 首次调用时把凭据解进进程缓存（DPAPI）。只跑一次。
  if (secretLoader && !secretLoaded) {
    secretLoaded = true;
    try {
      await secretLoader();
    } catch {
      /* 解不开就按未配置处理，让 gh 自己回报「未登录」 */
    }
  }

  // 令牌保活：剩余有效期不足阈值时用 refresh_token 换新（单飞，见 lib/oauth.js）。
  // 每次都跑，但内部先看 meta.expiresAt 短路，绝大多数调用不会发请求。
  // 失败绝不抛：刷新失败只是后续 gh 报未登录，不该阻断工具调用本身。
  if (freshChecker) {
    try {
      await freshChecker();
    } catch {
      /* 保活尽力而为 */
    }
  }
}

/** 当前插件数据目录（dev 槽带 dev 段；正式 = plugin-data/<id>）；未登记返回 "" */
export function getToolDataDir() {
  return state.dataDir;
}

/** 当前插件目录（工具代码所在）；未登记返回 "" */
export function getToolPluginDir() {
  return state.pluginDir;
}

/**
 * 当前进程内缓存的明文令牌（来自 DPAPI 解密）。未设置返回 ""。
 * 仅供 buildBinEnv 同步读取；不提供给工具返回/回显。
 */
export function getToolSecretToken() {
  return state.secretToken || "";
}

/** 写入/清除进程内令牌缓存（由 lib/secret.js 在加载/保存/清除后调用）。 */
export function setToolSecretToken(value) {
  state.secretToken = value ? String(value) : "";
}

/** 当前凭据的非机密 meta（login / expiresAt / needsReauth…）；无凭据返回 null。 */
export function getToolOAuthMeta() {
  return state.oauthMeta || null;
}

/** 写入/清除进程内 meta 缓存（由 lib/secret.js 在加载/保存/清除后调用）。 */
export function setToolOAuthMeta(meta) {
  state.oauthMeta = meta && typeof meta === "object" ? { ...meta } : null;
}
