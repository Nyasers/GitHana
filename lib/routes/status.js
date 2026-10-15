// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/status.js — GitHana 环境状态端点（App v2）。
 *
 * 供 ui/main.html 页面卡消费：返回本 App 当前运行环境的可读快照——
 * token 是否配置、内嵌/系统 git 的可用性与版本、REST 通道是否就绪、隔离签名公钥是否存在。
 *
 * 全部是只读探测：resolveBin 只做路径存在性判断（安装目录内，许可根内）；
 * 版本探测经 runCli spawn `--version`（外部命令，不继承 Node 权限模型）。
 * 无外部副作用、无网络。
 *
 * 注册方式：app.js 的 ctx.routes.register → 公开 URL /api/apps/githana/routes/status。
 */
import fs from "node:fs";
import path from "node:path";
import {
  resolveBinExec,
  hostGitCandidates,
  hostResourceRoots,
  probeExecutable,
  readEnv,
  bundledBinRoot,
  pluginRoot,
} from "../../tools/lib/bin.js";
import { runCli } from "../../tools/lib/exec.js";
import { resolveRestWorker } from "../../tools/lib/rest.js";
import { BINARY_CHANNEL_NOTES } from "../../tools/lib/transfer.js";
import { shimPath } from "../../tools/lib/sign-shim.js";
import { initToolContext, getToolDataDir, getToolSecretToken } from "../../tools/lib/context.js";
import { collectPubkeyData } from "./pubkey.js";

/**
 * worker 出站白名单里「我们主动请求的面」（与 rest.worker.mjs 的 ALLOWED_HOSTS 逐字对应）。
 *
 * 它在这里是**报告值**而不是判据：真正的门在 worker 进程内（`--allow-net` 的收窄语法在
 * v26.8.1 不生效，见 rest.worker.mjs 头注）。写死一份是为了让状态页能如实显示，改动时要与
 * worker 那份一起改——selfcheck 不校验这条（它是展示，不是契约）。
 */
const REST_ALLOWED_HOSTS = ["api.github.com", "github.com", "uploads.github.com"];

