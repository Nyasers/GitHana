// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/pack.mjs — 出包（本仓库自足；官方静态校验器可用时作为额外关卡）。
 *
 * ## 为什么要自己出包
 *
 * dshana 能自动出包，是因为它的 pack 脚本在自己仓库里（scripts/pack.mts）。本项目的官方
 * 包工具（pack_app.mjs）随 Hana 安装包分发、不在仓库里——CI 上拿不到，所以"自动打包发 release"
 * 只能由本仓库自己完成。
 *
 * 官方**静态校验器**只在“宿主装在这里”时被调作额外关卡（它的依赖闭包含 Hana 内部包，
 * 不可能拷进仓库独立运行）；不可用时输出里会写明 `officialValidation: unavailable`，不假装通过。
 *
 * ## 产物形状（对齐官方包的实测布局）
 *
 * ZIP 内文件在根：manifest.json / index.js / lib/ / tools/ / ui/ / vendor/ / skills/ / assets/…
 *
 * 本脚本**只从 dist/ 出包**，不再从源码树过滤：交付面由 scripts/build-app.mjs 以白名单组装好，
 * 源码与开发件根本不进 dist/。这里不做任何排除判断——黑名单只列它记得的东西，源码树里多出
 * 什么就漏什么（本地规划文档与 ui/src/ 就是这么漏进来的），白名单没有这种缺口。
 *
 * ## 出包前无条件重建交付树
 *
 * dist/ 是构建产出（不入库）。本脚本在暂存前先跑 scripts/build-app.mjs（它会先构建设置页产物，
 * 再白名单组装 dist/），所以“包里的东西必然等于当前源码的产物”，不依赖调用方记得先构建。
 *
 * ## 逐目标出包
 *
 * `--target <platform|universal>`：决定随包的 vendor 运行时目录。
 *   · `universal`：**全平台随包**——把 `vendor/sources.json` 声明的每个平台的运行时都打进去，
 *     运行时就近解析 `vendor/bin/<platform>-<arch>/`，一份包在任意平台都自包含。**进市场的只有它。**
 *     全平台随包是 T7 验收里那条签名链的前提：Windows 的签名要求 vendor gnupg（认 GNUPGHOME 的
 *     原生模式），包不带 vendor 时 gpg.program 会指向不存在的路径，签名直接失败。
 *   · `--target <platform>`：点名才用，只留该平台 vendor（自包含单平台构建），不进 CI、不进市场。
 * 产物落 `releases/<id>-v<version>-<target>.zip` + 同名 `.sha256` + `.entry.json`；
 * 版本单一事实源是 manifest.json，并与 package.json 对齐（不一致直接拒包）。
 *
 * 用法：
 *   node scripts/pack.mjs --target universal          # 全平台随包（release 流水线只出这个）
 *   node scripts/pack.mjs --target win32-x64            # 只留该平台（点名用，不进 CI）
 *   不带 --target 时默认当前平台。
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// 打包期重渲染通知与裁剪许可面：包里有什么，通知就只讲什么。
// 复用仓库级同一套 render，差别只在传入的组件列表（见 derive-thirdparty 头注）。
import { renderNotice, licensesFor } from "./derive-thirdparty.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 交付树（= App 安装目录形态）：由 scripts/build-app.mjs 白名单组装，本脚本从它出包。 */
const DIST = join(ROOT, "dist");
const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");

/** 官方限制（对齐 APPS.md：压缩 256MiB / 展开 512MiB / 30000 条）。 */
const LIMITS = { zipBytes: 256 * 1024 * 1024, rawBytes: 512 * 1024 * 1024, entries: 30000 };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 递归收集 dist/ 下全部文件（跳过符号链接；不做任何排除——交付面已由 build-app 定好）。 */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue; // 包内不允许符号链接
    if (st.isDirectory()) collect(abs, base, out);
    else if (st.isFile()) out.push({ abs, entry: relative(base, abs).split(sep).join("/"), size: st.size });
  }
  return out;
}

