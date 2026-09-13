// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-index.mjs — 从出包产物拼出市场清单 index.v2.json。
 *
 * 为什么需要它：App Creator 的索引构建器（extension-index-build.mjs）只吃 `*.entry.json`——
 * 也就是包工具要同时产出「ZIP + entry 元数据」。官方包工具如此，我们自己出包也必须如此，
 * 否则清单拼不出来。`scripts/pack.mjs` 已负责产出 entry，本脚本负责拼索引。
 *
 * ## 一个必须知道的限制：索引模型是"每个版本一个归档"
 *
 * index.v2.json 的 item 只有 `archive.url` 一个地址，**没有平台维度**；构建器按 `kind:id`
 * 分组，同组的多个条目会被折成「最新版 + versions[]」。所以我们按平台出的多份 ZIP
 * 不可能各占一条。本脚本因此默认只把 `universal`（不随平台 vendor 的兜底包）放进清单，
 * 平台包留在 release 资产里按名取用。要多目标进清单，得先有带平台维度的索引格式。
 *
 * 用法：
 *   node scripts/build-index.mjs --base-url https://github.com/<owner>/<repo>/releases/download/v<ver>
 *   node scripts/build-index.mjs --include win32-x64,universal --out ./index.v2.json
 *
 * 选项：
 *   --entries <dir>     entry.json 所在目录（默认 <app>/../../build/<id>/releases）
 *   --base-url <https>  归档下载基址（默认从 git remote origin + manifest 版本推导）
 *   --source-id <id>    市场源标识（默认用 manifest.id）
 *   --name <name>       市场源显示名（默认用 manifest.name）
 *   --include <list>    逗号分隔，挑选哪些 target 的 entry 进清单（默认 universal）
 *   --out <file>        输出路径（默认 <entries>/index.v2.json）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

/** 索引构建器：仓库内拷贝优先（它只依赖 node 内建，可独立运行），其次 HANA_APP_TOOLS_ROOT，再次本机 Hana（取最新版本）。 */
function findIndexBuilder() {
  const cands = [join(ROOT, "scripts", "hana-app-tools", "extension-index-build.mjs")];
  if (process.env.HANA_APP_TOOLS_ROOT) {
    cands.push(join(process.env.HANA_APP_TOOLS_ROOT, "scripts", "extension-index-build.mjs"));
  }
  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (existsSync(serverRoot)) {
    const versions = readdirSync(serverRoot).filter((v) =>
      existsSync(join(serverRoot, v, "scripts", "extension-index-build.mjs")),
    );
    versions.sort((a, b) => {
      const pa = a.split("-")[0].split(".").map(Number);
      const pb = b.split("-")[0].split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pb[i] || 0) - (pa[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
    for (const v of versions) cands.push(join(serverRoot, v, "scripts", "extension-index-build.mjs"));
  }
  return cands.find((c) => existsSync(c)) || null;
}

/** 默认基址：git remote origin（github.com/owner/repo）+ releases/download/v<version>。 */
function defaultBaseUrl() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
    if (m) return `https://github.com/${m[1]}/${m[2]}/releases/download/v${manifest.version}`;
  } catch {
    /* 没有 remote 就走下面的报错 */
  }
  return null;
}

const entriesDir = resolve(arg("--entries") || join(ROOT, "..", "..", "build", manifest.id, "releases"));
if (!existsSync(entriesDir)) {
  console.error(`[build-index] entry 目录不存在：${entriesDir}\n  先出包：node scripts/pack.mjs --target universal`);
  process.exit(1);
}

const baseUrl = arg("--base-url") || defaultBaseUrl();
if (!baseUrl) {
  console.error("[build-index] 拿不到 --base-url（且无法从 git remote 推导）：索引里的归档地址需要一个 https 基址");
  process.exit(1);
}

const include = (arg("--include") || "universal")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (include.length !== 1 || include[0] !== "universal") {
  // 索引当前只指 universal：index.v2.json 的 item 只有 archive.url、没有平台维度，
  // 多平台包挤不进同一条；指向某个平台包会让其它平台的机器装到不合身的包。
  console.warn(
    `[build-index] 注意：--include=${include.join(",")} 不是 universal。` +
      `市场清单按当前格式只应指向 universal（平台包留给 release 资产按名取用）。`,
  );
}
const out = resolve(arg("--out") || join(entriesDir, "index.v2.json"));

// 只把选中的 entry 拷进暂存目录：构建器会读目录下**所有** *.entry.json
const stageDir = join(entriesDir, "_index-input");
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
let picked = 0;
for (const name of readdirSync(entriesDir)) {
  if (!name.endsWith(".entry.json")) continue;
  if (!include.some((t) => name.includes(`-${t}.entry.json`))) continue;
  copyFileSync(join(entriesDir, name), join(stageDir, name));
  picked += 1;
}
if (picked === 0) {
  console.error(
    `[build-index] 没有匹配 --include=${include.join(",")} 的 entry（目录：${entriesDir}）\n` +
      `  该 target 是否已出包？多平台 ZIP 不能各占一条清单项，见本文件头注。`,
  );
  rmSync(stageDir, { recursive: true, force: true });
  process.exit(1);
}

const builder = findIndexBuilder();
if (!builder) {
  console.error("[build-index] 找不到 extension-index-build.mjs（仓库内与本机都没有）");
  rmSync(stageDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`[build-index] 选中 ${picked} 个 entry（${include.join(",")}），基址 ${baseUrl}`);
try {
  execFileSync(
    process.execPath,
    [
      builder,
      "--entries", stageDir,
      "--base-url", baseUrl,
      "--source-id", arg("--source-id") || manifest.id,
      "--name", arg("--name") || manifest.name || manifest.id,
      "--out", out,
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
console.log(`[build-index] 完成 ${out}`);
