// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/params.js — 跨 action 共用的参数片段（JSON Schema）。
 *
 * 工具的 parameters 是把各 action 的 fields **合并成的一张平表**（与收敛前的 gh_pr 同形），
 * 同键只留第一次出现的那份。字段若在多个 action 里各写一份，生效的只是"表里靠前的那个"，
 * 另一份会静默丢掉——所以被两个以上 action 用到的键在这里定义一次，各 action 只 import。
 *
 * 合并成平表带来两处**同键不同义**，都不带 type / enum，只把两种用法写进描述；取值校验仍由
 * 各 action 的 run() 按收敛前的口径做（逐条不变）。把逐 action 的精确 schema（oneOf 分支、
 * 各自的 enum）恢复出来是阶段 B 的 discriminatedUnion（见 spec D5）：
 *   · method：api 是 HTTP 方法；pr_merge 是合并方式
 *   · body：api 是 JSON 对象；pr_create 是 PR 正文字符串
 * 同理 cwd 在两个面上语义不同（git 动作必填、GitHub 动作可选），合并后的描述把两种都说清，
 * 必填与否由各 action 自己校验。
 */

/** 工作目录：git 动作必填，GitHub 动作用来推断仓库 / 取当前分支（可选）。 */
export const cwd = {
  type: "string",
  description:
    "本地仓库绝对路径（如 E:\\workspace\\my-repo）：status / log / exec / commit / push 必填（仓库上下文显式传参，不做隐式推断）；pr_* 可选（从 git remote 推断仓库兜底，pr_create / pr_view 另用它取当前分支与缺省值）",
};

/** 仓库上下文（api / pr_create / pr_list / pr_view / pr_merge 共用）。 */
export const repo = {
  type: "string",
  description:
    "可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；api 传了就替换 path 里的 {owner}/{repo} 占位符；pr_* 显式传则优先于 cwd 推断",
};

/** 超时（git 动作默认 120 秒，GitHub 动作默认 60 秒）。 */
export const timeoutSec = {
  type: "integer",
  minimum: 1,
  maximum: 600,
  description: "超时秒数（可选）：git 动作默认 120，GitHub 动作默认 60；上限 600",
};

/** method：api 的 HTTP 方法 与 pr_merge 的合并方式（同键不同义，见文件头注）。 */
export const method = {
  description:
    "api：HTTP 方法，缺省 GET（githana 接受 GET / POST / PATCH / PUT / DELETE；githana_read 只接受 GET / HEAD）；pr_merge：合并方式，默认 merge（merge / squash / rebase）",
};

/** body：api 的 JSON 请求体 与 pr_create 的 PR 正文（同键不同义，见文件头注）。 */
export const body = {
  description:
    "api：请求体（JSON 对象），用于 POST / PATCH / PUT；pr_create：PR 正文（字符串，可选，支持 Markdown 与中文）",
};

/** PR 编号（pr_view 可缺省 = 当前分支关联 PR；pr_merge 必填）。 */
export const prNumber = {
  type: "integer",
  minimum: 1,
  description: "pr_view / pr_merge：PR 编号（正整数）；pr_view 缺省 = 当前分支关联 PR；pr_merge 必填",
};
