// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/fetch-vendor.mjs — 按平台重建内嵌运行时（零第三方依赖）。
 *
 * 来源与校验全部来自 vendor/sources.json（声明式）：本脚本只负责
 * 「选平台 → 下载 → sha256 校验 → 解压 → 规整成 bin.js 认得的树 → 验证 exe 存在」。
 *
 * 三条纪律：
 *   1) sha256 为空 = 本平台没提供可校验产物 → 明确跳过并告警（该组件回退系统 PATH），
 *      **不替它编一个哈希**；校验不通过一律不落盘。
 *   2) 解压后的树形可能带一层版本目录（不同 release 不一样）→ 自动摊平单层顶层目录。
 *   3) `--check` 只校验现状，不下载；CI 用它把"声明了却没就绪"变成硬失败。
 *
 * 用法：
 *   node scripts/fetch-vendor.mjs                      # 当前平台全量
 *   node scripts/fetch-vendor.mjs gh                   # 只补某组件
 *   node scripts/fetch-vendor.mjs --platform linux-x64 # 指定平台条目（跨平台准备）
 *   node scripts/fetch-vendor.mjs --check              # 只校验（不下载）
 *
 * 解压工具依赖：zip 在 Windows/macOS 用 tar（bsdtar 支持 zip），Linux 用 unzip；
 * targz 用 tar；7z-bin（GnuPG 的 NSIS 容器）需要 7z（Windows 侧置备）。
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, copyFileSync, unlinkSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = join(ROOT, "vendor", "sources.json");
const CACHE_DIR = join(ROOT, "_tmp", "vendor-dl");
const XTMP = join(ROOT, "_tmp", "vendor-x");

const log = (...a) => console.log("[fetch-vendor]", ...a);
const rel = (p) => p.replace(ROOT, ".");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 平台键：--platform 覆盖，否则用运行时平台。 */
function platformKey(argv) {
  const i = argv.indexOf("--platform");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return `${process.platform}-${process.arch}`;
}

