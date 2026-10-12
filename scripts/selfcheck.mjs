// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/selfcheck.mjs — 零依赖自检（CI 与本地都可跑）。
 *
 * 官方 creator 的 validate_app / pack_app 不在本仓库（私有），CI 里拿不到；本脚本只做
 * 「不依赖任何外部工具也能判定」的那部分，让 CI 仍有实际门槛，而不是只跑构建：
 *
 *   1) manifest.json 结构与关键字段（manifestVersion=2、id 与目录名一致、entry 存在、
 *      capabilities 是数组、声明过的 route 文件真的在 ui/ 下）
 *   2) 所有服务端 .js 能被 Node 解析（node --check，按 package.json 的 type=module 走 ESM）
 *   3) vendor：按 vendor/sources.json 校验声明过的组件是否就绪，并与 bin.js 的查找表
 *      对齐（防「声明了组件但查找表找不到」的命名漂移——探空会静默回退系统 PATH）。
 *      `--platform universal` 不是一个真实平台，而是「包要发到任意平台」：此时逐个校验
 *      sources.json 里声明的**每个**平台（与 pack --target universal 的全平台随包同一口径）。
 *   4) 随包的独立子进程入口存在（REST worker / 签名 shim）：两者都不依赖外部二进制，
 *      但缺了对应域整个不可用（GitHub 请求 / 签名），所以在 CI 这一层拦住。
 *
 * 它不替代官方校验（那套会检查图标可解码、静态资源、隔离启动 smoke 等）。
 * 用法：node scripts/selfcheck.mjs [--platform win32-x64|universal]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { VENDOR_LAYOUT, VENDOR_COMPONENT } from "../tools/lib/bin.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

function fail(msg) {
  problems.push(msg);
}
function note(msg) {
  notes.push(msg);
}

// ── 1) manifest ────────────────────────────────────────────────────────────
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
} catch (e) {
  fail(`manifest.json 读不了：${(e && e.message) || e}`);
}

if (manifest) {
  if (manifest.manifestVersion !== 2) fail(`manifestVersion 必须是 2（当前 ${JSON.stringify(manifest.manifestVersion)}）`);
  // id 就是宿主安装位 <HANA_HOME>/apps/<id>/ 的目录名，所以只校验它是一个安全的单段目录名。
  // 不复核"本仓库所在目录名"：CI 的 checkout 目录是仓库名（GitHana），与 App id 本无关系，
  // 旧写法让 macOS / Linux 分支恒红。安装位与 id 的对应由安装流程保证（pack.mjs 的净包暂存
  // 也是把末级目录名取成 manifest.id）。
  const id = manifest.id;
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[\\/:*?"<>|]/.test(id)) {
    fail(`manifest.id 必须是非空、可作为单段目录名的字符串（当前 ${JSON.stringify(id)}）`);
  }
  // 入口是**构建产物**（bin/app.mjs，由 build-server 打出），不在源码树里。源码树里能校验的
  // 是它的源（app.js）与入口规约（必须是 .mjs 或 .js）——产物是否存在由 build-app 的断言管
  // （交付树里逐个点名，见其第 5 步）。这也是入口改成产物形态后，两道检查各自的分工。
  if (typeof manifest.entry !== "string" || !/\.m?js$/.test(manifest.entry)) {
    fail(`manifest.entry 必须是一个 JS 入口路径（当前 ${JSON.stringify(manifest.entry)}）`);
  } else if (!existsSync(join(ROOT, "app.js"))) {
    fail("服务端入口源不存在：app.js（manifest.entry 指向的产物由它打出来）");
  }
  if (typeof manifest.icon !== "string" || !existsSync(join(ROOT, manifest.icon))) {
    fail(`icon 不存在：${manifest.icon}`);
  }
  if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) {
    fail("capabilities 必须是数组");
  }

  const contributes = manifest.contributes || {};
  const routeFiles = [];
  const settingsRoute = contributes.settings && contributes.settings.ui && contributes.settings.ui.route;
  if (typeof settingsRoute === "string") routeFiles.push({ route: settingsRoute, from: "contributes.settings.ui.route" });
  for (const card of Array.isArray(contributes.cards) ? contributes.cards : []) {
    if (typeof card?.route === "string") routeFiles.push({ route: card.route, from: `contributes.cards[${card.id}].route` });
  }
  for (const r of routeFiles) {
    const file = join(ROOT, "ui", r.route.replace(/^\//, ""));
    if (!existsSync(file)) fail(`${r.from} 指向的文件不存在：ui${r.route}`);
  }
}

// ── 2) 服务端 js 语法（ESM 解析） ───────────────────────────────────────────
function collectJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "ui" || name === "vendor" || name === "dist" || name === "build" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectJs(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
for (const file of collectJs(ROOT)) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("").trim();
    fail(`语法检查失败：${rel(file)}${out ? "\n    " + out.split("\n").slice(0, 3).join("\n    ") : ""}`);
  }
}