/**
 * 该暂存树里真实存在的随包组件。
 *
 * 产物已将二进制平铺到 bin/<平台>/，目录名不再携带组件身份，所以这里按 **sources.json 的声明**
 * 逐个把组件的 exe 探一遂：哪个平台的哪个 exe 在就说明那个组件随了包。
 * 不从 bin/ 下的文件名反推组件名——那是猜，而声明的 exe 路径是确定的事实。
 */
function shippedComponentsInStage(binRoot) {
  const out = new Set();
  if (!existsSync(binRoot)) return [];
  const sources = readJson(join(ROOT, "vendor", "sources.json"));
  for (const [platform, entry] of Object.entries(sources.platforms || {})) {
    for (const [component, spec] of Object.entries(entry.components || {})) {
      if (!spec.exe) continue;
      if (existsSync(join(binRoot, platform, spec.exe))) out.add(component);
    }
  }
  return [...out].sort();
}

/** 许可正文目录只留本包适用的那几份（其余删掉，不随包）。 */
function pruneLicenses(stageDir, shipped) {
  const dir = join(stageDir, "licenses");
  if (!existsSync(dir)) return;
  const keep = new Set(licensesFor(shipped));
  for (const name of readdirSync(dir)) {
    if (!keep.has(name)) rmSync(join(dir, name), { force: true });
  }
}

