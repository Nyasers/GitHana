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
export const summary = "手动触发工作流（workflow_dispatch；同步触发，不等 CI）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  workflow: params.workflowRef,
  ref: z.string().optional().describe("可选：从哪个分支 / tag 上跑（缺省取仓库默认分支；必须存在且包含该工作流）"),
  inputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("可选：workflow_dispatch 的输入（键必须在该工作流的 on.workflow_dispatch.inputs 里声明）；值会被转成字符串，这是 GitHub 的载荷要求"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "在 GitHub 远端手动触发一个工作流的 workflow_dispatch（CI 会真的跑起来：可能推送 / 部署 / 改远端状态，并占用额度）：执行前请确认 repo、workflow 与 ref",
  ruleId: "github-toolkit-workflow-run",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const wf = input?.workflow !== undefined && input?.workflow !== null ? String(input.workflow).trim() : "";
  if (!wf) return label + " 参数错误：workflow 必填（数字 ID 或文件名，从 githana_workflow(action=\"list\") 取）。";

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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（dispatch 不返回正文，也不返回 run 编号）。
  if (!res || (!res.ok && res.status !== 204)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 404) {
      return (
        label + " 执行失败：找不到工作流 " + wf + " 或 ref " + (refIn || "（默认分支）") + "（404）。\n" +
        "两个常见原因：workflow 名字写错，或 ref 上没有这个工作流文件（工作流必须存在于该 ref 上才能被触发）。\n" +
        "GitHub 原文：" + detail
      );
    }
    if (st === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次触发（422）。最常见的原因是**该工作流没有 workflow_dispatch 触发器**" +
        "（`on:` 里要写成 `workflow_dispatch:`），其次是 inputs 的键与声明不符 / 缺必填 input。\n" +
        "GitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const triggeredAt = new Date().toISOString();
  const out = [
    label + " 已触发（" + repoLabel + " · workflow " + wf + "）：",
    "ref：" + (refIn || "（未指定 → GitHub 用仓库默认分支）"),
  ];
  if (payload.inputs) {
    out.push("inputs：" + Object.entries(payload.inputs).map(([k, v]) => k + "=\"" + v + "\"").join(" · ") + "（值已转成字符串，这是 GitHub 的载荷要求）");
  } else {
    out.push("inputs：无");
  }
  out.push("HTTP 204（GitHub 已把 dispatch 事件入队——**不是**「已经开始跑」，更不是「已通过」）");
  out.push("触发时刻（UTC）：" + triggeredAt);
  out.push("");
  out.push("说明：这是**同步触发**。dispatch 不回 run 编号（204 无正文），且那条 run 是异步建出来的——");
  out.push("刚触发时列表里可能还没有它。要找回它：");
  out.push("  githana_run(action=\"list\", repo=\"" + repo + "\", workflow=\"" + wf + "\") 取最新一条（注意竞态）；");
  out.push("  或隔一会儿再列一次，取 created_at 晚于上面那个触发时刻的最新一条。");
  out.push("「等到终态再回报」用任务型的 githana_run(action=\"watch\")：runId 从上面那次 githana_run(action=\"list\", workflow=…) 的结果里拿（返回后台任务句柄，CI 到终态时结论回投本会话）。");
  return out.join("\n");
}
