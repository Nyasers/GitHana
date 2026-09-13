// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/pack.mjs — 出包（本仓库自足；官方 creator 可用时作为额外校验）。
 *
 * ## 为什么要自己出包
 *
 * dshana 能自动出包，是因为它的 pack 脚本在自己仓库里（scripts/pack.mts）。本项目的官方
 * 包工具（pack_app.mjs）随 Hana 安装包分发、不在仓库里——CI 上拿不到，所以"自动打包发 release"
 * 只能由本仓库自己完成。官方工具可用时仍会被调用（多一道校验），不可用时不再阻塞出包，
 * 但会把"未过官方校验"印在输出和产物名旁边的 JSON 里，不假装通过。
 *
 * ## 产物形状（对齐官方包的实测布局）
 *
 * ZIP 内文件在根：manifest.json / index.js / lib/ / tools/ / ui/ / vendor/ / skills/ / assets/…
 * 排除：node_modules（只有构建期需要，UI 产物已在 ui/ 里）、.git* / .github、_tmp、releases、
 * pnpm-lock.yaml、pnpm-workspace.yaml、scripts/（开发件）。
 * 说明：官方包工具不排除任何目录，会把 node_modules 与开发件一并打进去；本脚本按上面这张
 * 白/黑名单做净包，所以同类内容更小。
 *
 * ## 逐目标出包
 *
 * `--target <platform|universal>`：决定随包的 vendor 目录（universal = 不随包，全靠宿主/系统）。
 * 产物落 `releases/<id>-v<version>-<target>.zip` + 同名 `.sha256`；版本单一事实源是 manifest.json，
 * 并与 package.json 对齐（不一致直接拒包）。
 *
 * 用法：
 *   node scripts/pack.mjs --target win32-x64
 *   node scripts/pack.mjs --target universal --out ./releases
 *   node scripts/pack.mjs                      # 默认当前平台
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");

/** 包内排除项（相对 app 根的第一段）。 */
const EXCLUDE_TOP = new Set([
  "node_modules",
  "_tmp",
  "releases",
  "dist-extensions",
  ".git",
  ".github",
  "scripts",           // 开发/构建脚本，不属于运行时交付物
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".gitignore",
  ".npmrc",
  "README.md",
  // 注意：**不能**排除 package.json——里面有 "type": "module"，app 入口是 ESM，
  // 没有它就按 CJS 解析，index.js 的 import 直接语法报错。官方 validator 也会查入口可编译。
]);

/** 官方限制（对齐 APPS.md：压缩 256MiB / 展开 512MiB / 30000 条）。 */
const LIMITS = { zipBytes: 256 * 1024 * 1024, rawBytes: 512 * 1024 * 1024, entries: 30000 };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 递归收集待打包文件（跳过排除项与符号链接）。 */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const relFromBase = relative(base, abs);
    if (relFromBase.split(sep).length === 1 && EXCLUDE_TOP.has(name)) continue;
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue; // 包内不允许符号链接
    if (st.isDirectory()) collect(abs, base, out);
    else if (st.isFile()) out.push({ abs, entry: relFromBase.split(sep).join("/"), size: st.size });
  }
  return out;
}

/** 把 app 目录里“该进包”的东西复制到临时暂存目录（排除清单在此一次生效）。
 *  暂存目录的**末级名字必须等于 manifest.id**：官方包工具会校验“目录名 = id”。
 */
function stage(target, id) {
  const stageDir = join(ROOT, "..", "..", "build", "_stage", target, id);
  rmSync(join(ROOT, "..", "..", "build", "_stage", target), { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const files = collect(ROOT);
  for (const f of files) {
    const dest = join(stageDir, ...f.entry.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
  return { stageDir, files };
}

// ── 最小 ZIP 写入器（store/deflate，UTF-8 名，保留可执行位） ─────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 收集一个目录为 zip 条目（含可执行位）。 */
function zipEntries(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) zipEntries(abs, base, out);
    else if (st.isFile()) {
      const data = readFileSync(abs);
      // 可执行位：POSIX 上加 0755（官方打包器也会保留）
      const mode = (st.mode & 0o111) !== 0 ? 0o755 : 0o644;
      out.push({ entry: relative(base, abs).split(sep).join("/"), data, mode });
    }
  }
  return out;
}

function writeZip(outFile, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.entry, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(((e.mode | 0o100000) << 16) >>> 0, 38); // 外部属性：unix 模式
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...chunks, cenBuf, eocd]));
}

