// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_run — GitHub Actions 运行工具（gh `run` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_run` 行（gh 手册原文）：list · view · watch ·
 * rerun · cancel · delete · download（**7 个**）。支撑权限 `actions: write`（D7 已授权；
 * run / workflow / cache 三组共用这一条）。
 *
 * ## 两种返回契约：同步触发 vs 任务型（`watch`）
 *
 *   · **同步触发**：`rerun` / `cancel` 发一个请求、GitHub 收下就返回（几秒内结束），回执里写
 *     「已触发 / 已请求取消」——返回的是**结果**。`workflow run` 同档（那边的实现里也点明了）。
 *   · **任务型**：`watch` 要「等 CI 到终态」，**不在工具回调里等**（占着回调会堵住宿主通道），
 *     所以它返回的是**任务句柄**：建一个宿主后台任务
 *     （`ctx.tasks.create({ scope: "session", delivery: "next-step", chipVisibility: "show" })`，
 *     要 manifest 的 `app/tasks.manage` 能力，见 D8 第 1 条），由后台轮询器在 CI 到终态时
 *     `complete` 那个任务，宿主按 next-step 档位把结论贴回来源会话。三条纪律（回调内不等 /
 *     会话内取消即停 / App 重载后从 `ctx.tasks.list()` 恢复）落在
 *     tools/actions/run/watch.js 与 tools/lib/tasks.js 里。
 *
 * ## `download` 走二进制通道
 *
 * 日志（`what=logs`）是 api.github.com 上的一个 zip 字节流（不打 302）；产物
 * （`what=artifacts`）会 302 到 `*.blob.core.windows.net`（Azure 存储，子域是账号名，由 worker 的
 * 后缀白名单放行）。两条都由 worker 流式写盘——不按 UTF-8 解码、不截断。机制与边界见
 * tools/lib/transfer.js。
 *
 * 权限：external_side_effect——rerun / cancel / delete 都会改远端状态（重跑会占用 CI 额度、
 * 取消会中断作业、删除会抹掉日志与产物），watch 会在宿主里起一个后台任务并回投本会话，
 * 整体按写面声明，只读的 list / view / download 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as list from "./actions/run/list.js";
import * as view from "./actions/run/view.js";
import * as watch from "./actions/run/watch.js";
import * as rerun from "./actions/run/rerun.js";
import * as cancel from "./actions/run/cancel.js";
import * as del from "./actions/run/delete.js";
import * as download from "./actions/run/download.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_run";

export const description = [
  "GitHana GitHub Actions runs: list / rerun / cancel / delete runs, and watch one CI run through to its terminal state.",
  "action=list / view / watch / rerun / cancel / delete / download.",
  "rerun and cancel are **synchronous triggers** (the receipt says \"triggered\", it does not wait for CI to finish);",
  "watch is task-shaped: it returns a host background task handle (not the conclusion), and when CI reaches a terminal state the conclusion is delivered back to this session.",
  "download uses the binary channel: logs fetches the zip of the whole run, artifacts fetches the artifact zip, both stream to disk.",
  "Workflows themselves are in githana_workflow, cache cleanup in githana_cache, releases in githana_release,",
  "repository / PR / issue / label in githana_repo / githana_pr / githana_issue / githana_label, and other endpoints go through githana_api.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: list },
  { module: view },
  { module: watch },
  { module: rerun },
  { module: cancel },
  { module: del },
  { module: download },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana Actions run actions (list / view / watch / rerun / cancel / delete / download): rerun consumes CI quota again, cancel interrupts a running job, delete wipes logs and artifacts (irreversible), and watch starts a host background task that polls the run state and posts the conclusion back to this session — confirm action and run number before executing",
  ruleId: "github-toolkit-githana-run",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * 模型面的平表是各 action 字段的并集，同键**取先出现的那份**（surface.js）。`branch` 在两个
 * action 上含义不同，沿用先出现的那份（list 的「只看某分支的 run」）会让 view / watch /
 * rerun / cancel / download 上的用法说不清：
 *   · list 上——过滤列哪些 run；
 *   · view / watch / rerun / cancel / download 上——只在 **runId 缺省**时用来挑「最近一次」，
 *     缺省还会回落 cwd 的当前分支（见 tools/lib/ci.js 的 resolveRunId）。
 */
export const modelFields = {
  branch: z
    .string()
    .optional()
    .describe("branch, by action: on list it filters which runs are listed; on view / watch / rerun / cancel / download it is used only when runId is omitted, to pick the most recent one (defaults back to the cwd's current branch)"),
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
