// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/index.mjs — 派生同步统一入口（apply / --check）
//
// ## 口径
//
// **派生同步** = 从某个源推导、写回目标文件。凡「能推导 + 被抄了多份 + 抄漏会坏」的事实都走
// 这里；只有人能定的东西（设计取舍、文案措辞、许可范围）不进本表。
//
// 两态：默认写回；`--check` 只校验、漂了就 exit 1（CI 门禁）。每个任务只声明「怎么从源算出
// 期望内容」，比较 / 写回 / 报告由框架统一做，各任务不必自带 CLI 与 check。
//
// ## 为什么不用"多个 sync-*.mjs"
//
// 本仓此前是每类同步一支脚本，各自带参数解析与 --check，于是同一件事（版本从哪来、漂了报什么）
// 有 N 份实现。任务表把它们收成一处，新增一类同步只加一个 plan()。
//
// ## 任务
//
//   version          manifest.json#version    → package.json#version（版本单一事实源在 manifest）
//   thirdparty       实装版本 + 仓库持有的法条正文 → THIRD_PARTY_NOTICES.md
//   api-reference    上游权限表（缓存）+ 已授权权限集 → skills/githana/references/*.md
//                    （`githana_api` 的裸调参考；数据源与缓存见 derive/api-source.mjs）
//
// 不进本表：
//   · NOTICE / 法条正文原文 —— 是人写/上游原文的法律文本，不是"能推导"的东西；
//   · 随包二进制（vendor/bin/）—— 由 fetch-vendor 按 sources.json 重建，源在网络上，
//     且它属于「拉取」而非「派生」（`node scripts/fetch-vendor.mjs --check` 单独把关）；
//   · 权限表缓存（.tmp/permission-table/）—— 同上，由 derive/fetch-permission-table.mjs 拉取，
//     入库会让仓库多一份会过期的复本。api-reference 只读那个缓存。
//
// 用法：
//   node scripts/derive/index.mjs               # 全部写回
//   node scripts/derive/index.mjs --check       # 全部校验（CI 门禁）
//   node scripts/derive/index.mjs version [...]  # 指定任务
//
// 派生目标一律「整份期望内容」比较：框架拿任务算出的内容与磁盘逐字比对，不一致才写。
// 好处是 diff 稳定（任务里不做局部替换，就没有顺序抖动的余地）。
import fs from "node:fs";
import { at, ROOT, rel } from "../shared/root.mjs";
import { errText } from "../shared/err-text.mjs";
import { isDirectRun } from "../shared/run.mjs";
import { parseArgs } from "node:util";
import { versionTask } from "./version.mjs";
import { thirdpartyTask } from "./thirdparty.mjs";
import { apiReferenceTask } from "./api-reference.mjs";

export { ROOT };

/** 一个派生文件的期望产物（rel 相对仓库根）。 */
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readText = (relPath) => fs.readFileSync(at(relPath), "utf8");
const exists = (relPath) => fs.existsSync(at(relPath));

/** 按主清单的版本重写某个 JSON 的 version 字段。 */
export function versionedJson(relPath, version) {
  const j = JSON.parse(readText(relPath));
  j.version = version;
  return { rel: relPath, content: jsonText(j) };
}

/** 全部任务（main 按名筛选用；执行顺序即数组顺序）。 */
export const TASKS = [versionTask, thirdpartyTask, apiReferenceTask];

/** 跑一个任务：比较期望内容与磁盘，写回或报漂。返回漂移文件数。 */
export function runTask(task, { checkOnly = false, log = console.log } = {}) {
  const files = task.plan();
  const stale = files.filter((f) => !exists(f.rel) || readText(f.rel) !== f.content);
  if (!stale.length) {
    log(`[derive] ${task.name}: 一致（${files.length} 个文件）`);
    return 0;
  }
  if (checkOnly) {
    log(`[derive] ${task.name}: 漂移 ${stale.length} 个文件（${task.about}）`);
    for (const f of stale) log(`  - ${f.rel}`);
    return stale.length;
  }
  for (const f of stale) {
    const to = at(f.rel);
    fs.mkdirSync(at(f.rel, ".."), { recursive: true });
    fs.writeFileSync(to, f.content, "utf8");
    log(`[derive] ${task.name}: 写回 ${f.rel}`);
  }
  return stale.length;
}

function main() {
  // 选项面显式声明，未知选项即拒：`--chekc` 这种拼错在旧写法里会被静默当成位置参数丢掉
  // （hasFlag("--check") 为 false、positionals([]) 又不看它），于是本该只校验的命令会去
  // **写回漂移文件**并成功退出。校验门禁最不能容忍这种“看似跑了、实则没跑”的失败。
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { check: { type: "boolean", short: "c" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    console.error(`[derive] 参数错误：${errText(e)}\n用法：node scripts/derive/index.mjs [--check] [任务名…]`);
    process.exit(2);
  }
  const checkOnly = parsed.values.check === true;
  const wanted = parsed.positionals;
  const tasks = wanted.length ? TASKS.filter((t) => wanted.includes(t.name)) : TASKS;
  const unknown = wanted.filter((w) => !TASKS.some((t) => t.name === w));
  if (unknown.length) {
    console.error(`[derive] 未知任务：${unknown.join(", ")}（已知：${TASKS.map((t) => t.name).join(", ")}）`);
    process.exit(2);
  }

  let drift = 0;
  try {
    for (const task of tasks) drift += runTask(task, { checkOnly });
  } catch (e) {
    console.error("[derive]", errText(e));
    process.exit(1);
  }

  if (checkOnly && drift) {
    console.error(`[derive] 派生文件漂移 ${drift} 处——跑 node scripts/derive/index.mjs 写回后提交`);
    process.exit(1);
  }
  console.log(
    `[derive] ${checkOnly ? "校验" : "派生"}完成：${tasks.length} 个任务，${drift} 个文件${checkOnly ? "漂移" : "写回"}`,
  );
}

if (isDirectRun(import.meta.url)) main();

export { rel };