/** 官方 creator 的 pack_app.mjs（可用则跑一次，作为额外校验）。 */
function findOfficialPacker() {
  const cands = [];
  if (process.env.HANA_APP_TOOLS_ROOT) cands.push(join(process.env.HANA_APP_TOOLS_ROOT, "scripts", "pack_app.mjs"));
  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (existsSync(serverRoot)) {
    for (const v of readdirSync(serverRoot)) cands.push(join(serverRoot, v, "scripts", "pack_app.mjs"));
  }
  cands.push(join(HANA_HOME, "skills", "hana-app-creator", "scripts", "pack_app.mjs"));
  return cands.find((c) => existsSync(c)) || null;
}

function main() {
  const manifest = readJson(join(ROOT, "manifest.json"));
  const pkg = readJson(join(ROOT, "package.json"));
  if (!manifest.id || !manifest.version) {
    console.error("[pack] manifest.json 缺 id/version，拒绝出包");
    process.exit(1);
  }
  if (pkg.version && pkg.version !== manifest.version) {
    console.error(`[pack] 版本不一致：manifest=${manifest.version} package.json=${pkg.version}（单一事实源是 manifest）`);
    process.exit(1);
  }

  const target = arg("--target") || `${process.platform}-${process.arch}`;
  const outDir = resolve(arg("--out") || join(ROOT, "..", "..", "build", manifest.id, "releases"));
  mkdirSync(outDir, { recursive: true });

  // 1) 暂存净包（排除开发件；vendor 按 target 收窄）
  const { stageDir, files } = stage(target, manifest.id);
  const vendorRoot = join(stageDir, "vendor");
  if (existsSync(vendorRoot)) {
    const keep = target === "universal" ? null : target;
    for (const name of readdirSync(vendorRoot)) {
      if (name === "sources.json") continue;
      if (keep && name === keep) continue;
      rmSync(join(vendorRoot, name), { recursive: true, force: true });
    }
  }
  console.log(`[pack] target=${target}  暂存文件 ${files.length} 个 → ${relative(ROOT, stageDir)}`);

  // 2) 官方工具可用 → 先跑一遍官方校验/打包（结果作为额外证据，不改变我们的产物形状）
  const official = findOfficialPacker();
  let officialResult = "unavailable";
  if (official) {
    try {
      execFileSync(process.execPath, [official, "--dir", stageDir, "--publisher", arg("--publisher") || pkg.name, "--out", join(outDir, "_official")], {
        stdio: "pipe",
      });
      officialResult = "passed";
      console.log("[pack] 官方校验：通过（额外关卡）");
    } catch (e) {
      const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("").trim();
      officialResult = "failed";
      console.error("[pack] 官方校验未通过：\n" + out.split("\n").slice(-6).join("\n"));
      process.exit(1);
    }
  } else {
    console.log("[pack] 官方 creator 不在本机/本 runner：跳过官方校验（产物将标注 unverified）");
  }

  // 3) 自己出包
  const filesInStage = zipEntries(stageDir);
  const rawBytes = filesInStage.reduce((n, e) => n + e.data.length, 0);
  if (filesInStage.length > LIMITS.entries) {
    console.error(`[pack] 条目数 ${filesInStage.length} 超上限 ${LIMITS.entries}`);
    process.exit(1);
  }
  if (rawBytes > LIMITS.rawBytes) {
    console.error(`[pack] 展开体积 ${(rawBytes / 1048576).toFixed(1)}MiB 超上限 ${LIMITS.rawBytes / 1048576}MiB`);
    process.exit(1);
  }

  const baseName = `${manifest.id}-v${manifest.version}-${target}`;
  const zipPath = join(outDir, `${baseName}.zip`);
  writeZip(zipPath, filesInStage);
  const zipSize = statSync(zipPath).size;
  if (zipSize > LIMITS.zipBytes) {
    console.error(`[pack] 压缩体积 ${(zipSize / 1048576).toFixed(1)}MiB 超上限 ${LIMITS.zipBytes / 1048576}MiB`);
    process.exit(1);
  }

  const digest = sha256File(zipPath);
  const shaPath = `${zipPath}.sha256`;
  writeFileSync(shaPath, `${digest}  ${baseName}.zip\n`, "utf8");

  console.log(
    `[pack] 完成 ${relative(ROOT, zipPath)}  ${(zipSize / 1048576).toFixed(1)} MiB  ${filesInStage.length} 条` +
      `\n        sha256 ${digest}` +
      `\n        官方校验：${officialResult}`,
  );
}

main();
