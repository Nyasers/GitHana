// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/fetch-vendor.mjs — 按平台重建内嵌运行时（零第三方依赖）。
 *
 * 来源与校验全部来自 vendor/sources.json（声明式）：本脚本只负责
 * 「选平台 → 下载 → sha256 校验 → 解压 → 规整成 bin.js 认得的树 → 验证 exe 存在」。
 *
 * 四条纪律：
 *   1) sha256 为空 = 本平台没提供可校验产物 → 明确跳过并告警（该组件回退系统 PATH），
 *      **不替它编一个哈希**；校验不通过一律不落盘。
 *   2) 解压后的树形可能带一层版本目录（不同 release 不一样）→ 自动摊平单层顶层目录。
 *   3) 落盘只保留 `keep` 声明的顶层条目的**内容**，平铺到组件根（缺省 `bin`）：上游产物的那层
 *      `bin/` 只是它自己的布局，而 `vendor/bin/<平台>/<组件>/` 已经声明了「这里是二进制」，
 *      再套一层纯属冗余。最终形态是 `vendor/bin/<平台>/<组件>/<exe>`。
 *      上游的 share/（man 手册）、LICENSE、卸载器、include/ 一律不进包；
 *      许可正文走 licenses/ 单一出口（见 sources.json 的 keep 说明）。
 *   4) `--check` 只校验现状，不下载；CI 用它把"声明了却没就绪"变成硬失败。
 *
 * **当前 sources.json 里没有任何组件**（无内嵌二进制：签名走纯 JS、git 用宿主那份），
 * 所以本脚本在正常仓态下是空操作。解压分支（targz / zip）保留供将来需要内嵌二进制时复用。
 *
 * 用法：
 *   node scripts/fetch-vendor.mjs                      # 当前平台全量
 *   node scripts/fetch-vendor.mjs <组件>                # 只补某组件
 *   node scripts/fetch-vendor.mjs --platform linux-x64 # 指定平台条目（跨平台准备）
 *   node scripts/fetch-vendor.mjs --check              # 只校验（不下载）
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = join(ROOT, "vendor", "sources.json");
const CACHE_DIR = join(ROOT, ".tmp", "vendor-dl");

const log = (...a) => console.log("[fetch-vendor]", ...a);
const rel = (p) => p.replace(ROOT, ".");

/** 组件落盘目录。运行时二进制统一收在 vendor/bin/ 下、与元数据分层（见 bin.js 头注与 .gitignore）。 */
function vendorComponentDir(platform, key) {
  return join(ROOT, "vendor", "bin", platform, key);
}

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
    ws.on("error", reject);
    // 等 close，不等 end()：end() 只表示写入队列排空，文件句柄要到 close 才释放。紧随其后的解压
    // 会打开同一个文件（Windows 上句柄未释放时打开会报 "being used by another process"，
    // CI win32 曾每次红在这一步）。等 close 还顺带保证落盘字节与已校验的哈希一致
    //（此前哈希取自流，文件可能仍是短的）。
    ws.on("close", resolve);
    (function pump() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            ws.end();
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

/**
 * 用 7z 解一个 7z / NSIS 容器到 destDir。
 *
 * 当前 sources.json 无组件使用它（无内嵌二进制），保留供将来需要拆 NSIS 类容器时复用。
 * 注：若重新启用，需重新引入 7z-wasm（devDependency）并处理 callMain 的行为：
 * 成功时正常返回，失败时**抛出数字**（7z 退出码，带位标志，不是 0/1）。
 */

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

/** 解压（按 extract 类型分派）。targz / zip 为当前保留的两种；NSIS（7z-bin）已随 gnupg 一起移除。 */
async function extract(spec, cacheFile, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });

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

/**
 * 把上游树规整成组件根平铺形态。
 *
 * 上游产物总带一批运行时用不到的东西（gnupg 的卸载器、include/、locale、share/man）——
 * 它们既增大包体，又给“许可文本该从哪读”制造歧义。
 *
 * `keep`（缺省 ["bin"]）列的是**要保留内容的顶层目录**，其内容平铺到组件根：
 * 上游的 `bin/<exe>` 变成组件根的 `<exe>`（而不是 `bin/<exe>`）。上游那层 bin 只是它的布局，
 * 而 vendor/bin/<平台>/<组件>/ 已经声明了「这里是二进制」，再套一层纯属冗余，
 * 也让“exe 到底在第几层”重新变成需要判断的事。
 *
 * `keep: "all"` 保留整树，不做平铺：只有上游本身已经是“组件根就是二进制”时才用（如 GnuPG：
 * 它的 7z 分支已经只取了 bin/ 的内容，再按缺省 keep 裁一次会把内容删空）。
 */
