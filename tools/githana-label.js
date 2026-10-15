// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_label — GitHub 标签工具（gh `label` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_label` 行（gh 手册原文）：clone · create ·
 * edit · delete · list。支撑权限 `issues`（标签与 issue 同一条，D7 已授权）。
 *
 * 三个容易混的点写在各自的实现里，这里只点出边界：
 *   · `edit` 的 `name` 是**定位**（改哪个标签），改名走 `newName`——否则"我想改 bug 的颜色"
 *     会变成"把 bug 改成别的名字"；
 *   · `delete` 需 `confirm=true`：删标签会从所有已打它的 issue / PR 上一起摘掉；
 *   · `clone` 的 `repo` 是**目标**、`fromRepo` 是**源**，默认只建缺失的标签，`force=true` 才
 *     覆盖目标已有的同名标签。
 *
 * 权限：external_side_effect——create / edit / delete / clone 都会改远端状态，整体按写面声明，
 * 只读的 list 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import * as clone from "./actions/label/clone.js";
import * as create from "./actions/label/create.js";
import * as edit from "./actions/label/edit.js";
import * as del from "./actions/label/delete.js";
import * as list from "./actions/label/list.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_label";

export const description = [
  "GitHana GitHub labels: list / create / edit / delete repository labels, or copy a whole set over from another repository.",
  "action=clone / create / edit / delete / list.",
  "for clone, repo is the target and fromRepo the source; for edit, name locates the label and renaming uses newName; delete needs confirm=true.",
  "to label an issue use githana_issue(action=\"edit\"), for a PR use githana_pr(action=\"edit\");",
  "releases are in githana_release, CI in githana_run / githana_workflow / githana_cache, and other endpoints go through githana_api.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: clone },
  { module: create },
  { module: edit },
  { module: del },
  { module: list },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana label actions: create / edit / delete / clone all modify the labels of the remote GitHub repository (delete removes it from every issue / PR that carries it) — confirm action and parameters before executing",
  ruleId: "github-toolkit-githana-label",
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
