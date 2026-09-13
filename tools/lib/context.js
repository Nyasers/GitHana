// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/context.js — 工具执行上下文单例（隔离配置底座）。
 *
 * 背景：
 * - ctx.dataDir 工具调用时注入；dev 槽带 dev 段（plugin-data/dev/<id>），正式安装为
 *   plugin-data/<id>。
 * - 宿主设置表不参与本 App 的配置：令牌加密落 App 数据目录（lib/secret.js），不走
 *   contributes.settings 的 schema 通道（v2 首个构建声明过 token 字段，其后撤掉）。
 *
 * 用法：工具 execute 开头 `await initToolContext(ctx)` 一次（登记 dataDir/pluginDir），
 * lib/exec.js（runCli 隔离 env 组装）与各工具同步读单例，避免处处 async 化。
 * 单例为进程级：同一插件实例内共享（插件单实例，dataDir 稳定，dsh 同款 getSingleton 模式）。
 *
 * secretToken：GitHub 令牌 DPAPI 加密后落 App 自己的数据目录（lib/secret.js）。解密是异步的，
 * 而 buildBinEnv 必须在 spawn 前同步拿到 GH_TOKEN，所以解密结果在启动时（index.js 的
 * setSecretLoader）写入本单例，工具只同步读。
 */
let state = { dataDir: "", pluginDir: "", secretToken: "" };

/**
 * 秘密加载器（由 index.js 注册，指向 lib/secret.js），以及「是否已加载」的一次性闩。
 *
 * 为什么挂在这里而不是 apply 里：解密要跑 powershell（DPAPI），而 spawn 前必须同步拿到
 * GH_TOKEN；所以推迟到首次工具/路由调用（initToolContext）时才跑，且只跑一次。
 */
let secretLoader = null;
let secretLoaded = false;

/** 注册/重置秘密加载器（index.js 在 apply 里调一次）。 */
export function setSecretLoader(fn) {
  secretLoader = typeof fn === "function" ? fn : null;
  secretLoaded = false;
}

/**
 * 初始化上下文单例：记录 dataDir/pluginDir。
 * 幂等，可重复调用（后调覆盖先调）。
 */
export async function initToolContext(ctx) {
  if (ctx && ctx.dataDir !== undefined && ctx.dataDir !== null) {
    state.dataDir = String(ctx.dataDir);
  }
  if (ctx && ctx.pluginDir !== undefined && ctx.pluginDir !== null) {
    state.pluginDir = String(ctx.pluginDir);
  }

  // 首次调用时把令牌解进进程缓存（DPAPI）。只跑一次。
  if (secretLoader && !secretLoaded) {
    secretLoaded = true;
    try {
      await secretLoader();
    } catch {
      /* 解不开就按未配置处理，让 gh 自己回报「未登录」 */
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
 * 当前进程内缓存的明文令牌（来自 DPAPI 解密，或旧版明文配置的迁移）。未设置返回 ""。
 * 仅供 buildBinEnv 同步读取；不提供给工具返回/回显。
 */
export function getToolSecretToken() {
  return state.secretToken || "";
}

/** 写入/清除进程内令牌缓存（由 lib/secret.js 在 warm/save/clear 后调用）。 */
export function setToolSecretToken(value) {
  state.secretToken = value ? String(value) : "";
}
