// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/fetch-permission-table.mjs — 拉取上游「按权限索引端点」表到本地缓存
//
// 与 `scripts/fetch-vendor.mjs` 同一条纪律：**拉取与派生分开**。上游表在网络上，属于「拉取」；
// `derive` 只负责「从手边的源算期望产物」。分开的好处是 CI 与离线重跑都能只跑 derive。
//
// ## 缓存位置与是否入库
//
// 落在 `.tmp/permission-table/`（`.tmp*` 已被 .gitignore 覆盖，不入库）。理由是这张表是
// **上游数据的快照**：入库会让仓库里多一份会过期的复本，而它随时可以重拉。不入库的代价是
// CI 要先跑一次本脚本——与 CI 现有做法一致（那里也是先 `fetch-vendor` 再 `check`）。
//
// ## 版本钉死
//
// 路径里的 `fpt-2026-03-10` 是 GitHub 的 API 版本段。**不跟随 main**：上游改版时目录名会变，
// 静默跟随会让产物内容某天一整个变样而没有触发点。升级是有意动作，见 api-reference.mjs 的文件头。
//
// ## 校验
//
// 落盘前断言形状（是对象、至少含若干权限键、每个条目有 verb/requestPath），并记 sha256。
// 形状不对就拒绝落盘——「拉到了一份 404 页面」不该被当成有效输入。
//
// 用法：
//   node scripts/derive/fetch-permission-table.mjs            # 拉取（已存在则跳过，除非 --force）
//   node scripts/derive/fetch-permission-table.mjs --force    # 强制重拉
//   node scripts/derive/fetch-permission-table.mjs --check    # 只校验缓存现状，不下载
import fs from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { at } from "../shared/root.mjs";
import { errText } from "../shared/err-text.mjs";
import { isDirectRun } from "../shared/run.mjs";

/** 数据源与缓存位置（与 api-reference.mjs 共用一份，避免两处各写一遍）。 */
import { API_VERSION, SOURCE, CACHE_DIR, CACHE_FILE } from "./api-source.mjs";

/** 断言上游表形状；不满足即抛（拒绝把非表内容落盘）。 */
function validateTable(json, source) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`不是对象（可能是 404 页面 / 别的内容）：${source}`);
  }
  const keys = Object.keys(json);
  if (keys.length < 50) throw new Error(`权限键只有 ${keys.length} 个，不像是完整的表：${source}`);
  let entries = 0;
  for (const k of keys) {
    const v = json[k];
    if (!v || !Array.isArray(v.permissions)) throw new Error(`权限 ${k} 没有 permissions 数组：${source}`);
    for (const e of v.permissions) {
      if (!e || typeof e.verb !== "string" || typeof e.requestPath !== "string") {
        throw new Error(`权限 ${k} 下有条目缺 verb / requestPath：${source}`);
      }
      entries += 1;
    }
  }
  if (entries < 500) throw new Error(`端点条目只有 ${entries} 条，不像是完整的表：${source}`);
  return { permissions: keys.length, entries };
}

/** 缓存是否就绪（形状可读）。返回 null 或统计。 */
export function cacheStatus() {
  const p = at(CACHE_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return validateTable(JSON.parse(fs.readFileSync(p, "utf8")), CACHE_FILE);
  } catch {
    return null;
  }
}

export { CACHE_FILE, CACHE_DIR };

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { force: { type: "boolean" }, check: { type: "boolean", short: "c" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (e) {
    console.error(`[permission-table] 参数错误：${errText(e)}\n用法：node scripts/derive/fetch-permission-table.mjs [--force] [--check]`);
    process.exit(2);
  }
  const checkOnly = parsed.values.check === true;
  const force = parsed.values.force === true;

  const existing = cacheStatus();
  if (checkOnly) {
    if (!existing) {
      console.error(`[permission-table] 缓存缺失或形状不对：${CACHE_FILE}\n  跑 node scripts/derive/fetch-permission-table.mjs 拉取`);
      process.exit(1);
    }
    console.log(`[permission-table] 缓存就绪：${existing.permissions} 个权限，${existing.entries} 条端点（${API_VERSION}）`);
    return;
  }

  if (existing && !force) {
    console.log(`[permission-table] 缓存已就绪（${existing.permissions} 权限 / ${existing.entries} 端点），跳过。要重拉用 --force`);
    return;
  }

  console.log(`[permission-table] 拉取 ${API_VERSION} …`);
  let res;
  try {
    res = await fetch(SOURCE, { signal: AbortSignal.timeout(180000) });
  } catch (e) {
    console.error(`[permission-table] 拉取失败（网络）：${errText(e)}\n  ${SOURCE}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[permission-table] 拉取失败（HTTP ${res.status}）：${SOURCE}`);
    process.exit(1);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[permission-table] 返回的不是 JSON（${text.length} 字节）——上游可能改版或临时异常：${SOURCE}`);
    process.exit(1);
  }
  const stat = validateTable(json, SOURCE);

  fs.mkdirSync(at(CACHE_DIR), { recursive: true });
  const tmp = at(CACHE_FILE) + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, at(CACHE_FILE));
  const sha = createHash("sha256").update(text).digest("hex");
  console.log(`[permission-table] 完成：${stat.permissions} 个权限，${stat.entries} 条端点`);
  console.log(`[permission-table] sha256 ${sha}`);
  console.log(`[permission-table] 落在 ${CACHE_FILE}（不入库）`);
}

if (isDirectRun(import.meta.url)) main();