/** 下载（流式 + 边下边算哈希）；返回缓存文件路径。 */
async function download(spec, cacheFile) {
  mkdirSync(CACHE_DIR, { recursive: true });
  log("下载", spec.label, spec.version, "→", spec.asset, "…");
  const res = await fetch(spec.url);
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）：${spec.url}`);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(cacheFile);
    const reader = res.body.getReader();
    (function pump() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            ws.end();
            resolve();
            return;
          }
          hash.update(value);
          ws.write(value, (err) => (err ? reject(err) : pump()));
        })
        .catch(reject);
    })();
  });
  const got = hash.digest("hex");
  if (got !== spec.sha256) {
    rmSync(cacheFile, { force: true });
    throw new Error(`sha256 校验失败：${spec.asset}\n期望 ${spec.sha256}\n实际 ${got}\n已删除，不落未校验二进制。`);
  }
  log("sha256 校验通过");
}

/** 摊平单层顶层目录：解压后若 exe 不在预期位置，且只套了一层目录，则把内容上移。 */
function flattenIfNested(destRoot, exeRel) {
  if (existsSync(join(destRoot, exeRel))) return true;
  let entries;
  try {
    entries = readdirSync(destRoot);
  } catch {
    return false;
  }
  const dirs = entries.filter((n) => statSync(join(destRoot, n)).isDirectory());
  if (dirs.length !== 1) return existsSync(join(destRoot, exeRel));
  const inner = join(destRoot, dirs[0]);
  if (!existsSync(join(inner, exeRel))) return existsSync(join(destRoot, exeRel));
  log("摊平单层目录", dirs[0]);
  for (const name of readdirSync(inner)) renameSync(join(inner, name), join(destRoot, name));
  rmSync(inner, { recursive: true, force: true });
  return existsSync(join(destRoot, exeRel));
}

/** 解压（按 extract 类型分派）。 */
function extract(spec, cacheFile, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });

  if (spec.extract === "7z-bin") {
    // GnuPG 的 NSIS/7z 容器：解到临时目录后只取 bin/
    rmSync(XTMP, { recursive: true, force: true });
    mkdirSync(XTMP, { recursive: true });
    execFileSync("7z", ["x", cacheFile, "-o" + XTMP, "-y"], { stdio: "inherit" });
    const binDir = join(destRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    execFileSync("cmd", ["/c", "xcopy", join(XTMP, "bin"), binDir, "/E", "/I", "/Y", "/Q"], { stdio: "ignore" });
    // NSIS 中间态残留 + scoop 同款 gpg2.exe
    for (const f of readdirSync(binDir)) {
      if (f.endsWith(".exe.tmp")) unlinkSync(join(binDir, f));
    }
    const gpg = join(binDir, "gpg.exe");
    if (existsSync(gpg)) copyFileSync(gpg, join(binDir, "gpg2.exe"));
    // 隔离前提：删除 gpgconf.ctl（有它 = 便携模式恒指 scoop home、忽略 GNUPGHOME）
    const ctl = join(binDir, "gpgconf.ctl");
    if (existsSync(ctl)) {
      rmSync(ctl, { force: true });
      log("已删除 gpgconf.ctl（原生模式：认 GNUPGHOME）");
    }
    rmSync(XTMP, { recursive: true, force: true });
    return;
  }

  if (spec.extract === "targz") {
    execFileSync("tar", ["-xzf", cacheFile, "-C", destRoot], { stdio: "inherit" });
    return;
  }

  // zip：Windows/macOS 的 tar 是 bsdtar（认 zip）；Linux 的 GNU tar 不认 → unzip
  if (process.platform === "linux") {
    execFileSync("unzip", ["-q", "-o", cacheFile, "-d", destRoot], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", cacheFile, "-C", destRoot], { stdio: "inherit" });
  }
}

/** 单组件处理。 */
async function fetchOne(key, spec, platform) {
  if (!spec.sha256) {
    log(`跳过 ${key}：本平台（${platform}）未提供可校验产物 → 该组件将回退系统 PATH`);
    return { key, status: "skipped" };
  }
  const destRoot = join(ROOT, "vendor", platform, key);
  const cacheFile = join(CACHE_DIR, spec.asset);

  let ready = false;
  if (existsSync(cacheFile)) {
    try {
      if (sha256File(cacheFile) === spec.sha256) {
        log(spec.label, spec.version, "命中下载缓存", spec.asset);
        ready = true;
      } else {
        log(spec.label, "缓存校验不一致，重新下载");
        rmSync(cacheFile, { force: true });
      }
    } catch {
      rmSync(cacheFile, { force: true });
    }
  }
  if (!ready) await download(spec, cacheFile);

  log("解压 →", rel(destRoot));
  extract(spec, cacheFile, destRoot);

  if (!flattenIfNested(destRoot, spec.exe)) {
    throw new Error(`解压后未找到 ${rel(join(destRoot, spec.exe))}，asset 结构可能变了`);
  }
  log(spec.label, spec.version, "就绪：", rel(join(destRoot, spec.exe)));
  return { key, status: "ok" };
}

/** --check：只校验现状。声明了 sha256 的组件必须就绪，否则退出码非零。 */
function check(platform, components) {
  let allOk = true;
  for (const [key, spec] of Object.entries(components)) {
    const exePath = join(ROOT, "vendor", platform, key, spec.exe);
    if (existsSync(exePath)) {
      log("就绪", key, spec.version, rel(exePath));
    } else if (!spec.sha256 || spec.optional) {
      log("未内嵌", key, spec.optional ? "（optional：宿主已有或需要时再抓）" : `（${platform} 无声明产物）`, "→ 走宿主 / 系统 PATH");
    } else {
      allOk = false;
      log("缺失", key, rel(exePath), `（运行 node scripts/fetch-vendor.mjs --platform ${platform} ${key} 补全）`);
    }
  }
  process.exitCode = allOk ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(SOURCES, "utf8"));
  } catch (e) {
    console.error("[fetch-vendor] 读不到 vendor/sources.json：", (e && e.message) || e);
    process.exit(1);
  }

  const platform = platformKey(argv);
  const entry = manifest.platforms && manifest.platforms[platform];
  if (!entry || !entry.components) {
    log(`本平台（${platform}）在 sources.json 里没有声明：所有组件走系统 PATH，无需 vendor。`);
    return;
  }

  const wanted = argv.filter((a) => !a.startsWith("-") && a !== platform);
  // 默认只处理“必带”组件；optional 的（如 Windows 上的 git，宿主已捆绑）需要显式点名才抓，
  // 避免白扛几十 MB。仍保留声明是为了“想要自包含包时一条命令就能重建”。
  const keys = wanted.length > 0 ? wanted : Object.keys(entry.components).filter((k) => !entry.components[k].optional);
  for (const key of keys) {
    if (!entry.components[key]) {
      throw new Error(`未知组件：${key}（${platform} 可选：${Object.keys(entry.components).join("/")}）`);
    }
  }

  if (argv.includes("--check")) return check(platform, entry.components);

  const results = [];
  for (const key of keys) {
    results.push(await fetchOne(key, entry.components[key], platform));
  }
  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  log(`完成：${platform} 就绪 ${ok} 个，跳过 ${skipped} 个。vendor/ 不入 git，打包随包分发。`);
}

main().catch((err) => {
  console.error("[fetch-vendor] 失败：", (err && err.message) || err);
  process.exit(1);
});
