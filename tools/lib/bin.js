// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/bin.js — git/gh/gpg/gpgconf 可执行文件解析（平台通用）。
 *
 * ## 目录布局（布局是数据，查找是代码）
 *
 * **仓库侧（sources.json 声明 / fetch-vendor 落盘 / selfcheck 校验）**：
 *   vendor/sources.json                        声明（入库）
 *   vendor/hana-app-sdk/                       SDK 快照（入库，构建期依赖）
 *   vendor/bin/<platform>-<arch>/<component>/  构建期缓存（不入库）
 *
 * **产物侧（本文件解析的就是这一侧）**：
 *   bin/<platform>-<arch>/<exe>                运行时二进制，平铺
 *
 * 两边形状**有意不同**：仓库那份是构建期缓存，按组件分目录是为了单组件能整体重抓；
 * 产物里没有“重抓某个组件”这件事，组件那一层就只剩噪音——装到机器上要的是“这个平台的
 * 二进制在哪”，`bin/<平台>/` 直接回答。构建期由 build-app 把两边投影过去。
 *
 * ## 解析链（按序探测，命中即用；全缺回退系统 PATH）
 *
 *   1) 宿主捆绑 git（Hana <resources>/git）——**只用 spawn 探活，不用 fs**
 *   2) 随包 bin/<平台>（许可根内，fs 判定）
 *   3) 系统 PATH
 *
 * 第 1 条为什么不能用 fs：AppHost 开了 Node Permission Model，宿主 resources 在许可根之外，
 * `fs.statSync/existsSync` 一律抛 ERR_ACCESS_DENIED（实测）。但 `app/process.spawn` 开的是
 * **子进程，外部命令不继承该模型**——所以正确的探活方式是"跑一次 --version，能起来就算存在"。
 * 这也是本次修正的核心：上一版只认 HANA_DESKTOP_RESOURCES_PATH，而 AppHost 根本不传它，
 * 于是宿主那份 git 永远找不到，白白随包扛着 90MB 的 MinGit。
 *
 * 不是每个平台都 vendor 每样东西：macOS/Linux 自带 git，硬塞 MinGit/Git for Windows 不合理。
 * `vendor/sources.json` 没声明的组件就是"本平台不内嵌、走系统 PATH"，与"声明了但没就绪"是两种状态。
 *
 * ## 隔离注入（applyPluginIsolation）
 *
 * buildBinEnv 每次 spawn 注入 GIT_CONFIG_GLOBAL=<dataDir>/gitconfig、GNUPGHOME=<dataDir>/gnupg、
 * GIT_TERMINAL_PROMPT=0；token 已配置时注入 GH_TOKEN（取 DPAPI 解密结果，见 lib/secret.js）。
 * dataDir 未登记时不注入——避免误碰用户默认 ~/.gitconfig / ~/.gnupg。
 *
 * PATH 也被就地收口：隔离生效时把 vendor gnupg/bin 前置进 PATH，并用 `GIT_CONFIG_*` 把
 * `gpg.program` 覆盖成当前安装的 vendor gpg 绝对路径——git 经它解析到的 gpg 必然是插件环那把
 * （认 GNUPGHOME env），且路径随安装现算，不会被 vendor 布局绑死。
 * 密钥生成侧不把 gpg.program 写进 gitconfig：工具面全部经本进程 spawn，覆盖值总在配置文件之上
 * 生效，文件里那份没有消费者。
 *
 * 平台注记：vendor 里的 gpg 必须是"认 GNUPGHOME env"的原生模式（Windows 上表现为删除
 * gpgconf.ctl，否则便携模式恒指 scoop home、忽略 GNUPGHOME）；POSIX 的系统 gpg 本就认。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getToolDataDir, getToolSecretToken } from "./context.js";

/** 插件根目录（bin.js 位于 <root>/tools/lib/，上两级即根） */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 宿主注入的 resources 根环境变量（v1 时代有；v2 AppHost 不传，仅作候选之一） */
const HOST_RESOURCES_ENV = "HANA_DESKTOP_RESOURCES_PATH";

