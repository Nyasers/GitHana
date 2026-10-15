// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_issue — GitHub Issue 工具（gh `issue` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_issue` 行（gh 手册原文）：create · list · view ·
 * status · edit · comment · close · reopen · delete · develop · transfer · lock · unlock ·
 * pin · unpin。支撑权限 `issues`（D7 的已授权集里）。gh `issue` 组的其余部分不在本批：
 * `status --project` 需要 repository_projects（未授权），`--json` 是 CLI 的序列化开关，
 * 在 App 形态下由工具返回值天然承担。
 *
 * ## 通道：REST 为主，四个动词走 GraphQL
 *
 * 「通道不设限」（D5 / AC11）：内部按"哪个能实现"选，对外一个动词、一份返回结构。
 *   · REST：create / list / view / status / edit / comment / close / reopen / lock / unlock；
 *   · GraphQL：delete（`deleteIssue`）、develop（`createLinkedBranch`）、pin / unpin
 *     （`pinIssue` / `unpinIssue`）——**REST 没有这些端点**，gh 自己也是这么分的。
 *
 * ## PR 与 issue 共用编号空间
 *
 * GitHub 上 PR 就是一种 issue（`GET /issues` 默认两者都返回）。所以 `list` 默认滤掉 PR
 * （要一起看传 includePrs=true），而按编号操作的动词收到 PR 编号时会**如实说明并指向
 * githana_pr**，不按 issue 假装处理（见 tools/lib/issue.js）。
 *
 * 权限：external_side_effect——写入面很宽（建 / 改 / 评论 / 关 / 删 / 转 / 锁 / 固定），整体按
 * 写面声明，只读的 list / view / status 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as create from "./actions/issue/create.js";
import * as list from "./actions/issue/list.js";
import * as view from "./actions/issue/view.js";
import * as status from "./actions/issue/status.js";
import * as edit from "./actions/issue/edit.js";
import * as comment from "./actions/issue/comment.js";
import * as close from "./actions/issue/close.js";
import * as reopen from "./actions/issue/reopen.js";
import * as del from "./actions/issue/delete.js";
import * as develop from "./actions/issue/develop.js";
import * as transfer from "./actions/issue/transfer.js";
import * as lock from "./actions/issue/lock.js";
import * as unlock from "./actions/issue/unlock.js";
import * as pin from "./actions/issue/pin.js";
import * as unpin from "./actions/issue/unpin.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_issue";

export const description = [
  "GitHana GitHub Issue: query and modify issues (PRs excluded — PRs are in githana_pr).",
  "action=create / list / view / status / edit / comment / close / reopen / delete / develop",
  "/ transfer / lock / unlock / pin / unpin.",
  "delete / develop / pin / unpin use GraphQL internally (REST has no such endpoints); delete needs confirm=true.",
  "For read-only fetches use list / view / status; label management is in githana_label, releases in githana_release,",
  "CI in githana_run / githana_workflow / githana_cache, and other endpoints go through githana_api.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: create },
  { module: list },
  { module: view },
  { module: status },
  { module: edit },
  { module: comment },
  { module: close },
  { module: reopen },
  { module: del },
  { module: develop },
  { module: transfer },
  { module: lock },
  { module: unlock },
  { module: pin },
  { module: unpin },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana issue actions: most verbs modify remote GitHub state (create / edit / comment / close / reopen / transfer / lock / pin), delete is irreversible, develop creates a new remote branch — confirm action and parameters before executing",
  ruleId: "github-toolkit-githana-issue",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * `reason` 在两个 action 上是**取值域不同**的两个枚举（close 是关单理由，lock 是锁定理由），
 * 而模型面的平表同键只留先出现的那份（surface.js）——不覆盖的话，摘要会对其中一半场景撒谎。
 */
export const modelFields = {
  reason: z
    .string()
    .optional()
    .describe("reason, value domain depends on action: for close it is completed / not_planned; for lock it is off-topic / too heated / resolved / spam"),
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
