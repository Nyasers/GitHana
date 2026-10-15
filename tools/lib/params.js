// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/params.js — 跨 action 共用的字段定义（zod）。
 *
 * 被两个以上 action 用到的键在这里定义一次，各 action 只 import，避免同一个键在几处各写一份
 * 后各自漂移。字段的**形状**（类型 / 枚举 / 范围）在这里与各 action 的 schema 里是唯一来源：
 * 工具的 `parameters` 由 `z.toJSONSchema` 从同一份定义生成，运行期校验也用同一份
 * （见 tools/lib/surface.js）。
 *
 * 名词分家后，同一个键在不同工具里有不同含义的情形消失了：`method` 只属于 `githana_api`
 * 的 HTTP 方法，`body` 在 `githana_api` 上是 JSON 对象、在 `githana_pr` 的 create / comment /
 * review 上是 Markdown 正文字符串——两者已不在同一个参数表里，各自的取值域写在各自 action 的
 * schema 上（那才是运行期生效的那份），不必再在这里合并成一份中性描述。
 *
 * 必填与否**不在这里一刀切**：同一个键在不同 action 上要求不同（cwd 对 git 动作必填、对
 * `githana_pr` 的多数动词可选；prNumber 对 merge / revert 必填、对 view 可缺省）。所以同一个键
 * 给出两个变体，名字表明形态，各 action 取自己要的那个——必填这件事写在用它的地方，不靠合并
 * 顺序去猜。
 */
import { z } from "zod";

/** 工作目录（仓库绝对路径）：仓库上下文一律显式传参，不做工作目录隐式推断。 */
export const cwd = z
  .string()
  .describe(
    "本地仓库绝对路径（如 E:\\workspace\\my-repo）。仓库上下文一律显式传参、不做隐式推断；哪些动词必填见各 action 的参数说明",
  );

/** 工作目录：只作兜底的 GitHub 动作可选（不用它取缺省值；见各 action 的 run()）。 */
export const cwdOptional = cwd.optional();

/** 仓库上下文（githana_repo / pr / issue / label 的各动词共用）。 */
export const repo = z
  .string()
  .optional()
  .describe("可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；缺省从 cwd 的 git remote 推断");

/** 超时（git 动作默认 120 秒，GitHub 动作默认 60 秒）。 */
export const timeoutSec = z
  .number()
  .int()
  .min(1)
  .max(600)
  .optional()
  .describe("超时秒数（可选）：git 动作默认 120，GitHub 动作默认 60；上限 600");

/** PR 编号：正整数（merge / revert 等不可撤销的动词必填）。 */
export const prNumber = z.number().int().min(1).describe("PR 编号（正整数）");

/** PR 编号：可缺省 = 当前分支关联 PR（需要 cwd）。 */
export const prNumberOptional = prNumber
  .optional()
  .describe("PR 编号（正整数）；缺省 = 当前分支关联 PR（需要 cwd）");

/**
 * issue 编号：正整数，**必填**。
 *
 * 与 prNumber 不同，issue 没有「当前分支关联 issue」这回事——那个概念只对 PR 成立。所以这里
 * 只有必填一个变体：`prNumberOptional` 的缺省逻辑（按 head 分支过滤）在 issue 上无对应物，
 * 照搬会造出一个语义不成立的参数。
 */
export const issueNumber = z.number().int().min(1).describe("issue 编号（正整数）");