const PLATFORM = process.platform; // win32 | darwin | linux
const isWindows = PLATFORM === "win32";
/** vendor 子目录名：平台-架构，例 win32-x64 / darwin-arm64 / linux-x64 */
export const VENDOR_PLATFORM_KEY = `${process.platform}-${process.arch}`;

/** 每个工具在各平台的可执行路径与 PATH 附加目录（只写"树内形态"）。
 *
 * 路径形态是 `bin/<平台>-<架构>/<exe>`：产物里二进制平铺，不再有组件那一层。
 * 编排参考：构建期 build-app 把仓库的 vendor/bin/<平台>/<组件>/ 投影到这里。
 *
 * git 条目**不描述随包内容**：MinGit 从不随包（sources.json 里已不再声明 git），App 始终用宿主
 * 那份 `<HANA_ROOT>/resources/git`。这里的 git 条目服务的是**宿主 git 的树内形态**——
 * finish() 用 extraPath 把它自带的 cmd/ 与 mingw64/bin 等目录前置进 PATH，否则 git 找不到
 * 自己的子命令与 gpg。不要因“不随包”就删掉这条。
 */
export const VENDOR_LAYOUT = {
  win32: {
    git: { exe: "cmd/git.exe", extraPath: ["cmd", "mingw64", "bin", "usr", "bin"] },
    gh: { exe: "gh.exe" },
    gpg: { exe: "gpg.exe" },
    gpgconf: { exe: "gpgconf.exe" },
  },
  darwin: {
    git: { exe: "bin/git", extraPath: ["bin", "libexec/git-core"] },
    gh: { exe: "gh" },
    gpg: { exe: "gpg" },
    gpgconf: { exe: "gpgconf" },
  },
  linux: {
    git: { exe: "bin/git", extraPath: ["bin", "libexec/git-core"] },
    gh: { exe: "gh" },
    gpg: { exe: "gpg" },
    gpgconf: { exe: "gpgconf" },
  },
};

/**
 * 工具名（resolveBin 的 bin）→ vendor 组件目录名（vendor/sources.json 的 components 键）。
 * 同义不同名：gpg 与 gpgconf 两个可执行文件同出 GnuPG 一份组件目录，而该目录在 sources.json
 * 与 fetch-vendor 落盘里叫 gnupg。查找必须按组件目录名走——按工具名拼路径会永远探空、静默
 * 回退系统 gpg（Windows 上带 gpgconf.ctl 的便携版忽略 GNUPGHOME → 签名 No secret key）。
 */
export const VENDOR_COMPONENT = { gpg: "gnupg", gpgconf: "gnupg" };

/** 工具名 → vendor 组件目录名（未登记的工具名与目录同名，如 git / gh）。 */
function componentFor(bin) {
  return VENDOR_COMPONENT[bin] || bin;
}

function layoutFor(bin) {
  const table = VENDOR_LAYOUT[PLATFORM];
  return table && table[bin] ? table[bin] : null;
}

/** 产物侧二进制所在处：bin/<平台-架构>/（平铺，无组件层）。 */
function vendorRoots(bin) {
  return [path.join(PLUGIN_ROOT, "bin", VENDOR_PLATFORM_KEY)];
}

