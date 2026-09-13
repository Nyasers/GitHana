// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/status.js — GitHana 环境状态端点（App v2）。
 *
 * 供 ui/main.html 页面卡消费：返回本 App 当前运行环境的可读快照——
 * token 是否配置、内嵌/系统 git / gh / gpg 的可用性与版本、隔离签名公钥是否存在。
 *
 * 全部是只读探测：resolveBin 只做路径存在性判断（安装目录内，许可根内）；
 * 版本探测经 runCli spawn `--version`（外部命令，不继承 Node 权限模型）。
 * 无外部副作用、无网络。
 *
 * 注册方式：index.js 的 ctx.routes.register → 公开 URL /api/apps/githana/routes/status。
 */
import fs from "node:fs";
import {
  resolveBinExec,
  hostGitCandidates,
  hostResourceRoots,
  probeExecutable,
  readEnv,
} from "../../tools/lib/bin.js";
import { runCli } from "../../tools/lib/exec.js";
import { initToolContext, getToolDataDir, getToolSecretToken } from "../../tools/lib/context.js";
import { collectPubkeyData } from "./pubkey.js";

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
  for (const bin of ["git", "gh", "gpg", "gpgconf"]) {
    // 用异步解析（含宿主 spawn 探活），否则会把宿主内嵌 git 误报成“非内嵌”。
    const r = await resolveBinExec(bin);
    bins[bin] = { source: r.source, bundled: r.source === "bundled", label: r.binLabel || null };
  }

  const [gitVer, ghVer, gpgVer] = await Promise.all([
    probeVersion("git"),
    probeVersion("gh"),
    probeVersion("gpg"),
  ]);

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
      gh: { ...bins.gh, version: ghVer },
      gpg: { ...bins.gpg, version: gpgVer },
      gpgconf: bins.gpgconf,
    },
    pubkey: {
      present: !!pub.hasKey,
      fpr: pub.fpr || null,
      uid: pub.uid || null,
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
