// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/bin.js — git 可执行文件解析（平台通用）。
 *
 * gpg / gpgconf 不在此列：签名已改由随包的纯 JS shim 完成（tools/lib/gpg.shim.mjs），
 * 包内不再内嵌任何二进制。GitHub 域也不走外部二进制（REST worker 在子进程里直发）。
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
 * ## 隔离与签名注入（buildBinEnv）
 *
 * buildBinEnv 每次 spawn 注入 GIT_CONFIG_GLOBAL=<dataDir>/gitconfig 与 GIT_TERMINAL_PROMPT=0，
 * 并把 `gpg.program` 覆盖成**随包的签名 shim**（tools/lib/sign-shim.js 生成的包装脚本）。
 * 同时把 TMPDIR/TMP/TEMP 收进 <dataDir>/.runtime-tmp（见 ensureTmpDir）。
 * dataDir 未登记时不注入——避免误碰用户默认 ~/.gitconfig。
 *
 * 不再有 GNUPGHOME：gpg 二进制不在包里了，那套隔离机制（gpgconf.ctl、agent 收尾）随之消失。
 * gpg.program 的路径每次 spawn 现算，不会被安装位绑死。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getToolDataDir } from "./context.js";
import { ensureWrapper, keyFilePath } from "./sign-shim.js";

/**
 * 插件根目录（安装目录）。
 *
 * **定义式推导：从入口所在目录向上找 `manifest.json`**——manifest 就在安装根，这是"安装根"的
 * 根本定义，不依赖入口的层数、也不依赖任何宿主字段。两种形态自动都对：
 *   · 源码树：入口是 <repo>/app.js（与 manifest.json 同级）→ 一级不找即命中；
 *   · 交付产物：入口是 <install>/bin/app.mjs → `bin/` 里没有，上一步命中 <install>。
 *
 * 为什么不靠 `ctx.pluginDir`（曾经试过）：它给的是**源码树路径**而不是安装目录
 * （真机实测：装到 <HANA_HOME>/apps/githana 后，该字段仍报开发仓库的绝对路径），
 * 按它算 `bin/<平台>/` 会永远探空、静默回落系统 PATH——"装好了却用着系统那份"。
 *
 * 为什么不数固定层数：产物布局一改（单入口后入口进了 bin/）就指错，而 manifest.json 的位置
 * 不会因布局变化而漂。
 *
 * **惰性 + 记忆化**：不在模块加载期探 fs。交付形态下本文件处在入口的 import 链上，而入口
 * 加载时是宿主权限模型下最没特权的时刻（fs 读取面尚未按 App 的安装根开放），在顶层探
 * `manifest.json` 会被拒（实测报 `Access to this API has been restricted. Use --allow-fs-read`）。
 * 推迟到第一次真正用到时（工具调用 / 路由处理）探一次，之后记住——那时权限面已就绪。
 */
let cachedPluginRoot = null;

export function pluginRoot() {
  if (cachedPluginRoot) return cachedPluginRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = dir;
  for (let i = 0; i < 6; i += 1) {
    let hit = false;
    try {
      hit = fs.existsSync(path.join(dir, "manifest.json"));
    } catch {
      hit = false; // 权限未就绪或路径不可读：按不命中处理，交给下层回退
    }
    if (hit) {
      cachedPluginRoot = dir;
      return dir;
    }
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  // 找不到 manifest（非标准布局）→ 回退到入口所在目录，不抛：工具面不该因路径推导失败而全挂。
  // **不记忆化这个回退**：它可能是“首次调用时 fs 权限面还没就绪”造成的假阴性，一旦记下，
  // 后续调用再也不会重探 manifest（进程内永久用了错误的根）。只缓存确实命中 manifest 的结果。
  return entryDir;
}

/** 宿主注入的 resources 根环境变量（v1 时代有；v2 AppHost 不传，仅作候选之一） */
const HOST_RESOURCES_ENV = "HANA_DESKTOP_RESOURCES_PATH";

const PLATFORM = process.platform; // win32 | darwin | linux
const isWindows = PLATFORM === "win32";
/** vendor 子目录名：平台-架构，例 win32-x64 / darwin-arm64 / linux-x64 */
export const VENDOR_PLATFORM_KEY = `${process.platform}-${process.arch}`;

/**
 * 每个工具在各平台的可执行路径与 PATH 附加目录（只写"树内形态"）。
 *
 * 路径形态是 `bin/<平台>-<架构>/<exe>`：产物里二进制平铺，不再有组件那一层。
 * 编排参考：构建期 build-app 把仓库的 vendor/bin/<平台>/<组件>/ 投影到这里。
 *
 * **当前表里只有 git**：gpg / gpgconf 已不再需要（签名由随包的纯 JS shim 完成，
 * 见 tools/lib/gpg.shim.mjs），包里不再内嵌任何二进制。
 *
 * git 条目**不描述随包内容**：MinGit 从不随包（sources.json 里也不声明 git），App 始终用宿主
 * 那份 `<HANA_ROOT>/resources/git`。这里的 git 条目服务的是**宿主 git 的树内形态**——
 * finish() 用 extraPath 把它自带的 cmd/ 与 mingw64/bin 等目录前置进 PATH，否则 git 找不到
 * 自己的子命令。不要因“不随包”就删掉这条。
 */
export const VENDOR_LAYOUT = {
  win32: {
    git: { exe: "cmd/git.exe", extraPath: ["cmd", "mingw64", "bin", "usr", "bin"] },
  },
  darwin: {
    git: { exe: "bin/git", extraPath: ["bin", "libexec/git-core"] },
  },
  linux: {
    git: { exe: "bin/git", extraPath: ["bin", "libexec/git-core"] },
  },
};

/**
 * 工具名（resolveBin 的 bin）→ vendor 组件目录名（vendor/sources.json 的 components 键）。
 * 同义不同名时在这里建映射；当前无映射（git 组件名与工具名相同）。
 * 历史上 gpg 与 gpgconf 两个可执行文件同出 gnupg 一份组件目录，那条映射随内嵌二进制一起移除。
 */
export const VENDOR_COMPONENT = {};

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
  return [path.join(pluginRoot(), "bin", VENDOR_PLATFORM_KEY)];
}