/** 版本探测：spawn `<bin> --version`，取 stdout 首行；失败返回 null。 */
async function probeVersion(bin) {
  const r = await runCli(bin, ["--version"], { timeoutSec: 20 });
  if (!r.ok) return null;
  const line = String(r.stdout || r.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line || null;
}

/** 组装状态快照（纯只读）。 */
export async function collectStatus(appCtx) {
  await initToolContext(appCtx);
  const dataDir = getToolDataDir();

  const bins = {};
  // 只探测 git：签名已改由随包的纯 JS shim 完成（见 tools/lib/gpg.shim.mjs），
  // 不再有 gpg / gpgconf 可执行文件要解析。
  for (const bin of ["git"]) {
    // 用异步解析（含宿主 spawn 探活），否则会把宿主内嵌 git 误报成“非内嵌”。
    const r = await resolveBinExec(bin);
    bins[bin] = { source: r.source, bundled: r.source === "bundled", label: r.binLabel || null };
  }

  const gitVer = await probeVersion("git");

  // 签名链路就绪性：随包的两份文件在不在（都在许可根内，一次 fs 判定即可）。
  // gpg.shim.mjs 是签名入口，openpgp.min.mjs 是它运行期 import 的库——缺任一份签名都跑不起来，
  // 所以两项都报，而不是只报 shim（只报入口会让“库丢了”表现成安装包完整）。
  const shimFile = shimPath();
  const openpgpLibFile = path.join(pluginRoot(), "bin", "openpgp.min.mjs");
  const existsInRoot = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const shimPresent = existsInRoot(shimFile);
  const openpgpLibPresent = existsInRoot(openpgpLibFile);

  // REST 通道就绪性：worker 文件在不在（在就在本进程的许可根内，一次 fs 判定即可）。
  // GitHub 域已不依赖任何外部二进制，所以这一项取代了原先的 gh 探测。
  const restWorker = resolveRestWorker();

  // 令牌只在进程缓存里（DPAPI 解密结果，见 lib/secret.js）；宿主设置表不参与。
  const token = String(getToolSecretToken() || "").trim();
  const pub = collectPubkeyData(dataDir);

  // 宿主捆绑 git 的探测结果。两条结论都要报出来：
  //   - fs 探测：许可根外一律 ERR_ACCESS_DENIED（Node Permission Model）；
  //   - spawn 探活：外部命令不继承该模型，能起来就说明可用。
  const gitCandidates = hostGitCandidates();
  const fsProbe = (p) => {
    try {
      return { exists: !!fs.existsSync(p), denied: false };
    } catch (e) {
      return { exists: false, denied: true, code: (e && e.code) || null };
    }
  };
  const gitHostProbes = [];
  for (const c of gitCandidates) {
    const f = fsProbe(c.path);
    gitHostProbes.push({ path: c.path, fsExists: f.exists, fsDenied: f.denied, spawnProbe: await probeExecutable(c.path) });
  }
  let gitResolved = null;
  try {
    gitResolved = await resolveBinExec("git");
  } catch (e) {
    gitResolved = { cmd: null, source: "error", binLabel: String((e && e.message) || e) };
  }

  return {
    appId: "githana",
    dataDir: dataDir || null,
    // 插件根与它下面 bin/<平台>/ 的解析结果。这组值是"随包二进制找得到吗"的唯一现场证据：
    // 路径推导若与产物布局不一致（如入口搬到 bin/ 后根变了），这里会当场显形，
    // 而不只是表现成 tools 静默回落系统 PATH。
    resolution: {
      installRoot: pluginRoot(),
      binRoot: bundledBinRoot(),
      binRootExists: (() => { try { return fs.existsSync(bundledBinRoot()); } catch { return false; } })(),
    },
    tokenConfigured: token.length > 0,
    host: {
      platform: `${process.platform}-${process.arch}`,
      envFlags: {
        // 防御式读：AppHost 里读不存在的 env 键会抛错（不是 undefined）。
        HANA_DESKTOP_RESOURCES_PATH: !!readEnv("HANA_DESKTOP_RESOURCES_PATH"),
        HANA_ROOT: !!readEnv("HANA_ROOT"),
        HANA_HOME: !!readEnv("HANA_HOME"),
        HANA_LOCALE_DIR: !!readEnv("HANA_LOCALE_DIR"),
      },
      resourceRoots: hostResourceRoots(),
      gitHostProbes,
      hostGitUsable: gitHostProbes.some((p) => p.spawnProbe),
      gitResolved: {
        cmd: gitResolved.cmd,
        source: gitResolved.source,
        label: gitResolved.binLabel || null,
      },
    },
    tools: {
      git: { ...bins.git, version: gitVer },
    },
    // 签名链路：随包的纯 JS shim + 它运行期 import 的 OpenPGP.js 库文件（不再有 gpg / gpgconf）。
    signing: {
      shimPresent,
      shimPath: shimPresent ? shimFile : null,
      openpgpLibPresent,
      openpgpLibPath: openpgpLibPresent ? openpgpLibFile : null,
      backend: "openpgp.js",
    },
    // GitHub 域通道：自写 REST worker（随包）+ 它跑的 node 运行时版本。
    // 去 gh 之后这里不再有“外部二进制”这一层，所以报的是「worker 就绪吗 + 运行时是谁」。
    rest: {
      workerPresent: !!restWorker,
      workerPath: restWorker || null,
      runtimeVersion: process.version,
      // 出站白名单由 worker 进程内自查（不是 --allow-net 收窄），所以这里列出的是**生效的那份**
      // 里我们主动请求的面。重定向落点（codeload / release-assets / objects）与 Azure 后缀是另
      // 一条更宽的清单，只用于跳转目标，不列在这里以免把它读成「可以主动打这些域」。
      allowedHosts: REST_ALLOWED_HOSTS,
      // 二进制通道（资产上传 / 下载）的能力边界：这几条是机制说明，供设置页如实展示「能做什么」。
      binaryChannel: BINARY_CHANNEL_NOTES,
    },
    pubkey: {
      present: !!pub.hasKey,
      fpr: pub.fpr || null,
      keyId: pub.keyId || null,
      uid: pub.uid || null,
      // GitHub 侧的发布状态（本地发布记录；真实核对发生在上传/移除动作里）
      published: !!pub.published,
      publishedInfo: pub.publishedInfo || null,
    },
  };
}

/**
 * v2 registrar：把状态端点挂进宿主创建的 Hono sub-app。
 * @param {import("hono").Hono} app
 * @param {{ dataDir: string, appCtx: object }} deps
 */
export function registerStatusRoutes(app, { appCtx } = {}) {
  app.get("/status", async (c) => {
    try {
      return c.json(await collectStatus(appCtx));
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });
}
