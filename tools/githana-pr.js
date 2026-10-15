// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_pr — GitHub Pull Request 工具（gh `pr` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_pr` 行（gh 手册原文），支撑权限
 * `pull_requests`；merge / revert / update-branch 另需 `contents`，checks 需 `checks`
 * （三项都在 D7 的已授权集里）。`ready` **不在本批**：把草稿 PR 转 ready 只有 GraphQL 能做
 * （REST 的 PATCH draft:false 实测返回 200 但不生效），属于阶段 2 的能力空洞，先不声明。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js，各动词实现在
 * tools/actions/pr/，用法细节在随包手册 skills/githana/SKILL.md。
 *
 * 权限：external_side_effect——本工具里 create / merge / comment / close / reopen / review /
 * edit / lock / unlock / update-branch / revert / checkout 都会改状态，整体只能按写面声明。
 * （只读的 view / status / diff / checks / list 因此也要过审；读免审那条路在收敛前由独立的
 * 只读面承担，名词分家后按 gh 的组走。）
 */
import * as create from "./actions/pr/create.js";
import * as list from "./actions/pr/list.js";
import * as view from "./actions/pr/view.js";
import * as status from "./actions/pr/status.js";
import * as diff from "./actions/pr/diff.js";
import * as checks from "./actions/pr/checks.js";
import * as merge from "./actions/pr/merge.js";
import * as review from "./actions/pr/review.js";
import * as comment from "./actions/pr/comment.js";
import * as close from "./actions/pr/close.js";
import * as reopen from "./actions/pr/reopen.js";
import * as revert from "./actions/pr/revert.js";
import * as edit from "./actions/pr/edit.js";
import * as checkout from "./actions/pr/checkout.js";
import * as lock from "./actions/pr/lock.js";
import * as unlock from "./actions/pr/unlock.js";
import * as updateBranch from "./actions/pr/update-branch.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_pr";

export const description = [
  "GitHana GitHub PR：查询与改动 Pull Request。",
  "action=create / list / view / status / diff / checks / merge / review / comment / close / reopen",
  "/ revert / edit / checkout / lock / unlock / update-branch。",
  "只读的取数用 list / view / status / diff / checks；本地 git 在 githana_git，仓库在 githana_repo，",
  "issue 在 githana_issue，标签在 githana_label，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: create },
  { module: list },
  { module: view },
  { module: status },
  { module: diff },
  { module: checks },
  { module: merge },
  { module: review },
  { module: comment },
  { module: close },
  { module: reopen },
  { module: revert },
  { module: edit },
  { module: checkout },
  { module: lock },
  { module: unlock },
  { module: updateBranch },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana PR 动作：多数动词会修改 GitHub 远端状态（创建 / 合并 / 评论 / 关闭 / 审查 / 编辑 / 锁定 / 更新分支），revert 与 checkout 还会改动本地仓库，执行前请确认 action 与参数",
  ruleId: "github-toolkit-githana-pr",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/** 其它名词工具的动词表：走错工具时报错指名正确的那一个（见 surface.js 的 misroutedMessage）。 */
const OTHER_VERBS = otherVerbs(name);

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  verbs: OTHER_VERBS,
  // 本工具不需要面级 modelFields：`method` 只在 merge 上出现，各工具一张自己的参数表之后，
  // 「同一个键在两处不同义」这件事已经消失（D1），平表直接取 merge 那份 enum 即可。
});

export const parameters = surface.parameters;
export const execute = surface.execute;
