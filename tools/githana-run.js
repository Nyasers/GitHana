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
  "GitHana GitHub Actions run：看 / 重跑 / 取消 / 删 run，以及盯一次 CI 到终态。",
  "action=list / view / watch / rerun / cancel / delete / download。",
  "rerun 与 cancel 是**同步触发**（回执写「已触发」，不等 CI 跑完）；",
  "watch 是任务型：它返回宿主后台任务句柄（不等结论），CI 到终态时结论回投本会话。",
  "download 走二进制通道：logs 取整个 run 的 zip，artifacts 取产物 zip，都流式写盘。",
  "工作流本身在 githana_workflow，缓存清理由 githana_cache，发布在 githana_release，",
  "仓库 / PR / issue / 标签在 githana_repo / githana_pr / githana_issue / githana_label，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
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
    "GitHana Actions run 动作（list / view / watch / rerun / cancel / delete / download）：rerun 会重新占用 CI 额度、cancel 会中断正在跑的作业、delete 会抹掉日志与产物（不可撤销）、watch 会在宿主里起一个后台任务定时读 run 状态并把结论贴回本会话，执行前请确认 action 与 run 编号",
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
    .describe("分支，按 action 取义：list 上是过滤列哪些 run；view / watch / rerun / cancel / download 上只在 runId 缺省时用来挑最近一次（缺省回落 cwd 的当前分支）"),
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
