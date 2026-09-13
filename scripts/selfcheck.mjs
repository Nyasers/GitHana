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
 *   3) vendor：按 vendor/sources.json 校验本平台声明过的组件是否就绪，并与 bin.js 的查找表
 *      对齐（防「声明了组件但查找表找不到」的命名漂移——探空会静默回退系统 PATH）
 *
 * 它不替代官方校验（那套会检查图标可解码、静态资源、隔离启动 smoke 等）。
 * 用法：node scripts/selfcheck.mjs [--platform win32-x64]
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
  // 旧写法让 macOS / Linux 分支恒红。安装位与 id 的对应由 deploy.mjs 从 manifest.id 取。
  const id = manifest.id;
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[\\/:*?"<>|]/.test(id)) {
    fail(`manifest.id 必须是非空、可作为单段目录名的字符串（当前 ${JSON.stringify(id)}）`);
  }
  if (typeof manifest.entry !== "string" || !existsSync(join(ROOT, manifest.entry))) {
    fail(`entry 不存在：${manifest.entry}`);
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
    if (name === "node_modules" || name === "ui" || name === "vendor" || name.startsWith(".")) continue;
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
const platform = pi >= 0 && argv[pi + 1] ? argv[pi + 1] : `${process.platform}-${process.arch}`;
let declaredComponents = null;
try {
  const sources = JSON.parse(readFileSync(join(ROOT, "vendor", "sources.json"), "utf8"));
  const entry = sources.platforms && sources.platforms[platform];
  if (!entry) {
    note(`vendor：本平台（${platform}）无声明 → 组件全部走系统 PATH`);
  } else {
    declaredComponents = entry.components || null;
    for (const [key, spec] of Object.entries(entry.components || {})) {
      const exe = join(ROOT, "vendor", platform, key, spec.exe);
      if (existsSync(exe)) note(`vendor[${platform}] ${key} 就绪（${spec.version}）`);
      else if (!spec.sha256) note(`vendor[${platform}] ${key} 未内嵌（无声明产物）→ 走宿主 / 系统 PATH`);
      else if (spec.optional) note(`vendor[${platform}] ${key} 未随包（optional，宿主已捆绑或按需抓取）→ 走宿主 / 系统 PATH`);
      else fail(`vendor[${platform}] ${key} 缺失：${rel(exe)}（跑 node scripts/fetch-vendor.mjs --platform ${platform} ${key}）`);
    }
  }
} catch (e) {
  fail(`vendor/sources.json 读不了：${(e && e.message) || e}`);
}

// ── 3b) 声明组件 ↔ 查找表一致性 ────────────────────────────────────────────
// sources.json（磁盘上有什么）与 bin.js（怎么找到）是两份数据，命名漂移过一次（gpg vs gnupg）：
// 拼错目录名不报错、静默回退系统 PATH，最后只在签名时报「No secret key」。CI 挡在这一层，
// 别等用户机器上的签名失败来暴露。查找表按 process.platform 索引，故只在平台名与本机一致时比对。
if (declaredComponents && platform.split("-")[0] === process.platform) {
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

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const n of notes) console.log("  note:", n);
for (const p of problems) console.error("  FAIL:", p);
console.log(`[selfcheck] platform=${platform} problems=${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
