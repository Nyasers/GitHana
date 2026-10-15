// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_cache — GitHub Actions 缓存工具（gh `cache` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_cache` 行（gh 手册原文）：list · delete（**2 个**）。
 * 支撑权限 `actions: write`（D7 已授权；run / workflow / cache 三组共用这一条——缓存端点没有
 * 单独的权限项）。
 *
 * ## 两个动词就够，因为「删」这条端点是两种形态
 *
 * gh 的 `gh cache` 只有 list / delete 两个动词（还有 `delete --all`，那只是 delete 的过滤参数
 * 拉满，不是第三个动词）。GitHub 的删除端点是两条：按 `cache_id` 删一条，与按
 * `key`/`ref` 删一族——所以「按什么删」是 `delete` 自己的参数，不构成新动词。
 *
 * ## 按 key 删的「跨 ref」是这一组最重的一档
 *
 * 缓存 key 会跨分支重名：只给 key 不给 ref 会把该 key 在**所有**分支上的缓存一起删掉。
 * 所以那种形态要 `confirm=true`（缺它就先把将被删的列出来），给了 ref 就不需要——见
 * actions/cache/delete.js 的头注。
 *
 * 权限：external_side_effect——delete 会改远端状态（清掉构建缓存），整体按写面声明，
 * 只读的 list 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as list from "./actions/cache/list.js";
import * as del from "./actions/cache/delete.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_cache";

export const description = [
  "GitHana GitHub Actions 缓存：列 / 删构建缓存。",
  "action=list / delete。",
  "delete 两种形态：给 id 删一条，给 key 删一族（不给 ref 会跨所有分支删，那种情况需 confirm=true）。",
  "run 在 githana_run，工作流在 githana_workflow，发布在 githana_release，",
  "仓库 / PR / issue / 标签在 githana_repo / githana_pr / githana_issue / githana_label，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [{ module: list }, { module: del }];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana 缓存动作（list / delete）：delete 会**删除** GitHub 远端的 Actions 缓存（下一次构建重新生成，不丢代码；不给 ref 时可能跨所有分支清掉一个 key），执行前请确认 action 与参数",
  ruleId: "github-toolkit-githana-cache",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * 模型面的平表是各 action 字段的并集，同键**取先出现的那份**（surface.js）。`key` 与 `ref`
 * 在两个 action 上的语义不同，沿用 list 那份会让 delete 上的风险说不清：
 *   · list 上——过滤列哪些缓存（**不删任何东西**）；
 *   · delete 上——`key` 与 `ref` 一起决定**删哪些**：给了 `ref` 只删该 ref，不给则跨所有分支，
 *     那种情况要 `confirm=true`。所以这里必须写明「按 action 取义」，否则模型会把 list 的
 *     「过滤」当成 delete 的「过滤」——而在 delete 上它是「删除范围」。
 */
export const modelFields = {
  key: z
    .string()
    .optional()
    .describe("缓存 key，按 action 取义：list 上是过滤条件（不删东西）；delete 上是**删除范围**（不给 ref 会跨所有分支删，那种情况需 confirm=true）"),
  ref: z
    .string()
    .optional()
    .describe("Git ref（如 refs/heads/main），按 action 取义：list 上是过滤条件；delete 上是**限定删除范围**（不给就跨所有分支）"),
};

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  verbs: otherVerbs(name),
  modelFields,
});

export const parameters = surface.parameters;
export const execute = surface.execute;
