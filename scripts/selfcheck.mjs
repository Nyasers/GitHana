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
 *   3) vendor：按 vendor/sources.json 校验本平台声明过的组件是否就绪
 *
 * 它不替代官方校验（那套会检查图标可解码、静态资源、隔离启动 smoke 等）。
 * 用法：node scripts/selfcheck.mjs [--platform win32-x64]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

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
  const dirName = ROOT.split(/[\\/]/).pop();
  if (manifest.id !== dirName) fail(`manifest.id (${manifest.id}) 必须等于目录名 (${dirName})`);
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
try {
  const sources = JSON.parse(readFileSync(join(ROOT, "vendor", "sources.json"), "utf8"));
  const entry = sources.platforms && sources.platforms[platform];
  if (!entry) {
    note(`vendor：本平台（${platform}）无声明 → 组件全部走系统 PATH`);
  } else {
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

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const n of notes) console.log("  note:", n);
for (const p of problems) console.error("  FAIL:", p);
console.log(`[selfcheck] platform=${platform} problems=${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
