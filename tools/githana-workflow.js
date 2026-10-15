// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_workflow — GitHub Actions 工作流工具（gh `workflow` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_workflow` 行（gh 手册原文）：list · view ·
 * run · enable · disable（**5 个**）。支撑权限 `actions: write`（D7 已授权；run / workflow /
 * cache 三组共用这一条）。
 *
 * ## `run` 是同步触发，与 `githana_run` 的 `watch` 不同档
 *
 * `POST .../dispatches` 回 **204 No Content**（无正文、也不返回 run 编号）——GitHub 只表示
 * 「事件已入队」，那条 run 是**异步**建出来的。所以回执里写「已触发」+ 触发时刻 + 怎么找回那条
 * run，不假装能报出编号。形态上与 `githana_run` 的 rerun / cancel 同一档（发请求、几秒内结束、
 * 返回结果），而任务型的 watch（返回句柄、CI 到终态回投会话）是另一档——两者不能混。
 *
 * ## `view` 看的是定义，不是 YAML
 *
 * name / path / state 这类元数据来自 `/actions/workflows/{id}`；YAML 正文是仓库里的一个文件，
 * 走 `githana_repo(action="read-file")`（支撑权限是 `contents: read`，与这里不是同一条）。
 * 两件事不合并，理由写在 actions/workflow/view.js 的头注里。
 *
 * 权限：external_side_effect——run / enable / disable 都会改远端状态（触发 CI、改状态位），
 * 整体按写面声明，只读的 list / view 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import * as list from "./actions/workflow/list.js";
import * as view from "./actions/workflow/view.js";
import * as run from "./actions/workflow/run.js";
import * as enable from "./actions/workflow/enable.js";
import * as disable from "./actions/workflow/disable.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_workflow";

export const description = [
  "GitHana GitHub Actions workflows: list / view / manually trigger / enable / disable.",
  "action=list / view / run / enable / disable.",
  "run is a **synchronous trigger** (workflow_dispatch; the receipt says \"triggered\" + the trigger time, and it neither waits for nor returns the run number);",
  "view shows the definition (name / path / state); the YAML body goes through githana_repo(action=\"read-file\").",
  "The list / details / rerun of a particular run are in githana_run, cache cleanup in githana_cache, releases in githana_release,",
  "repository / PR / issue / label in githana_repo / githana_pr / githana_issue / githana_label, and other endpoints go through githana_api.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: list },
  { module: view },
  { module: run },
  { module: enable },
  { module: disable },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana workflow actions (list / view / run / enable / disable): run really starts CI (it may push / deploy / consume quota), and enable and disable change the state bits (affecting later natural triggers) — confirm action and workflow before executing",
  ruleId: "github-toolkit-githana-workflow",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  verbs: otherVerbs(name),
});

export const parameters = surface.parameters;
export const execute = surface.execute;
