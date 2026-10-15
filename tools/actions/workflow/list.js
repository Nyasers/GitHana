// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/list：列仓库里的工作流（githana_workflow 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/workflows`，支撑权限 `actions: write`（D7 已授权）。
 *
 * ## `enabledOnly` 在本地过滤，不靠查询参数
 *
 * 这个端点**没有**状态过滤参数（文档里只有 per_page / page），返回的是仓库里的全部工作流，
 * 含被停用的那些（每个条目自己的 `state` 字段说明它处于哪一档）。所以过滤在本地做：
 * 只发一次请求，`enabledOnly=true` 时按 `state === "active"` 筛。多花一次请求去取「只启用的」
 * 会依赖一个文档里没有的参数——那种用法在端点行为变化时会静默变成「什么都没筛」。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { workflowStateText } from "../../lib/ci.js";

export const command = "list";
export const summary = "List workflows in the repository (disabled ones included by default)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  enabledOnly: z.boolean().optional().describe("Optional: only enabled ones (state=active; filtering by state happens locally, not through a query parameter)"),
  limit: z.number().int().min(1).optional().describe("Number of results, default 30, max 100 (values above the max are clamped to 100)"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("Number of results, default 30, max 100 (values above the max are clamped to 100)"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  let limit = 30;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);
  const enabledOnly = input?.enabledOnly === true;

  const r = await callRest(
    [
      {
        url: apiUrl(repo, "/actions/workflows") + "?per_page=" + String(limit),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const all = Array.isArray(body.workflows) ? body.workflows : [];
  const items = enabledOnly ? all.filter((wf) => String((wf && wf.state) || "") === "active") : all;
  const dropped = all.length - items.length;

  if (items.length === 0) {
    if (all.length === 0) {
      return label + " (" + repoLabel + "): this repository has no workflows (nothing defined under .github/workflows/, or not visible to the token).";
    }
    return label + " (" + repoLabel + " · enabled only): no enabled workflows (" + all.length + " in total, all disabled).";
  }

  const out = [
    label + " (" + repoLabel + " · " + items.length + (enabledOnly ? " · enabled only" : "") +
      (body.total_count !== undefined ? " / " + body.total_count + " total" : "") + "):",
  ];
  for (const wf of items) {
    out.push("  " + (wf.name || "(unnamed)") + "  " + workflowStateText(wf.state));
    out.push(
      "      ID: " + (wf.id !== undefined ? wf.id : "?") + " · path: " + (wf.path || "?") +
      (wf.updated_at ? " · updated " + fmtTime(wf.updated_at) : ""),
    );
    if (wf.html_url) out.push("      " + String(wf.html_url));
  }
  if (dropped > 0) out.push("(" + dropped + " disabled ones were filtered out by enabledOnly.)");
  out.push("note: both the ID and the path (file name) work as the workflow argument of the other verbs (view / run / enable / disable).");
  return out.join("\n");
}
