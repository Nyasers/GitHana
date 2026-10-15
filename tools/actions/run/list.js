// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/list：列 workflow run（githana_run 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/runs`，支撑权限 `actions: write`（D7 已授权；本组三组
 * run / workflow / cache 都落在这一条上，只读动词也要过审，与 repo / pr / issue 同一口径）。
 *
 * ## `status` 一栏收两种值
 *
 * GitHub 的 `status` 查询参数**状态与结论都收**（文档原话：Returns workflow runs with the
 * check run status or conclusion that matches the specified status）。所以这里不做「状态归状态、
 * 结论归结论」的拆分，直接把收到的值透传——那层判断 GitHub 已经做了，在本地再分一遍只会与它
 * 不一致。取值域因此是一个较长的 enum（见下），保留未知值的能力交给 `githana_api`。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { runLine, actorText } from "../../lib/ci.js";

export const command = "list";
export const summary = "列 workflow run（可按分支 / 状态 / 工作流过滤）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  branch: z.string().optional().describe("可选：只看某分支的 run"),
  workflow: z.string().optional().describe("可选：只看某个工作流的 run（数字 ID 或文件名，从 githana_workflow(action=\"list\") 取）"),
  status: z
    .enum([
      "completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
      "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending",
    ])
    .optional()
    .describe("可选：按状态或结论过滤（GitHub 的 status 参数两种值都收，同一个词按语义落在一侧）"),
  event: z
    .enum(["push", "pull_request", "workflow_dispatch", "schedule", "release", "issues", "issue_comment", "merge_group", "repository_dispatch", "dynamic"])
    .optional()
    .describe("可选：按触发事件过滤（GitHub 的 event 参数接受的事件名）"),
  actor: z.string().optional().describe("可选：只看某人触发的 run（登录名，不带 @）"),
  limit: z.number().int().min(1).optional().describe("返回条数，默认 15，上限 100（超过上限收敛到 100）"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("返回条数，默认 15，上限 100（超过上限收敛到 100）"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  let limit = 15;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);

  const query = ["per_page=" + String(limit)];
  const pushIf = (key, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      query.push(key + "=" + encodeURIComponent(String(value).trim()));
    }
  };
  pushIf("branch", input?.branch);
  pushIf("status", input?.status);
  pushIf("event", input?.event);
  pushIf("actor", input?.actor);
  // 单个工作流的 run 有专门端点：参数形状不同（workflow 是**路径段**，不是查询键），
  // 所以走那一条而不是在查询串里塞 workflow=。
  const wf = input?.workflow !== undefined && input?.workflow !== null ? String(input.workflow).trim() : "";
  const path = wf
    ? "/actions/workflows/" + wf.split("/").map(encodeURIComponent).join("/") + "/runs"
    : "/actions/runs";

  const r = await callRest(
    [{ url: apiUrl(repo, path) + "?" + query.join("&"), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (wf && res && res.status === 404) {
      return label + "：仓库 " + repoLabel + " 里没有工作流 " + wf + "（用 githana_workflow(action=\"list\") 看有哪些）。";
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const items = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  const scope =
    repoLabel +
    (wf ? " · workflow=" + wf : "") +
    (input?.branch ? " · branch=" + String(input.branch).trim() : "") +
    (input?.status ? " · status=" + String(input.status) : "") +
    (input?.event ? " · event=" + String(input.event) : "") +
    (input?.actor ? " · actor=@" + String(input.actor).trim() : "");

  if (items.length === 0) return label + "（" + scope + "）：没有匹配的 workflow run。";

  const out = [label + "（" + scope + " · " + items.length + " 条" +
    (body.total_count !== undefined ? " / 共 " + body.total_count : "") + " 条 · 最近在前）："];
  for (const it of items) {
    out.push(runLine(it) + (actorText(it) ? " · " + actorText(it) : ""));
    if (it.html_url) out.push("  " + it.html_url);
  }
  return out.join("\n");
}
