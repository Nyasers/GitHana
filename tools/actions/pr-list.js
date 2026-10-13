// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr_list：列出仓库的 PR（只读面 action）。
 *
 * 走 REST `GET /repos/{o}/{r}/pulls?state=&sort=created&direction=desc&per_page=`；
 * 输出编号/标题/分支/state/时间列表。只读，不改远端状态。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../lib/rest.js";
import { resolveContext, describeFailure, fmtTime } from "../lib/pr.js";

export const command = "pr_list";
export const summary = "列出 PR";

export const fields = {
  state: {
    type: "string",
    enum: ["open", "closed", "all"],
    description: "PR 状态过滤，默认 open",
  },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 50,
    description: "返回条数，默认 10，上限 50",
  },
};
export const required = [];

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const state = input?.state !== undefined && input?.state !== null ? String(input.state).trim() : "open";
  if (!["open", "closed", "all"].includes(state)) {
    return label + " 参数错误：state 必须是 open / closed / all（收到：" + state + "）。";
  }
  let limit = 10;
  if (input?.limit !== undefined && input?.limit !== null && input?.limit !== "") {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n <= 0) return label + " 参数错误：limit 必须是正整数。";
    limit = Math.min(50, n);
  }

  const url =
    apiUrl(repo, "/pulls") +
    "?state=" + encodeURIComponent(state) +
    "&sort=created&direction=desc&per_page=" + String(limit);
  const r = await callRest([{ url, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }], { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) {
    return label + "（" + repoLabel + " · state=" + state + "）：没有匹配的 PR。";
  }
  const out = [label + "（" + repoLabel + " · state=" + state + " · " + items.length + " 条）："];
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
