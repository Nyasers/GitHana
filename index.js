// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * index.js — GitHana（githana）App v2 入口。
 *
 * 形态：宿主在隔离的 AppHost 子进程里加载本文件并调用 apply(ctx)（入口契约兼容具名
 * apply / default.apply / 默认函数，两种都导出）。apply 完成注册后立即返回，不等任何长活。
 *
 * 与 v1「full-access 插件」的差别（本次重制的核心）：
 *   - v1：manifest 无 contributes.tools，宿主自动扫描 tools/*.js 注册；entry 只挂卡路由。
 *   - v2：没有目录扫描，entry 必须在 apply 里逐个 ctx.tools.register；工具名全局唯一（无前缀）。
 *   因此本文件把 tools/ 下 9 个模块装配成注册表，execute 统一转成 v2 的「单参数调用」，
 *   并把 App 运行上下文（dataDir / 安装目录 / 设置通道）以第二个参数喂给既有的 v1 工具实现，
 *   让 tools/ 与 lib/ 的代码基本零改动复用（见 tools/lib/context.js 的契约）。
 *
 * v2 隔离进程的硬约束（APPS.md「执行模型与文件边界」）：
 *   - Node Permission Model：安装目录只读、{HANA_HOME}/app-data/githana 可写；
 *     许可根之外的裸 fs 读取会被运行时拒绝（tools/lib/exec.js 的 checkCwd 已对此显式放行）。
 *   - 裸 child_process 默认被拒；本 App 申请清单能力 `app/process.spawn` 后开
 *     `--allow-child-process`，git / gh / gpg 以外部命令运行，不继承 Node 权限模型，
 *     可自由访问任意仓库目录（这正是它们需要的边界）。
 *   - 出站 HTTP 走宿主动词（本 App 不需要：gh CLI 自己联网）。
 *
 * 数据与配置：
 *   - ctx.dataDir = {HANA_HOME}/app-data/githana（隔离 gitconfig / GNUPGHOME / 公钥落盘）。
 *   - token 走清单 contributes.settings 的 schema，运行期经 ctx.config 读（v2 唯一通道）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as gitExec from "./tools/git-exec.js";
import * as gitStatus from "./tools/git-status.js";
import * as gitLog from "./tools/git-log.js";
import * as gitCommit from "./tools/git-commit.js";
import * as gitPush from "./tools/git-push.js";
import * as ghExec from "./tools/gh-exec.js";
import * as ghPr from "./tools/gh-pr.js";
import * as gpgKeygen from "./tools/gpg-keygen.js";
import * as gpgPubkey from "./tools/gpg-pubkey.js";

// 路由模块放 lib/routes/：顶层 routes/ 是 v2 保留目录（形态互斥的另一种路由源），
// 本项目统一用 ctx.routes.register 单 bundle 形态，故顶层不放 routes/。
import { registerPubkeyRoutes } from "./lib/routes/pubkey.js";
import { registerStatusRoutes } from "./lib/routes/status.js";
import { registerSettingsRoutes } from "./lib/routes/settings.js";
import { registerActionRoutes } from "./lib/routes/actions.js";
import { setSecretLoader } from "./tools/lib/context.js";
import { loadSecretIntoContext } from "./lib/secret.js";

/** 安装目录（本文件所在目录）：vendor 二进制、routes、ui 的根。 */
const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 工具注册表（顺序即注册顺序；name 全局唯一，v2 不加前缀）。 */
const TOOLS = [gitExec, gitStatus, gitLog, gitCommit, gitPush, ghExec, ghPr, gpgKeygen, gpgPubkey];

/**
 * 把 v1 形态的 sessionPermission 收敛成跨 RPC 边界可传的纯数据字段。
 * 跨进程只认 readOnly / kind / auto / description / sideEffect，函数字段过不来；
 * 这里主动剥掉 describeSideEffect 等函数，避免宿主把整条声明当非法降级。
 */
