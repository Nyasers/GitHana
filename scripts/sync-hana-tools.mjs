// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/sync-hana-tools.mjs — 从本机 Hana 安装刷新 scripts/hana-app-tools/ 里的官方工具拷贝。
 *
 * 为什么需要它：官方作者工具随 Hana 分发、与本仓库解耦，所以仓库里那份拷贝会随 Hana 升级而过期。
 * 这个脚本把"刷新 + 记录来源（版本/哈希）"变成一条命令，避免靠记忆。
 *
 * 用法：
 *   node scripts/sync-hana-tools.mjs           # 拷贝并更新 PROVENANCE.json
 *   node scripts/sync-hana-tools.mjs --check   # 只比对，不写（CI 可用来发现漂移）
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST_DIR = join(ROOT, "scripts", "hana-app-tools");
const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");
const TOOLS = ["validate-app.mjs"];

/** 定位本机 Hana 里的官方脚本目录 + 版本号。 */
function locateSource() {
  const cands = [];
  if (process.env.HANA_APP_TOOLS_ROOT) {
    cands.push({ dir: join(process.env.HANA_APP_TOOLS_ROOT, "scripts"), version: "unknown(HANA_APP_TOOLS_ROOT)" });
  }
  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (existsSync(serverRoot)) {
    for (const v of readdirSync(serverRoot)) cands.push({ dir: join(serverRoot, v, "scripts"), version: v });
  }
  for (const c of cands) {
    if (TOOLS.every((t) => existsSync(join(c.dir, t)))) return c;
  }
  console.error(
    `[sync-hana-tools] 在本机找不到官方脚本目录。试过：\n  ${cands.map((c) => c.dir).join("\n  ")}\n` +
      `设 HANA_APP_TOOLS_ROOT 或 HANA_HOME 指向 Hana 安装。`,
  );
  process.exit(1);
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const src = locateSource();
const checkOnly = process.argv.includes("--check");

let drift = false;
const tools = {};
for (const name of TOOLS) {
  const from = join(src.dir, name);
  const to = join(DEST_DIR, name);
  const srcHash = sha256(from);
  const hasCopy = existsSync(to);
  const copyHash = hasCopy ? sha256(to) : null;
  if (checkOnly) {
    const same = hasCopy && copyHash === srcHash;
    if (!same) drift = true;
    console.log(`[sync-hana-tools] ${name}: ${same ? "与 Hana " + src.version + " 一致" : "有漂移（本机 Hana " + src.version + "）"}`);
  } else {
    copyFileSync(from, to);
    console.log(`[sync-hana-tools] ${name} 已刷新（源 Hana ${src.version}）`);
  }
  tools[name] = {
    source: `<HANA_HOME>/artifacts/server/${src.version}/scripts/${name}`,
    hanaVersion: src.version,
    copiedAt: new Date().toISOString().slice(0, 10),
    bytes: readFileSync(from).length,
    sha256: srcHash,
  };
}

if (checkOnly) {
  console.log(`[sync-hana-tools] 结果：${drift ? "发现漂移（与该 Hana 版本不一致）" : "一致"}`);
  process.exit(drift ? 1 : 0);
}

const provPath = join(DEST_DIR, "PROVENANCE.json");
const prev = existsSync(provPath) ? JSON.parse(readFileSync(provPath, "utf8")) : {};
writeFileSync(
  provPath,
  JSON.stringify(
    {
      note:
        prev.note ||
        "本目录是 Hana 自带作者工具的原样拷贝（verbatim），用于让本仓库与 CI 不依赖本机 Hana 安装即可跑官方静态校验。刷新见 README.md。",
      tools,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`[sync-hana-tools] PROVENANCE.json 已更新（${relative(ROOT, provPath)}）`);
