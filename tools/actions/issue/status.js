// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/status：issue 状态速览（githana_issue 动词）。
 *
 * 与 `view` 的分工（与 pr 的 status / view 同一口径）：`status` 是**扫一眼判断该不该动手**
 * （短、聚合：状态 / 标签 / 指派 / 评论数 / 锁），`view` 是**要读内容**（正文全文 + 评论）。
 *
 * 一次请求取 issue 本体；收到 PR 编号时如实说明并指向 githana_pr。只读，不改远端状态。
 */
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { notAnIssueMessage, issueStateText, labelText, assigneeText } from "../../lib/issue.js";

export const command = "status";
export const summary = "Issue status at a glance";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const r = await callRest(
    [{ url: apiUrl(repo, "/issues/" + numStr), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const issue = res.json && typeof res.json === "object" ? res.json : {};
  if (issue.pull_request && issue.pull_request.url) {
    return notAnIssueMessage(label, numStr, repoLabel, issue);
  }

  const out = [];
  out.push(label + " issue #" + numStr + " · " + repoLabel);
  out.push("title: " + (issue.title || "(untitled)"));
  out.push("state: " + issueStateText(issue) + " · author: @" + ((issue.user && issue.user.login) || "?"));
  out.push("labels: " + (labelText(issue) || "(none)"));
  out.push("assignees: " + (assigneeText(issue) || "(none)"));
  if (issue.milestone && issue.milestone.title) out.push("milestone: " + issue.milestone.title);
  out.push(
    "comments: " + (issue.comments !== undefined ? issue.comments : "?") +
    " · created " + fmtTime(issue.created_at) +
    (issue.updated_at ? " · updated " + fmtTime(issue.updated_at) : "") +
    (issue.closed_at ? " · closed " + fmtTime(issue.closed_at) : ""),
  );
  // 其它字段单独一行：没有就不打（"没有也算一种信息"靠的是不虚构，不是靠打一行空话）。
  const linked = [];
  if (issue.active_lock_reason) linked.push("lock reason " + issue.active_lock_reason);
  if (issue.locked === true && !issue.active_lock_reason) linked.push("locked");
  if (linked.length) out.push("other: " + linked.join(" · "));
  if (issue.html_url) out.push("URL: " + issue.html_url);
  return out.join("\n");
}
