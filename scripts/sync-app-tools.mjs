// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/sync-app-tools.mjs — 把本机宿主自带的作者工具刷进 scripts/hana-app-tools/。
 *
 * ## 为什么要有这份拷贝，为什么需要本脚本
 *
 * 仓库里内嵌一份宿主作者工具的原样拷贝（verbatim），让本仓库与 CI 不依赖「本机恰好装了 Hana」——
 * 官方 creator 不在 npm 上。拷贝绑定 Hana 版本：宿主升级后，同一份工具的行为可能变（如索引
 * 归档上限从 50 MiB 放宽到 300 MiB），旧拷贝会把「其实合法的包」判成超限而拒。
 *
 * 这份拷贝**只收依赖闭包自足的**工具（判据见同目录 README）：`extension-index-build.mjs` 只用
 * node 内建，可以在脱离 Hana 的 node_modules 里独立跑；`validate-app.mjs` / `extension-pack.mjs`
 * 依赖 Hana 内部包或原生模块，不收。名单是数据（本文件下方 TOOLS），要收新的工具在此点名。
 *
 * ## 源的位置（按序探测，第一个命中的赢）
 *
 *   1. --source <dir>
 *   2. <HANA_HOME>/artifacts/server/<最新版本>/scripts（随宿主版本分发，权威）
 *   3. <HANA_HOME>/skills/hana-app-creator/scripts（已安装 skill 的资产，兜底）
 *
 * 源是本机宿主，CI 上没有，所以本脚本不进 CI 门禁。同步按整文件 sha256 比对，只写变化的那几份，
 * 并同步更新 PROVENANCE.json（来源路径、Hana 版本、字节数、哈希）——「这份工具来自哪个 Hana
 * 版本」始终可查，人工不必再手抄哈希。
 *
 * 用法：
 *   node scripts/sync-app-tools.mjs                 # 同步（源自动探测）
 *   node scripts/sync-app-tools.mjs --check         # 只校验，有漂移则 exit 1
 *   node scripts/sync-app-tools.mjs --source <dir>  # 指定源目录
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "scripts", "hana-app-tools");
const PROVENANCE = join(DEST, "PROVENANCE.json");
const HANA_HOME =
  process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".hanako");

/** 收录名单：依赖闭包自足的官方作者工具。加一个工具在此点名（并同步 README 的收录表）。 */
const TOOLS = ["extension-index-build.mjs"];

