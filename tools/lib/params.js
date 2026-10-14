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
 * 必填与否**不在这里一刀切**：同一个键在不同 action 上要求不同（cwd 对 git 动作必填、对
 * GitHub 动作可选；prNumber 对 pr_merge 必填、对 pr_view 可缺省）。所以同一个键给出两个变体，
 * 名字表明形态，各 action 取自己要的那个——必填这件事写在用它的地方，不靠合并顺序去猜。
 *
 * 取值域同理：`method` 在 `api` 上是 HTTP 方法（写面全量方法，只读面只收 GET / HEAD），在
 * `pr_merge` 上是合并方式（merge / squash / rebase）；`body` 在 `api` 上是 JSON 对象，在
 * `pr_create` 上是 PR 正文字符串。这类同键不同义的键，共用定义只给**中性的**描述，精确的
 * enum / 类型落在各 action 的 schema 里（那才是运行期生效的那份）。
 */
import { z } from "zod";

/** cwd 的描述：git 动作必填、GitHub 动作可选，两种用法共用这一句。 */
const CWD_DESC =
  "本地仓库绝对路径（如 E:\\workspace\\my-repo）：status / log / exec / commit / push 必填（仓库上下文显式传参，不做隐式推断）；pr_* 可选（从 git remote 推断仓库兜底，pr_create / pr_view 另用它取当前分支与缺省值）";

/** 工作目录：git 动作必填。 */
export const cwd = z.string().describe(CWD_DESC);

/** 工作目录：GitHub 动作与 api 可选（api 收到它也不用；见各 action 的 run()）。 */
export const cwdOptional = cwd.optional();

/** 仓库上下文（api / pr_create / pr_list / pr_view / pr_merge 共用）。 */
export const repo = z
  .string()
  .optional()
  .describe(
    "可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；api 传了就替换 path 里的 {owner}/{repo} 占位符；pr_* 显式传则优先于 cwd 推断",
  );

/** 超时（git 动作默认 120 秒，GitHub 动作默认 60 秒）。 */
export const timeoutSec = z
  .number()
  .int()
  .min(1)
  .max(600)
  .optional()
  .describe("超时秒数（可选）：git 动作默认 120，GitHub 动作默认 60；上限 600");

/**
 * method：api 的 HTTP 方法 与 pr_merge 的合并方式（同键不同义，见文件头注）。
 * 这里不带 enum：api 的取值域随所在面变（只读面只收 GET / HEAD），白名单在 run() 里判——
 * 那条拒绝文案要指向另一个面，写进 enum 会被参数校验的 issues 抢先（见 tools/actions/api.js）。
 */
export const method = z
  .string()
  .optional()
  .describe(
    "api：HTTP 方法，缺省 GET（githana 接受 GET / POST / PATCH / PUT / DELETE；githana_read 只接受 GET / HEAD）；pr_merge：合并方式，默认 merge（merge / squash / rebase）",
  );

/** body：api 的 JSON 请求体 与 pr_create 的 PR 正文（同键不同义，见文件头注）。 */
export const body = z
  .unknown()
  .optional()
  .describe(
    "api：请求体（JSON 对象），用于 POST / PATCH / PUT；pr_create：PR 正文（字符串，可选，支持 Markdown 与中文）",
  );

/** PR 编号：正整数。 */
export const prNumber = z.number().int().min(1).describe("PR 编号（正整数）");

/** PR 编号：pr_view 可缺省 = 当前分支关联 PR。 */
export const prNumberOptional = prNumber
  .optional()
  .describe("PR 编号（正整数）；缺省 = 当前分支关联 PR（需要 cwd）");
