// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/list：列出仓库的 PR（githana_pr 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/pulls?state=&sort=created&direction=desc&per_page=`；
 * 输出编号/标题/分支/state/时间列表。只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/pr.js";

export const command = "list";
export const summary = "List PRs";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter, defaults to open"),
  // 上限 50 不写成 max：超过上限在 run() 是**收敛到 50**（不是拒绝），收紧成拒绝会改语义。
  limit: z.number().int().min(1).optional().describe("Number of results, default 10, max 50 (values above the max are clamped to 50)"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 50"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(50).describe("Number of results, default 10, max 50 (values above the max are clamped to 50)"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  // state 的取值域由 schema 保证（enum）；limit 只做"收敛到 50"（见上方 schema 的注释）。
  const state = input?.state !== undefined && input?.state !== null ? String(input.state) : "open";
  let limit = 10;
  if (input?.limit !== undefined && input?.limit !== null) {
    limit = Math.min(50, input.limit);
  }

  const url =
    apiUrl(repo, "/pulls") +
    "?state=" + encodeURIComponent(state) +
    "&sort=created&direction=desc&per_page=" + String(limit);
  const r = await callRest([{ url, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }], { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) {
    return label + " (" + repoLabel + " · state=" + state + "): no matching PRs.";
  }
  const out = [label + " (" + repoLabel + " · state=" + state + " · " + items.length + "):"];
  for (const it of items) {
    const head = it && it.head && it.head.ref ? it.head.ref : "?";
    out.push(
      "#" + it.number + " [" + (it.state || "?") + (it.draft ? "·draft" : "") + "] " + head +
      " · " + fmtTime(it.created_at) + " · " + (it.title || ""),
    );
    if (it.html_url) out.push("  " + it.html_url);
  }
  return out.join("\n");
}