function applyKeep(destRoot, spec) {
  if (spec.keep === "all") return;
  const wanted = keepDirs(spec);

  // 先把每个 keep 条的**子项**搬到中转目录：不能就地移，因为子项名可能与另一个待搬家
  // 条目的名字撞车（先移谁后移谁结果不一样）。
  const stash = join(destRoot, ".keep-stash");
  rmSync(stash, { recursive: true, force: true });
  mkdirSync(stash, { recursive: true });
  for (const name of wanted) {
    const from = join(destRoot, name);
    if (!existsSync(from)) continue;
    renameSync(from, join(stash, name));
  }
  // 再清掉其余顶层条目（这就是“裁减”本身），最后把中转内容摊回组件根。
  for (const name of readdirSync(destRoot)) {
    if (name === ".keep-stash") continue;
    rmSync(join(destRoot, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(stash)) {
    const from = join(stash, name);
    for (const child of readdirSync(from)) {
      renameSync(join(from, child), join(destRoot, child));
    }
    rmSync(from, { recursive: true, force: true });
  }
  rmSync(stash, { recursive: true, force: true });
}

/** keep 声明的顶层目录名（缺省 ["bin"]）。 */
function keepDirs(spec) {
  return Array.isArray(spec.keep) && spec.keep.length > 0 ? spec.keep : ["bin"];
}

/**
 * 上游树里 exe 的候选路径。
 *
 * `spec.exe` 写的是**落盘位置**（相对组件根，如 `gpg.exe` / `cmd/git.exe`）——因为 bin.js、
 * pack、selfcheck 三个消费者要的都是它能直接拼接的位置。而上游树里它可能还套着一层 keep 目录
 * （上游的 bin/gpg.exe → 落盘 gpg.exe），所以解压后要找的路要反推回去。
 */
function upstreamExePaths(spec) {
  if (spec.keep === "all") return [spec.exe];
  return keepDirs(spec).map((name) => (spec.exe === name ? name : `${name}/${spec.exe}`));
}

/** 单组件处理。 */
async function fetchOne(key, spec, platform) {
  if (!spec.sha256) {
    log(`跳过 ${key}：本平台（${platform}）未提供可校验产物 → 该组件将回退系统 PATH`);
    return { key, status: "skipped" };
  }
  const destRoot = vendorComponentDir(platform, key);
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
  await extract(spec, cacheFile, destRoot);

  // 摊平要在裁减前：裁减按顶层条目判断，摊平前顶层只有那一个版本目录。
  // 这一步要找的是**上游**路径（可能还套着 keep 那一层），不是落盘路径。
  const found = upstreamExePaths(spec).some((p) => flattenIfNested(destRoot, p));
  if (!found) {
    throw new Error(
      `解压后找不到 ${upstreamExePaths(spec).join(" / ")}，asset 结构可能变了（${rel(destRoot)}）`
    );
  }
  applyKeep(destRoot, spec);
  if (!existsSync(join(destRoot, spec.exe))) {
    throw new Error(`keep 规整后 ${spec.exe} 不在组件根（keep 声明与 exe 位置对不上）：${rel(destRoot)}`);
  }
  log(spec.label, spec.version, "就绪：", rel(join(destRoot, spec.exe)));
  return { key, status: "ok" };
}

/** --check：只校验现状。声明了 sha256 的组件必须就绪，否则退出码非零。 */
function check(platform, components) {
  let allOk = true;
  for (const [key, spec] of Object.entries(components)) {
    const exePath = join(vendorComponentDir(platform, key), spec.exe);
    if (existsSync(exePath)) {
      log("就绪", key, spec.version, rel(exePath));
    } else if (!spec.sha256) {
      log("未内嵌", key, `（${platform} 无声明产物）`, "→ 走宿主 / 系统 PATH");
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
  const keys = wanted.length > 0 ? wanted : Object.keys(entry.components);
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
