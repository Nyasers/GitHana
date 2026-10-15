// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/run：手动触发一个工作流（githana_workflow 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/actions/workflows/{workflow_id}/dispatches`，支撑权限
 * `actions: write`（D7 已授权）。gh 的 `gh workflow run` 就是这个端点。
 *
 * ## 这是**同步触发**，与 `run watch` 不同档
 *
 * 端点回 **204 No Content**（无正文）——GitHub 只表示「事件已入队」。真正的那条 run 是
 * **异步建出来**的（要等 GitHub 把事件派发给调度器），所以回执里写「已触发」而不是「已开始」，
 * 更不是「已通过」。形态上它与 `run rerun` 同一档：发一个请求、几秒内结束、返回结果；
 * 而 `run watch` 是任务型（返回句柄、CI 到终态回投来源会话）——两者的返回契约不同。
 *
 * ## 触发后怎么找回那条 run
 *
 * 没有「dispatch 返回 run 编号」这回事（204 没有正文）。可行的做法按可靠度排：
 *   1. 立刻用 `githana_run(action="list", workflow=<同一个>)` 找最新一条——但**可能有竞态**
 *      （dispatches 是异步派发的，刚触发时列表里可能还没有它）；
 *   2. 记下触发时刻，隔一会儿再 list，取 `created_at` 晚于该时刻的最新一条。
 * 所以本动词在回执里给出**触发时刻**与查找命令，不假装能报出 run 编号。
 *
 * ## 触发体（inputs）的形状
 *
 * `inputs` 是工作流 `on.workflow_dispatch.inputs` 里声明的那些键，GitHub 要求**值是字符串**
 * （即使声明成 number / boolean 类型，dispatch 的载荷里也要给字符串形式）。所以这里把每个值
 * 转成字符串：传 `{ count: 3 }` 会发 `"3"`。不转的话 GitHub 回 422，而那条报错读起来与
 * 「input 名字写错」一模一样。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { workflowPath } from "../../lib/ci.js";

export const command = "run";
export const summary = "Manually trigger a workflow (workflow_dispatch; synchronous trigger, does not wait for CI)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  workflow: params.workflowRef,
  ref: z.string().optional().describe("Optional: which branch / tag to run on (defaults to the repository default branch; it must exist and contain that workflow)"),
  inputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Optional: workflow_dispatch inputs (the keys must be declared under the workflow's on.workflow_dispatch.inputs); values are converted to strings, which is what GitHub's payload requires"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Manually trigger a workflow_dispatch on remote GitHub (CI really runs: it may push / deploy / change remote state and consumes quota): confirm repo, workflow and ref before running",
  ruleId: "github-toolkit-workflow-run",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const wf = input?.workflow !== undefined && input?.workflow !== null ? String(input.workflow).trim() : "";
  if (!wf) return label + " argument error: workflow is required (a numeric ID or a file name, get it from githana_workflow(action=\"list\")).";

  const payload = {};
  const refIn = input?.ref !== undefined && input?.ref !== null ? String(input.ref).trim() : "";
  if (refIn) payload.ref = refIn;
  if (input?.inputs !== undefined && input?.inputs !== null && typeof input.inputs === "object") {
    const converted = {};
    for (const [k, v] of Object.entries(input.inputs)) {
      converted[String(k)] = v === undefined || v === null ? "" : String(v);
    }
    payload.inputs = converted;
  }

  const r = await callRest(
    [
      {
        method: "POST",
        url: apiUrl(repo, "/actions/workflows/" + workflowPath(wf) + "/dispatches"),
        json: payload,
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（dispatch 不返回正文，也不返回 run 编号）。
  if (!res || (!res.ok && res.status !== 204)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 404) {
      return (
        label + " execution failed: cannot find workflow " + wf + " or ref " + (refIn || "(default branch)") + " (404).\n" +
        "Two common causes: the workflow name is misspelled, or that workflow file does not exist on the ref (a workflow must exist on that ref to be triggered).\n" +
        "GitHub raw message: " + detail
      );
    }
    if (st === 422) {
      return (
        label + " execution failed: GitHub rejected this trigger (422). The most common cause is that **the workflow has no workflow_dispatch trigger**" +
        " (the `on:` block must declare `workflow_dispatch:`), followed by input keys not matching the declaration / a required input missing.\n" +
        "GitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const triggeredAt = new Date().toISOString();
  const out = [
    label + " triggered (" + repoLabel + " · workflow " + wf + "):",
    "ref: " + (refIn || "(not specified → GitHub uses the repository default branch)"),
  ];
  if (payload.inputs) {
    out.push("inputs: " + Object.entries(payload.inputs).map(([k, v]) => k + "=\"" + v + "\"").join(" · ") + " (values were converted to strings, which is what GitHub's payload requires)");
  } else {
    out.push("inputs: none");
  }
  out.push("HTTP 204 (GitHub has queued the dispatch event — this is **not** \"it has started running\", and certainly not \"it has passed\")");
  out.push("triggered at (UTC): " + triggeredAt);
  out.push("");
  out.push("note: this is a **synchronous trigger**. The dispatch returns no run number (204 has no body), and that run is created asynchronously —");
  out.push("it may not be in the list yet right after triggering. To find it:");
  out.push("  githana_run(action=\"list\", repo=\"" + repo + "\", workflow=\"" + wf + "\") and take the newest entry (beware of the race);");
  out.push("  or list again after a while and take the newest entry whose created_at is later than the trigger timestamp above.");
  out.push("To \"wait for the terminal state and then report\", use the task-style githana_run(action=\"watch\"): take runId from the result of that githana_run(action=\"list\", workflow=…) call above (it returns a background task handle and reports the conclusion back to this session when CI reaches a terminal state).");
  return out.join("\n");
}
