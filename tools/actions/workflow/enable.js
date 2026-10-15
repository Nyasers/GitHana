// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/enable：启用一个工作流（githana_workflow 动词）。
 *
 * 走 REST `PUT /repos/{o}/{r}/actions/workflows/{workflow_id}/enable`（回 204 No Content），
 * 支撑权限 `actions: write`（D7 已授权）。gh 的 `gh workflow enable` 同此语义。
 *
 * 实现与 disable 共用一份（tools/lib/workflow-toggle.js）：两个动词的请求形状与回报完全对称，
 * 只差方法、路径段与措辞，拆开写迟早漂。本文件只有它自己的字段定义。
 */
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { toggleWorkflow } from "../../lib/workflow-toggle.js";

export const command = "enable";
export const summary = "Enable a workflow (restores its natural triggers)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  workflow: params.workflowRef,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Enable a workflow on remote GitHub (changes its status flag: afterwards natural triggers such as push / pull_request / schedule take effect again): modifies remote GitHub state, confirm repo and workflow before running",
  ruleId: "github-toolkit-workflow-enable",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  return toggleWorkflow(input, c, label, "enable");
}