/** 暂存净包。末级目录名必须等于 manifest.id（官方校验器会校验"目录名 = id"）。 */
function stage(target, id) {
  const parent = join(ROOT, "..", "..", "build", "_stage", target);
  const stageDir = join(parent, id);
  rmSync(parent, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const files = collect(DIST);
  for (const f of files) {
    const dest = join(stageDir, ...f.entry.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
  return { stageDir, files };
}

// ── 最小 ZIP 写入器（deflate/store，UTF-8 名，保留可执行位） ──────────────────

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

function zipEntries(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) zipEntries(abs, base, out);
    else if (st.isFile()) {
      const data = readFileSync(abs);
      const mode = (st.mode & 0o111) !== 0 ? 0o755 : 0o644; // 保留可执行位（官方打包器同样保留）
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
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
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
    cen.writeUInt32LE(((e.mode | 0o100000) << 16) >>> 0, 38);
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

/**
 * 官方**静态校验器**。
 *
 * 为什么不做“拷进仓库”：实测它 import 了 `@earendil-works/pi-coding-agent` 等 Hana **内部包**
 * （不在 npm 上），所以脱离 Hana 安装的 node_modules 无法运行；把它连同闭包一起 vendor 进仓库
 * 既不轻也会与 Hana 版本绑死。所以只在“宿主装在这里”时用它作为额外关卡，
 * 不可用时照常出包并在输出里标 unverified。
 *
 * 也不调官方 pack_app：它需要 jsdom(6.9MB) + sharp(原生)，而包由本脚本自己出。
 */
function findOfficialValidator() {
  const cands = [];
  if (process.env.HANA_APP_TOOLS_ROOT) cands.push(join(process.env.HANA_APP_TOOLS_ROOT, "scripts", "validate-app.mjs"));
  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (existsSync(serverRoot)) {
    // 多个版本共存时用**最新**的：readdir 顺序不保证，旧版校验器可能少检或误拒。
    const versions = readdirSync(serverRoot).filter((v) => existsSync(join(serverRoot, v, "scripts", "validate-app.mjs")));
    versions.sort((a, b) => {
      const pa = a.split("-")[0].split(".").map(Number);
      const pb = b.split("-")[0].split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pb[i] || 0) - (pa[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
    for (const v of versions) cands.push(join(serverRoot, v, "scripts", "validate-app.mjs"));
  }
  cands.push(join(HANA_HOME, "skills", "hana-app-creator", "scripts", "validate_app.mjs"));
  return cands.find((c) => existsSync(c)) || null;
}

/**
 * 市场条目（`.entry.json`）——索引构建器的输入。
 * 字段对齐官方包工具的产物；`archive.url` 用 `{{BASE_URL}}` 占位，由索引构建器替换成
 * 实际的 `--base-url`（加发布基址）。图标用 data URI：官方用 sharp 生成 PNG，我们直接嵌
 * manifest 里声明的 SVG（合法图片，不必为了图标引入原生依赖）。
 */
function buildEntry({ manifest, pkg, publisher, zipName, digest, size }) {
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const entry = {
    kind: "app",
    id: manifest.id,
    name: manifest.name || manifest.id,
    publisher: publisher || pkg.name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: manifest.version,
    permissions: capabilities.map((capability) => ({ capability })),
    ...(manifest.minAppVersion ? { compatibility: { minAppVersion: manifest.minAppVersion } } : {}),
    ...(manifest.formFactors ? { compatibility: { ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}), formFactors: manifest.formFactors } } : {}),
    archive: { url: `{{BASE_URL}}/${zipName}`, sha256: digest, size, format: "zip" },
  };
  try {
    // 图标从交付树取（manifest.icon 是包根相对路径），与包里那份一致。
    const iconPath = join(DIST, manifest.icon);
    if (manifest.icon && existsSync(iconPath)) {
      const ext = manifest.icon.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
      entry.icon = `data:${ext};base64,${readFileSync(iconPath).toString("base64")}`;
    }
  } catch {
    /* 图标只是加性字段，读不到就不带 */
  }
  if (manifest.repository) entry.repository = manifest.repository;
  if (manifest.homepage) entry.homepage = manifest.homepage;
  return entry;
}

function main() {
  // 版本对齐先查源码树（manifest 与 package.json 的单一事实源都在那里），再组装 dist/。
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

  // 0) 先组装交付树 dist/（白名单：先构建设置页产物，再点名拷贝交付件）。
  //    dist/ 不入库，是构建产出；在这里无条件重建，而不是依赖调用方先手动构建：
  //    出包是唯一必须保证产物新鲜的时刻，把「记得先构建」变成机器兜底。
  {
    const buildApp = join(ROOT, "scripts", "build-app.mjs");
    if (!existsSync(buildApp)) {
      console.error("[pack] 找不到 scripts/build-app.mjs，无法组装交付树");
      process.exit(1);
    }
    console.log("[pack] 组装交付树 dist/（白名单）…");
    try {
      execFileSync(process.execPath, [buildApp], { cwd: ROOT, stdio: "pipe" });
    } catch (e) {
      const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("\n").trim();
      console.error("[pack] 交付树组装失败：\n" + out.split("\n").slice(-12).join("\n"));
      process.exit(1);
    }
    if (!existsSync(DIST)) {
      console.error("[pack] 组装后 dist/ 仍不存在");
      process.exit(1);
    }
  }

  const target = arg("--target") || `${process.platform}-${process.arch}`;
  const outDir = resolve(arg("--out") || join(ROOT, "..", "..", "build", manifest.id, "releases"));
  mkdirSync(outDir, { recursive: true });

  // 1) 暂存净包（排除开发件；bin/ 按 target 收窄）
  //    产物形状：bin/<平台>-<架构>/<exe>（二进制平铺，无组件层；详见 build-app 头注）。
  //    universal = 全平台随包：一份包在任意平台都自包含。
  //    点名平台 = 只留那一个（自包含单平台构建，不进 CI、不进市场）。
  const { stageDir, files } = stage(target, manifest.id);
  const binRoot = join(stageDir, "bin");
  let vendorKept = [];
  if (existsSync(binRoot)) {
    vendorKept = readdirSync(binRoot);
    if (target !== "universal") {
      for (const name of vendorKept) {
        if (name === target) continue;
        rmSync(join(binRoot, name), { recursive: true, force: true });
      }
      vendorKept = vendorKept.includes(target) ? [target] : [];
    }
  }

  // universal 的完整性断言：全平台随包就要求每个平台该带的组件都在。
  // 少一个平台 = 包到了那台机器上才发现签名链路缺 gpg，正是「名义 universal、实则不全」的缺口。
  if (target === "universal") {
    const sources = readJson(join(ROOT, "vendor", "sources.json"));
    const missing = [];
    for (const [platform, entry] of Object.entries(sources.platforms || {})) {
      // 只要求“有可校验产物”的组件：sha256 为空的按系统 PATH 走，不必随包。
      for (const [component, spec] of Object.entries(entry.components || {})) {
        if (!spec.sha256) continue;
        if (!existsSync(join(binRoot, platform, spec.exe))) missing.push(`${platform}/${component}`);
      }
    }
    if (missing.length) {
      console.error(
        `[pack] universal 要求全平台随包，但以下组件缺失：${missing.join("、")}\n` +
          `       逐个平台补齐：node scripts/fetch-vendor.mjs --platform <platform>`,
      );
      process.exit(1);
    }
  }

  // 1b) 许可面随实际内容收窄。
  //     通知写的是「这个包里有什么」，所以它必须跟着**本包的交付内容**走，而不是仓库的全集：
  //     一个只装 gh 的 darwin 包若附带 GPL-3.0 条文与 GnuPG 段落，不是在多给，是在陈述不成立的事实。
  //     与上面 bin/ 按 target 收窄同一条原则、同一个位置。
  const shipped = shippedComponentsInStage(binRoot);
  const notice = renderNotice({ components: shipped });
  writeFileSync(join(stageDir, "THIRD_PARTY_NOTICES.md"), notice, "utf8");
  pruneLicenses(stageDir, shipped);
  console.log(`[pack] 许可面收窄：随包组件 [${shipped.join(", ") || "（无）"}] → ` +
    `通知 ${notice.length} 字节，licenses/ 保留 ${licensesFor(shipped).length} 份`);

  console.log(
    `[pack] target=${target}  暂存文件 ${files.length} 个  vendor=[${vendorKept.join(", ")}]` +
      ` → ${relative(ROOT, stageDir)}`,
  );

  // 2) 官方静态校验（额外关卡）
  const validator = findOfficialValidator();
  let officialResult = "unavailable";
  if (validator) {
    try {
      execFileSync(process.execPath, [validator, "--dir", stageDir, "--json"], { stdio: "pipe" });
      officialResult = "passed";
      console.log(`[pack] 官方静态校验：通过（${relative(ROOT, validator)}）`);
    } catch (e) {
      const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("\n").trim();
      console.error("[pack] 官方静态校验未通过：\n" + out.split("\n").slice(-8).join("\n"));
      process.exit(1);
    }
  } else {
    console.log("[pack] 没有官方校验器（仓库内与本机都没有）：跳过，产物按 unverified 处理");
  }

  // 3) 出包
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
  writeFileSync(`${zipPath}.sha256`, `${digest}  ${baseName}.zip\n`, "utf8");

  // 4) 市场条目（.entry.json）：extension-index-build.mjs 只吃这种文件来拼 index.v2.json。
  //    官方包工具同样同时产出 ZIP + entry；自己出包也不能漏这一步，否则市场清单拼不出来。
  const entryPath = join(outDir, `${baseName}.entry.json`);
  writeFileSync(entryPath, JSON.stringify(buildEntry({ manifest, pkg, publisher: arg("--publisher"), zipName: `${baseName}.zip`, digest, size: zipSize }), null, 2) + "\n", "utf8");

  console.log(
    `[pack] 完成 ${relative(ROOT, zipPath)}  ${(zipSize / 1048576).toFixed(1)} MiB  ${filesInStage.length} 条` +
      `\n        sha256 ${digest}` +
      `\n        entry  ${relative(ROOT, entryPath)}` +
      `\n        官方静态校验：${officialResult}`,
  );

  // 5) 收尾：暂存树是出包的中间产物，不留在现场。
  //    不清理的后果不是“占点空间”而是会误导：`_stage/<target>/` 里那份看着像可交付的树，
  //    实际是上一次运行时的形状，与刚出的包未必一致（本次就在此处差点误判）。
  //    出包失败时保留现场供排查（那些路径在 throw/exit 前不会走到这里）。
  //    先删本次 target，再把空的 `_stage` 本身也收走——只删前者会留个空壳，下轮看仍像现场。
  const stageRoot = join(ROOT, "..", "..", "build", "_stage");
  rmSync(join(stageRoot, target), { recursive: true, force: true });
  try {
    if (readdirSync(stageRoot).length === 0) rmSync(stageRoot, { recursive: true, force: true });
  } catch {
    /* 别的 target 还在（或目录已不在）：保留，不影响本次结果 */
  }
}

main();
