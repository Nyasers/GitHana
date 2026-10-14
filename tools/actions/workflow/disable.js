// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/disable：停用一个工作流（githana_workflow 动词）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/actions/workflows/{workflow_id}/disable`（回 204 No Content），
 * 支撑权限 `actions: write`（D7 已授权）。gh 的 `gh workflow disable` 同此语义。
 *
 * ## 停用挡的是自然触发，不是全部触发
 *
 * 停用之后该工作流的 push / pull_request / schedule 等**自然触发**不再启动它，但
 * `workflow_dispatch`（githana_workflow(action="run")）仍可手动触发；已经跑着的 run 也不受影响
 * （要停它用 githana_run(action="cancel")）。gh 的 disable 同此。
 *
 * 实现与 enable 共用一份（tools/lib/workflow-toggle.js）；本文件只有它自己的字段定义。
 */
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { toggleWorkflow } from "../../lib/workflow-toggle.js";

export const command = "disable";
export const summary = "停用一个工作流（挡自然触发，不挡手动 dispatch）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  workflow: params.workflowRef,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "在 GitHub 远端停用一个工作流（改它的状态位：之后 push / pull_request / schedule 等自然触发不再启动它）：修改 GitHub 远端状态，执行前请确认 repo 与 workflow",
  ruleId: "github-toolkit-workflow-disable",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  return toggleWorkflow(input, c, label, "disable");
}