/**
 * 随包二进制的根目录（bin/<平台-架构>/）。导出供诊断：它是"随包二进制找得到吗"的现场值。
 * 路径推导与产物布局不一致时（如入口搬到 bin/ 后插件根变了），只靠 tools 会表现成静默回落
 * 系统 PATH（"装好了但用的是系统那份"），这条诊断值能把那种情况当场显形。
 */
export function bundledBinRoot() {
  return path.join(pluginRoot(), "bin", VENDOR_PLATFORM_KEY);
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
 * 给"必须同步"的调用点用（外部命令解析走 resolveBinExec，含宿主 spawn 探活）。
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
 * 隔离的 git 临时目录（<dataDir>/.runtime-tmp）。
 *
 * git 验签时把待验签名先写成一个临时文件，再把路径交给 gpg.program。落点由 TMPDIR 决定：
 * 系统 temp 在 App 许可根之外，shim 这个 node 脚本在权限模型下读不到它，于是
 * `verify-commit` / `log --show-signature` 一律报「读签名文件失败」。
 *
 * 目录名与落点照宿主的受管运行时抄（`app-data/<id>/.runtime-tmp`，宿主给受管子进程注入
 * TMPDIR 用的就是它）。本 App 走 app/process.spawn 直接拉 git，不是受管运行时、拿不到
 * 那份注入，所以自己摆一份；两边同址同名，将来若改用受管运行时也不会分叉。
 *
 * 只重定向 TMPDIR/TEMP/TMP，不碰 HOME/USERPROFILE：git 的配置隔离已由
 * GIT_CONFIG_GLOBAL 完成，把 HOME 一并换掉会连带改变 ssh 与凭据助手的查找路径。
 *
 * @returns {string|null} 目录绝对路径；创建失败返回 null（不注入，行为退回系统 temp）
 */
function ensureTmpDir(dataDir) {
  const dir = path.join(dataDir, ".runtime-tmp");
  try {
    // mode 与宿主一致（0o700）。Windows 上它不产生 NTFS ACL 限制（ACL 是继承的），
    // 真正的边界是 dataDir 本身就在 App 许可根内；这里只为与宿主保持同一写法。
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

/**
 * 构造子进程 env：在继承 env 基础上注入 bundled 需要的 PATH（git 的 cmd/mingw64/usr）+ 隔离 env。
 *
 * 不注入任何 GitHub 凭据：GitHub 域已不走子进程（REST worker 的令牌经 stdin 传入，见
 * tools/lib/rest.js），git 子进程也不读 GH_TOKEN。所以这里只做 git 的隔离注入与签名接线。
 * @param {*} baseEnv 继承的基础 env（process.env 副本）
 * @param {ReturnType<typeof resolveBinExec>} resolved resolveBin 结果（source=bundled 时生效）
 */
export function buildBinEnv(baseEnv, resolved) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  if (resolved.source === "bundled" && resolved.extraPath && resolved.extraPath.length > 0) {
    env.PATH = resolved.extraPath.join(path.delimiter) + path.delimiter + (env.PATH || "");
  }
  const dataDir = getToolDataDir();
  if (dataDir) {
    env.GIT_CONFIG_GLOBAL = path.join(dataDir, "gitconfig");
    // 临时目录也收进 dataDir：验签时 git 写下的签名文件要落在 shim 的读取面内（见 ensureTmpDir）。
    const tmpDir = ensureTmpDir(dataDir);
    if (tmpDir) {
      env.TMPDIR = tmpDir;
      env.TMP = tmpDir;
      env.TEMP = tmpDir;
    }
    // 签名接线：gpg.program 指向**签名 shim**（纯 JS，见 tools/lib/gpg.shim.mjs）。
    // 不再有 GNUPGHOME、vendor gnupg 的 PATH 前置、gpgconf.ctl 处理——gpg 二进制已经不在包里，
    // 那套隔离机制存在的唯一理由（让 gpg 认隔离环）随之消失。
    //
    // 包装脚本每次现算（node 路径与安装位都可能变）；见 tools/lib/sign-shim.js。
    // 走 git 的 GIT_CONFIG_* 机制（git ≥ 2.31）：它在所有配置文件之上生效，改不到文件也不脏文件。
    const wrapper = ensureWrapper(dataDir);
    if (wrapper) {
      const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
      const n = Number.isFinite(baseCount) && baseCount >= 0 ? baseCount : 0;
      env.GIT_CONFIG_COUNT = String(n + 1);
      env[`GIT_CONFIG_KEY_${n}`] = "gpg.program";
      env[`GIT_CONFIG_VALUE_${n}`] = wrapper;
      // shim 是独立进程，不知道 dataDir：密钥路径经 env 传它（与 REST worker 的令牌经 stdin 同理）。
      env.GITHANA_KEY_FILE = keyFilePath(dataDir);
    }
  }
  return env;
}
