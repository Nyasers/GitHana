// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_run — GitHub Actions 运行工具（gh `run` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_run` 行（gh 手册原文）：list · view · watch ·
 * rerun · cancel · delete · download（**7 个**）。支撑权限 `actions: write`（D7 已授权；
 * run / workflow / cache 三组共用这一条）。
 *
 * ## 一个动词是保留位（`watch`）—— 它与这两个动词**形态不同**
 *
 *   · **同步触发**：`rerun` / `cancel` 发一个请求、GitHub 收下就返回（几秒内结束），回执里写
 *     「已触发 / 已请求取消」——返回的是**结果**。`workflow run` 同档（那边的实现里也点明了）。
 *   · **任务型**：`watch` 要「等 CI 到终态」，**不能在工具回调里等**（占着回调会堵住宿主通道），
 *     正确形态是返回**任务句柄**、由宿主后台任务在 CI 到终态时把结论回投来源会话
 *     （AC8–AC10；机制是 `ctx.tasks.create({ scope: "session", delivery: "next-step",
 *     chipVisibility: "show" })`，要 manifest 新增 `app/tasks.manage`——D8 的唯一新增能力，
 *     而本批不动清单）。返回契约因此不同：一个句柄（可被 `ctx.tasks.list()` 恢复、可被会话取消）
 *     而不是一份结论。
 *
 * `watch` 的参数契约与返回契约都还没定，所以它**不进 action 表**，只走 `createSurface` 的
 * `reserved`（同 release 的 edit）。留位形态的选择理由写在 actions/run/watch.js 的头注里。
 *
 * ## `download` 进 enum，但网络那一半不可用
 *
 * 参数形态清楚（runId + 要日志还是产物 + 产物名），跑不通的是二进制通道（三条硬限制见
 * tools/lib/transfer.js）。它的回报不是一句「做不到」，而是**产物清单 + 地址 + 限制 + 替代做法**
 * ——产物清单本身是纯 JSON，完全可用。
 *
 * 权限：external_side_effect——rerun / cancel / delete 都会改远端状态（重跑会占用 CI 额度、
 * 取消会中断作业、删除会抹掉日志与产物），整体按写面声明，只读的 list / view / download 因此
 * 也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as list from "./actions/run/list.js";
import * as view from "./actions/run/view.js";
import * as rerun from "./actions/run/rerun.js";
import * as cancel from "./actions/run/cancel.js";
import * as del from "./actions/run/delete.js";
import * as download from "./actions/run/download.js";
import { RESERVED_NOTE } from "./actions/run/watch.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_run";

export const description = [
  "GitHana GitHub Actions run：看 / 重跑 / 取消 / 删 run。",
  "action=list / view / rerun / cancel / delete / download（watch 是保留位，本期未实现）。",
  "rerun 与 cancel 是**同步触发**（回执写「已触发」，不等 CI 跑完）；等终态是任务型的 watch，属阶段 2。",
  "download 本期做不到（二进制通道不存在，回执里给产物清单与替代做法）。",
  "工作流本身在 githana_workflow，缓存清理由 githana_cache，发布在 githana_release，",
  "仓库 / PR / issue / 标签在 githana_repo / githana_pr / githana_issue / githana_label，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致，`watch` 不在其中——见头注）。 */
const ACTIONS = [
  { module: list },
  { module: view },
  { module: rerun },
  { module: cancel },
  { module: del },
  { module: download },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana Actions run 动作（list / view / rerun / cancel / delete / download）：rerun 会重新占用 CI 额度、cancel 会中断正在跑的作业、delete 会抹掉日志与产物（不可撤销），执行前请确认 action 与 run 编号",
  ruleId: "github-toolkit-githana-run",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/** 保留位：`watch` 是任务型（返回句柄），属阶段 2，只留文案、不入 action 表。 */
const RESERVED = { watch: RESERVED_NOTE };

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * 模型面的平表是各 action 字段的并集，同键**取先出现的那份**（surface.js）。`branch` 在两个
 * action 上含义不同，沿用先出现的那份（list 的「只看某分支的 run」）会让 view / rerun /
 * cancel / download 上的用法说不清：
 *   · list 上——过滤列哪些 run；
 *   · view / rerun / cancel / download 上——只在 **runId 缺省**时用来挑「最近一次」，
 *     缺省还会回落 cwd 的当前分支（见 tools/lib/ci.js 的 resolveRunId）。
 */
export const modelFields = {
  branch: z
    .string()
    .optional()
    .describe("分支，按 action 取义：list 上是过滤列哪些 run；view / rerun / cancel / download 上只在 runId 缺省时用来挑最近一次（缺省回落 cwd 的当前分支）"),
};

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  reserved: RESERVED,
  verbs: otherVerbs(name),
  modelFields,
});

export const parameters = surface.parameters;
export const execute = surface.execute;