function plainPermission(perm) {
  if (!perm || typeof perm !== "object") return undefined;
  if (perm.readOnly === true) return { readOnly: true };
  const out = {};
  if (typeof perm.kind === "string") out.kind = perm.kind;
  if (typeof perm.auto === "string") out.auto = perm.auto;
  if (typeof perm.description === "string") out.description = perm.description;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 把 v1 形态的工具返回值归一到 v2 的 { content, details } 形状。
 *
 * v1 工具的 execute 返回纯字符串（成功报告或可读错误都走同一个字符串通道）；
 * v2 宿主的 ui-actions 与模型循环都把返回值当普通对象，只取 .content / .details——
 * 字符串会被当成空对象吞成 `{}`。所以在这里统一升格：
 *   - 已经是带 content 的对象（如 gpg_pubkey 的 { content, details.card }）→ 原样透传；
 *   - 字符串 → { content: [{ type: "text", text }] }；
 *   - 其他可序列化值 → JSON 文本；null/undefined → 空文本。
 * 这样 tools/ 与 lib/ 的实现可以保持 v1 时的零改动。
 */
function toToolResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "content" in value) {
    return value;
  }
  let text;
  if (typeof value === "string") text = value;
  else if (value === undefined || value === null) text = "";
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return { content: [{ type: "text", text }] };
}

/**
 * App v2 主入口。注册 9 个工具 + 三条后端路由后立即返回；返回 disposer 供卸载/重载收尾。
 */
export function apply(ctx) {
  const dataDir = ctx && typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (!dataDir) throw new Error("githana apply: ctx.dataDir 缺失（宿主未提供数据目录）");

  const logger = ctx.logger || null;
  const log = (level, ...args) => {
    if (logger && typeof logger[level] === "function") {
      try { logger[level](...args); return; } catch { /* 宿主日志失败 → 回落 stderr */ }
    }
    try { console.error(`[githana] [${level}]`, ...args); } catch { /* 忽略 */ }
  };

  // 喂给既有工具实现的运行上下文（tools/lib/context.js 认 ctx.dataDir / ctx.pluginDir /
  // ctx.config.getAll）。settings 在 apply 完成后才登记，故这里只包一层惰性转发，不预取。
  const appCtx = {
    dataDir,
    pluginDir: INSTALL_DIR,
    logger,
    config: {
      getAll: () => {
        try {
          const all = ctx.config && typeof ctx.config.getAll === "function" ? ctx.config.getAll() : null;
          return all && typeof all === "object" && !Array.isArray(all) ? all : {};
        } catch {
          return {};
        }
      },
      get: (key) => {
        try {
          return ctx.config && typeof ctx.config.get === "function" ? ctx.config.get(key) : undefined;
        } catch {
          return undefined;
        }
      },
    },
  };

  // 令牌不进宿主设置表，而是加密落 App 数据目录（lib/secret.js，后端可插拔）。
  // 解密是异步的，而 buildBinEnv 必须同步拿到 GH_TOKEN；挂在 initToolContext 首次拉完
  // 配置之后（那时 ctx.config 已可读，旧版明文也能读出并迁移），只跑一次。
  setSecretLoader(() => loadSecretIntoContext(dataDir));

  const disposers = TOOLS.map((mod) =>
    ctx.tools.register({
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      sessionPermission: plainPermission(mod.sessionPermission),
      // v2 单参数调用：宿主传 { ...args, context: {...} }；第二个参数是我们的 App 运行上下文。
      // 返回值经 toToolResult 升格为 v2 的 { content, details } 形状（见上方注释）。
      execute: async (args) => toToolResult(await mod.execute(args, appCtx)),
    }),
  );
  log("info", `工具注册完成（${TOOLS.length} 个）：${TOOLS.map((m) => m.name).join(", ")}`);

  let unregisterRoutes = null;
  if (ctx.routes && typeof ctx.routes.register === "function") {
    unregisterRoutes = ctx.routes.register((app) => {
      registerPubkeyRoutes(app, { dataDir });
      registerStatusRoutes(app, { dataDir, appCtx });
      // 自定义设置页（ui/settings.html）的动态读写：页面不能直接碰 ctx.config，
      // 经 App 自己的已认证路由转发。令牌的写入口在这里（会走加密存储并迁移旧明文）。
      registerSettingsRoutes(app, {
        appCtx,
        dataDir,
        config: {
          set: (key, value) => ctx.config.set(key, value),
        },
      });
      // 设置页「手动档」：复用 Agent 工具本体，一套实现两个入口。
      registerActionRoutes(app, { appCtx, dataDir });
    });
    log("info", "路由注册：/routes/pubkey · /routes/status · /routes/settings/* · /routes/actions/*");
  } else {
    log("warn", "ctx.routes.register 缺失：公钥卡与状态页的数据端点不可用");
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers) {
      try { if (typeof d === "function") d(); } catch { /* 忽略 */ }
    }
    try { if (typeof unregisterRoutes === "function") unregisterRoutes(); } catch { /* 忽略 */ }
  };
}

export default { apply };