// ── 3) vendor 就绪性（按声明） ──────────────────────────────────────────────
const argv = process.argv.slice(2);
const pi = argv.indexOf("--platform");
const platformArg = pi >= 0 && argv[pi + 1] ? argv[pi + 1] : `${process.platform}-${process.arch}`;
// universal：包要发到任意平台，校验面就是 sources.json 声明的全部平台（与 pack 同一口径）。
const isUniversal = platformArg === "universal";
let sources = null;
let platformsToCheck = [];
try {
  sources = JSON.parse(readFileSync(join(ROOT, "vendor", "sources.json"), "utf8"));
  if (isUniversal) {
    platformsToCheck = Object.keys(sources.platforms || {});
    note(`vendor：universal 目标 → 校验声明的全部平台（${platformsToCheck.join(" / ")}）`);
  } else {
    platformsToCheck = [platformArg];
  }
} catch (e) {
  fail(`vendor/sources.json 读不了：${(e && e.message) || e}`);
}

/** 单个平台的组件就绪性 + 查找表对齐。 */
function checkPlatformVendor(platform) {
  const entry = sources && sources.platforms && sources.platforms[platform];
  if (!entry) {
    if (!isUniversal) note(`vendor：本平台（${platform}）无声明 → 组件全部走系统 PATH`);
    return;
  }
  const declaredComponents = entry.components || {};
  for (const [key, spec] of Object.entries(declaredComponents)) {
    const exe = join(ROOT, "vendor", "bin", platform, key, spec.exe);
    if (existsSync(exe)) note(`vendor[${platform}] ${key} 就绪（${spec.version}）`);
    else if (!spec.sha256) note(`vendor[${platform}] ${key} 未内嵌（无声明产物）→ 走宿主 / 系统 PATH`);
    else fail(`vendor[${platform}] ${key} 缺失：${rel(exe)}（跑 node scripts/fetch-vendor.mjs --platform ${platform} ${key}）`);
  }

  // ── 声明组件 ↔ 查找表一致性 ──
  // sources.json（磁盘上有什么）与 bin.js（怎么找到）是两份数据，命名漂移过一次（gpg vs gnupg）：
  // 拼错目录名不报错、静默回退系统 PATH，最后只在签名时报「No secret key」。CI 挡在这一层。
  // 查找表按 process.platform 索引，故只在平台名与本机一致时比对；universal 下只比对本机那份。
  if (platform.split("-")[0] !== process.platform) return;
  const table = VENDOR_LAYOUT[process.platform];
  for (const [key, spec] of Object.entries(declaredComponents)) {
    const bin = Object.keys(VENDOR_COMPONENT).find((b) => VENDOR_COMPONENT[b] === key) || key;
    const layout = table && table[bin];
    if (!layout) {
      fail(
        `vendor[${platform}] ${key}：bin.js VENDOR_LAYOUT 无 ${bin} 条目 → 该组件永远探不到` +
        `（查找表与 sources.json 命名漂移）`
      );
    } else if (layout.exe !== spec.exe) {
      fail(`vendor[${platform}] ${key}：bin.js ${bin}.exe=${layout.exe} 与 sources.json 的 ${spec.exe} 不一致`);
    } else {
      note(`vendor[${platform}] ${key} ↔ bin.js ${bin} 组件目录对齐（${spec.exe}）`);
    }
  }
}

for (const p of platformsToCheck) checkPlatformVendor(p);

// ── 4) 随包的独立子进程入口（REST worker + 签名 shim）─────────────────────
// 它们不是外部二进制，所以不在 vendor 表里；但都是 spawn 出去的独立入口，缺了对应域
// 整个不可用（且只在被调用时才暴露），所以在 CI 这一层拦住。
for (const rel of [
  ["tools/lib/rest-worker.mjs", "GitHub REST 执行体，构建时会平铺到 bin/rest-worker.mjs"],
  ["tools/lib/gpg-shim.mjs", "签名 shim 源（构建时打包为 bin/gpg-shim.mjs，含 OpenPGP.js）"],
]) {
  if (!existsSync(join(ROOT, ...rel[0].split("/")))) {
    fail(`缺 ${rel[0]}（${rel[1]}）`);
  } else {
    note(`入口就绪（${rel[0]}）`);
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const n of notes) console.log("  note:", n);
for (const p of problems) console.error("  FAIL:", p);
console.log(`[selfcheck] platform=${platformArg} problems=${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
