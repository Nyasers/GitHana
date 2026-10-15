// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_git — 本地 git 工具（exec / commit / push）。
 *
 * 它**不是** gh 的一个组：gh 从不管本地仓库，所以这张动词表来自 GitHana 自己（见 spec
 * gh-cli-parity D2 的「自有」一行）。三个动词都只碰本地 git 与本机凭据，不涉 GitHub App 权限：
 * commit 的署名与签名、push 的 --force-with-lease 映射、隔离 gitconfig 与签名 shim 注入一律照旧。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js，各动词实现在
 * tools/actions/git/，用法细节在随包手册 skills/githana/SKILL.md。
 *
 * 权限：external_side_effect；describeSideEffect 按 action 给出对应摘要（exec / commit / push
 * 各一份，缺 action 或未知 action 用整面兜底）。app.js 的 plainPermission 会把函数字段剥掉
 * 再过 RPC——跨进程只认纯数据。
 */
import * as exec from "./actions/git/exec.js";
import * as commit from "./actions/git/commit.js";
import * as push from "./actions/git/push.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_git";

export const description = [
  "GitHana 本地 git：在指定仓库里执行 git 操作。",
  "action=exec（任意 git 子命令透传）/ commit（提交，自动 Co-authored-by + OpenPGP 签名）",
  "/ push（推送，force 映射 --force-with-lease）。",
  "GitHub 远端操作在 githana_repo / githana_pr / githana_issue / githana_release / githana_run /",
  "githana_workflow / githana_cache / githana_label，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序。 */
const ACTIONS = [{ module: exec }, { module: commit }, { module: push }];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana 本地 git 动作（exec / commit / push）：可能修改本地仓库状态，push 还会更新远端分支，执行前请确认 action 与参数",
  ruleId: "github-toolkit-githana-git",
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
});

export const parameters = surface.parameters;
export const execute = surface.execute;