const log = (...a) => console.log("[sync-app-tools]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

/** server 目录名形如 `1.0.16-beta-win32-x64-<hash>`；按语义版本降序（与 sync-sdk 同口径）。 */
function byVersionDesc(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 宿主版本目录名（`<版本>-<platform>-<hash>`）：取版本段供 PROVENANCE 记录。
 *  版本本身可能带 pre 段（如 `1.0.16-beta`），平台段紧随其后，故只取到第一个平台名之前。 */
function hanaVersionOf(dir) {
  const base = path.basename(dir); // 可能是 scripts/ 或 <版本>-…/scripts
  const parent = path.basename(path.dirname(dir));
  const candidate = base === "scripts" ? parent : base;
  // 目录名形如 1.0.16-beta-win32-x64-<hash>：砍掉 `-<os>-<arch>[-<hash>]` 尾巴。
  const m = /^(.+?)-(win32|darwin|linux)-[a-z0-9]+/.exec(candidate);
  return m ? m[1] : candidate;
}

function findSource() {
  const explicit = arg("--source");
  if (explicit) return path.resolve(explicit);

  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const newest = fs
      .readdirSync(serverRoot)
      .filter((v) => TOOLS.every((t) => fs.existsSync(join(serverRoot, v, "scripts", t))))
      .sort(byVersionDesc)[0];
    if (newest) return join(serverRoot, newest, "scripts");
  }
  return join(HANA_HOME, "skills", "hana-app-creator", "scripts");
}

/** 现有 PROVENANCE 里的工具条目（缺文件/坏 JSON → 空表）。 */
function readProvenance() {
  try {
    return JSON.parse(fs.readFileSync(PROVENANCE, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const check = process.argv.includes("--check");
  const src = findSource();

  if (!fs.existsSync(src)) {
    console.error(`[sync-app-tools] 找不到作者工具源：${src}`);
    console.error("  宿主没装在这里时用 --source <dir> 指定。");
    process.exit(2);
  }

  const missing = TOOLS.filter((t) => !fs.existsSync(join(src, t)));
  if (missing.length) {
    console.error(`[sync-app-tools] 源不完整（缺 ${missing.join("、")}）：${rel(src)}`);
    process.exit(2);
  }

  const version = hanaVersionOf(src);
  const prev = readProvenance();
  log(`源   ${rel(src)}  hanaVersion=${version}`);

  const changed = [];
  for (const name of TOOLS) {
    const a = join(src, name);
    const b = join(DEST, name);
    const same = fs.existsSync(b) && sha256(a) === sha256(b);
    if (!same) changed.push(name);
  }

  // 文件内容一致也可能需要刷新 PROVENANCE：来源路径与 Hana 版本随宿主升级而变（内容恰好
  // 相同不代表「同一个宿主版本」）。所以条目按当前源重算，与既有记录不一致就更新。
  const tools = { ...(prev && prev.tools ? prev.tools : {}) };
  let provenanceDirty = !prev;
  for (const name of TOOLS) {
    // 首次同步时 DEST 还没有这份文件：哈希按源算（与同步后 DEST 内容一致）。
    const content = fs.existsSync(join(DEST, name)) ? fs.readFileSync(join(DEST, name)) : fs.readFileSync(join(src, name));
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const entry = {
      source: `<HANA_HOME>/artifacts/server/${version}-…/scripts/${name}`,
      hanaVersion: version,
      copiedAt:
        prev && prev.tools && prev.tools[name] && prev.tools[name].sha256 === hash
          ? prev.tools[name].copiedAt
          : new Date().toISOString().slice(0, 10),
      bytes: content.length,
      sha256: hash,
      externalDeps: [],
      license: "该文件自身未随附许可声明，许可以 Hana 自身分发为准",
    };
    if (JSON.stringify(entry) !== JSON.stringify(tools[name] || null)) provenanceDirty = true;
    tools[name] = entry;
  }

  if (changed.length === 0 && !provenanceDirty) {
    log(`已是最新（${TOOLS.length} 个工具全部一致，hanaVersion=${version}）`);
    return;
  }

  if (check) {
    if (changed.length) {
      console.error(`[sync-app-tools] 有漂移：${changed.join("、")}`);
      console.error("  跑 node scripts/sync-app-tools.mjs 同步（本机宿主为源）。");
    } else {
      console.error(`[sync-app-tools] PROVENANCE 与源不一致（hanaVersion 应为 ${version}）。`);
      console.error("  跑 node scripts/sync-app-tools.mjs 刷新。");
    }
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });
  for (const name of changed) {
    fs.copyFileSync(join(src, name), join(DEST, name));
    log(`  写入 ${name}（${fs.readFileSync(join(DEST, name)).length} 字节）`);
  }

  // PROVENANCE 与拷贝同批更新：来源版本与哈希从一个脚本里出，人不必再手抄。
  const next = {
    note:
      prev && prev.note
        ? prev.note
        : "本目录是 Hana 自带作者工具的原样拷贝（verbatim），用于让本仓库与 CI 不依赖本机 Hana 安装。收录判定见 README.md（只看依赖闭包）。",
    tools,
  };
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    fs.writeFileSync(PROVENANCE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    log("已更新 PROVENANCE.json");
  }

  log(`同步完成：${changed.length} 个文件更新，hanaVersion=${version}`);
}

main();
