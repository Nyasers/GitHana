// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana — 写面工具（会改变本地仓库或 GitHub 远端状态的动作）。
 *
 * 一个入口收下全部写动作，action 按能力命名、不带 git_ / gh_ 前缀（两个入口已经把域分开了）。
 * 路由与三类边界（缺 action / 未知 action / 走错面）在 tools/lib/surface.js，各 action 的实现
 * 在 tools/actions/，用法细节在随包手册 skills/githana/SKILL.md。
 *
 * ## 为什么是两个入口而不是一个
 *
 * 宿主对 sessionPermission 的声明粒度是**按工具**（ctx.tools.register 时声明一次）。收敛前的
 * gh_pr 是现成的代价样本：它把 list / view（读）与 create / merge（写）放在一个工具里，整体
 * 只能声明 external_side_effect，于是**读也要过审**。收成一个 githana 会把这个代价从一处扩到
 * 全部。只读动作因此独立成 githana_read（sessionPermission { readOnly: true }），这是当前宿主
 * 机制下唯一能同时拿到「形态统一」和「读免审」的形状（见 spec D1）。
 *
 * ## 权限
 *
 * external_side_effect；describeSideEffect 按 action 给出对应摘要（exec / commit / push /
 * pr_create / pr_merge / api 各一份，缺 action 或未知 action 用整面兜底）。
 * app.js 的 plainPermission 会把函数字段剥掉再过 RPC——跨进程只认纯数据，这一点与收敛前一致。
 */
import * as exec from "./actions/exec.js";
import * as commit from "./actions/commit.js";
import * as push from "./actions/push.js";
import * as prCreate from "./actions/pr-create.js";
import * as prMerge from "./actions/pr-merge.js";
import * as api from "./actions/api.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import * as params from "./lib/params.js";

export const name = "githana";

export const description = [
  "GitHana 写面：在本地仓库或 GitHub 远端执行会改变状态的动作。",
  "action=exec（任意 git 子命令透传）/ commit（提交，自动 Co-authored-by + OpenPGP 签名）",
  "/ push（推送，force 映射 --force-with-lease）/ pr_create（创建 PR）/ pr_merge（合并 PR，不可撤销）",
  "/ api（任意 GitHub REST 端点，全量方法）。",
  "只读查询（status / log / pr_list / pr_view）在 githana_read，不必过审。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序。 */
const ACTIONS = [
  { module: exec },
  { module: commit },
  { module: push },
  { module: prCreate },
  { module: prMerge },
  // 写面的 api 维持收敛前 github_api 的方法集（只读面只收 GET / HEAD，见 spec D7）。
  { module: api, options: { allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"] } },
];

/** 保留位：本期只在 action 表与手册里留位置，不实现（见 spec D8）。 */
const RESERVED = {
  ci_watch: "CI 监听需要注册后台任务并在完成后唤醒会话（轮询会撞宿主回调的 30 秒上限），本期未实现；当前可用 githana(action=\"api\") 查 CI 运行状态。",
};

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana 写面动作（exec / commit / push / pr_create / pr_merge / api）：可能修改本地仓库状态或 GitHub 远端状态，执行前请确认 action 与参数",
  ruleId: "github-toolkit-githana",
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
  reserved: RESERVED,
  other: { name: "githana_read", commands: ["status", "log", "pr_list", "pr_view", "api", "ci_status"] },
  // 本面共用字段：method / body 在这里覆盖成中性描述（api 与 pr_merge / pr_create 同键不同义，
  // 合并成一张平表后只能这么写；精确分支留给阶段 B 的 discriminatedUnion）。
  sharedFields: {
    cwd: params.cwd,
    repo: params.repo,
    timeoutSec: params.timeoutSec,
    method: params.method,
    body: params.body,
    prNumber: params.prNumber,
  },
});

export const parameters = surface.parameters;
export const execute = surface.execute;