/** 去掉末尾 n 段路径（安全版，段数不够返回原值）。 */
function dropSegments(p, n) {
  let cur = p;
  for (let i = 0; i < n; i += 1) {
    const next = path.dirname(cur);
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * 防御式读环境变量。
 * AppHost 里的 process.env 只暴露宿主挑好的键，**读不存在的键会抛错**
 * （实测消息形如 "HANA_DESKTOP_RESOURCES_PATH is not defined"），不是返回 undefined。
 */
export function readEnv(name) {
  try {
    const v = process.env[name];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * 宿主 resources 根候选（按可信度排序）：显式环境变量 → HANA_ROOT/HANA_HOME →
 * HANA_LOCALE_DIR 反推 → dataDir 反推（<HANA_HOME>/app-data/<id> 上两级 = HANA_HOME）。
 */
export function hostResourceRoots() {
  const roots = [];
  const push = (p) => {
    if (p && typeof p === "string" && !roots.includes(p)) roots.push(p);
  };

  push(readEnv(HOST_RESOURCES_ENV));
  const hanaRoot = readEnv("HANA_ROOT");
  if (hanaRoot) push(path.join(hanaRoot, "resources"));
  const hanaHome = readEnv("HANA_HOME");
  if (hanaHome) {
    push(path.join(hanaHome, "resources"));
    push(path.join(dropSegments(hanaHome, 1), "resources"));
  }
  const localeDir = readEnv("HANA_LOCALE_DIR");
  if (localeDir) push(path.join(dropSegments(localeDir, 3), "resources"));
  const dataDir = getToolDataDir();
  if (dataDir) {
    const home = dropSegments(dataDir, 2);
    push(path.join(home, "resources"));
    push(path.join(dropSegments(home, 1), "resources"));
  }
  return roots;
}

/** 宿主捆绑 git 的候选（含 git 根，供 PATH 附加）。 */
export function hostGitCandidates() {
  const out = [];
  for (const res of hostResourceRoots()) {
    const root = path.join(res, "git");
    const rels = isWindows ? ["cmd/git.exe"] : ["bin/git", "cmd/git"];
    for (const r of rels) out.push({ path: path.join(root, ...r.split("/")), root, from: res });
  }
  return out;
}

/** 宿主内嵌候选：目前宿主只捆绑 git。 */
function hostCandidates(bin) {
  if (bin !== "git") return [];
  return hostGitCandidates().map((c) => ({ ...c, label: "宿主内嵌 git", host: true }));
}

/** 随包 vendor 候选（路径拼接，不碰 fs）。 */
function vendorCandidates(bin) {
  const layout = layoutFor(bin);
  if (!layout) return [];
  return vendorRoots(bin).map((root) => ({
    path: path.join(root, layout.exe),
    label: `内嵌 ${bin}`,
    root,
  }));
}

/** fs 安全存在性（仅许可根内可靠；被拒 → false）。 */
function safeExists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 组装 resolved 对象。 */
function finish(bin, c) {
  const layout = layoutFor(bin);
  const extraPath = c.root && layout && layout.extraPath ? layout.extraPath.map((p) => path.join(c.root, p)) : [];
  return { cmd: c.path, source: "bundled", binLabel: c.label, extraPath, bundledRoot: c.root || null };
}

/** 系统 PATH 兜底。 */
function systemFallback(bin) {
  return { cmd: isWindows ? bin + ".exe" : bin, source: "system", binLabel: null, bundledMissing: true };
}

/** spawn 探活缓存：同一路径本进程内只探一次。 */
const probeCache = new Map();

/**
 * spawn 探活：跑一次 `<file> --version`，能起来就算存在（非零退出也算，只关心"能否启动"）。
 * 这是许可根外唯一可行的探测手段。
 */
export function probeExecutable(file, timeoutMs = 8000) {
  if (probeCache.has(file)) return Promise.resolve(probeCache.get(file));
  const p = new Promise((resolve) => {
    let child = null;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        if (child) child.kill();
      } catch {
        /* 已退出 */
      }
      resolve(ok);
    };
    try {
      child = spawn(file, ["--version"], { windowsHide: true, stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    child.on("spawn", () => done(true));
    child.on("error", () => done(false));
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
  probeCache.set(file, p);
  return p;
}

/**
 * 同步解析（仅许可根内可用 fs）：vendor → 系统 PATH。
 * 给"必须同步"的调用点用（如 gpgconf 是否来自 vendor 的判定）；外部命令解析走 resolveBinExec。
 */
export function resolveBin(bin) {
  for (const c of vendorCandidates(bin)) {
    if (safeExists(c.path)) return finish(bin, c);
  }
  return systemFallback(bin);
}

/**
 * 异步解析（runCli 用）：
 *   1) 宿主内嵌（fs 被拒 → spawn 探活）
 *   2) 随包 vendor（许可根内，fs 判定）
 *   3) 系统 PATH
 * 宿主优先：用 Hana 自带的那份，省下随包分发的同类二进制；探活结果按进程缓存。
 */
export async function resolveBinExec(bin) {
  for (const c of hostCandidates(bin)) {
    if (await probeExecutable(c.path)) return finish(bin, c);
  }
  for (const c of vendorCandidates(bin)) {
    if (safeExists(c.path)) return finish(bin, c);
  }
  return systemFallback(bin);
}

/**
 * 给 gh 的惰性占位令牌。
 *
 * `gh api` 在**没有任何凭据**时会直接拒绝（exit 4，提示先 `gh auth login`），
 * 连不需要认证的端点也不发请求。而 device flow 的第一步（取设备码）恰恰发生在
 * 「还没有凭据」的时候——鸡生蛋。
 *
 * 两个 OAuth 端点（`github.com/login/device/code`、`github.com/login/oauth/access_token`）
 * 实测不校验 Authorization（换任何非空值响应结构一致），所以给 gh 一个固定占位值让它放行。
 * 它是常量、不是凭据，因此把**真令牌送到非 API 端点**这个风险仍然被挡住。
 */
export const INERT_GH_TOKEN = "hana-githana-auth-placeholder";

/**
 * 构造子进程 env：在继承 env 基础上注入 bundled 需要的 PATH（git 的 cmd/mingw64/usr）+ 隔离 env。
 * @param {*} baseEnv 继承的基础 env（process.env 副本）
 * @param {ReturnType<typeof resolveBinExec>} resolved resolveBin 结果（source=bundled 时生效）
 * @param {{ omitToken?: boolean, inertToken?: boolean }} [options]
 *   omitToken=true 时不注入任何 GH_TOKEN（跑与 GitHub 无关的子进程时用，
 *     如 DPAPI 走的 powershell——不给它无关凭据）；
 *   inertToken=true 时注入 INERT_GH_TOKEN（给必须“看似已登录”才肯跑、
 *     但实际不需要认证的 gh 调用用，见该常量的说明）。
 */
export function buildBinEnv(baseEnv, resolved, { omitToken = false, inertToken = false } = {}) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  if (resolved.source === "bundled" && resolved.extraPath && resolved.extraPath.length > 0) {
    env.PATH = resolved.extraPath.join(path.delimiter) + path.delimiter + (env.PATH || "");
  }
  const dataDir = getToolDataDir();
  if (dataDir) {
    env.GIT_CONFIG_GLOBAL = path.join(dataDir, "gitconfig");
    env.GNUPGHOME = path.join(dataDir, "gnupg");
    // PATH 收口：把 vendor gnupg/bin 前置，使「PATH 里的 gpg」就是隔离环那把。
    // 覆盖 gpg.program 写成裸名（"gpg.exe"）的历史配置：裸名走 PATH → 命中 vendor（认 GNUPGHOME），
    // 不再落系统 scoop gpg（gpgconf.ctl 便携模式忽略 GNUPGHOME → 签名 No secret key）。
    const vendorGpg = resolveBin("gpg");
    if (vendorGpg.source === "bundled" && vendorGpg.cmd) {
      env.PATH = path.dirname(vendorGpg.cmd) + path.delimiter + (env.PATH || "");
      // gpg.program 运行时覆盖：**不依赖** app-data/gitconfig 里存的值。
      // 那份文件跨安装存活（宿主卸载时 app data was kept），存绝对路径会被 vendor 布局绑死——
      // 包一换布局（如平台目录收进 vendor/bin/），旧路径就指向不存在的位置，签名报 cannot spawn。
      // 这里每次 spawn 都用当前解析到的 vendor gpg 现算并覆盖，路径永远与本次安装一致。
      // 走 git 的 GIT_CONFIG_* 机制（git ≥ 2.31）：它在所有配置文件之上生效，改不到文件也不脏文件。
      const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
      const n = Number.isFinite(baseCount) && baseCount >= 0 ? baseCount : 0;
      env.GIT_CONFIG_COUNT = String(n + 1);
      env[`GIT_CONFIG_KEY_${n}`] = "gpg.program";
      env[`GIT_CONFIG_VALUE_${n}`] = vendorGpg.cmd;
    }
  }
  // GH_TOKEN 与 dataDir 无关：占位值是常量，真令牌为空时不注入（让 gh 自己报未登录）。
  if (inertToken) {
    // gh 必须有“凭据”才肯发请求，而两个 OAuth 端点不校验它——给固定占位值放行。
    env.GH_TOKEN = INERT_GH_TOKEN;
  } else if (!omitToken) {
    const token = getToolSecretToken();
    if (token) env.GH_TOKEN = token;
  }
  return env;
}
