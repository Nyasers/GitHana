// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/view：issue 详情（githana_issue 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/issues/{n}`，再取一次评论（`GET .../comments`）——「这个 issue
 * 现在什么状况、谁说了什么」是同一个问题，分两次工具调用没有信息增益。
 *
 * 收到 PR 编号时如实说明它是 PR 并指向 githana_pr（见 lib/issue.js），不假装成 issue。
 * 只读，不改远端状态。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { notAnIssueMessage, issueStateText, labelText, assigneeText } from "../../lib/issue.js";

export const command = "view";
export const summary = "Issue details (including comments)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  comments: z.number().int().min(0).optional().describe("Optional: how many comments to show at most, default 20; pass 0 to report only the count"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const r = await callRest(
    [
      { id: "issue", url: apiUrl(repo, "/issues/" + numStr), timeoutMs },
      { id: "comments", url: apiUrl(repo, "/issues/" + numStr + "/comments"), timeoutMs, paginate: true },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const ires = r.results.find((x) => x.id === "issue");
  const cres = r.results.find((x) => x.id === "comments");

  if (!ires || !ires.ok) {
    if (ires && ires.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(ires, repoLabel);
  }

  const issue = ires.json && typeof ires.json === "object" ? ires.json : {};
  // PR 也是一种 issue（两者共用编号空间）：这个编号可能是 PR。如实说明并指向 githana_pr。
  if (issue.pull_request && issue.pull_request.url) {
    return notAnIssueMessage(label, numStr, repoLabel, issue);
  }

  const out = [];
  out.push("issue #" + issue.number + ": \"" + (issue.title || "(untitled)") + "\"");
  out.push(
    "state: " + issueStateText(issue) +
    " · author: @" + ((issue.user && issue.user.login) || "?") +
    " · created " + fmtTime(issue.created_at) +
    (issue.closed_at ? " · closed " + fmtTime(issue.closed_at) : ""),
  );
  out.push("labels: " + (labelText(issue) || "(none)"));
  out.push(
    "assignees: " + (assigneeText(issue) || "(none)") +
    " · comments " + (issue.comments !== undefined ? issue.comments : "?"),
  );
  if (issue.milestone && issue.milestone.title) out.push("milestone: " + issue.milestone.title);
  if (issue.html_url) out.push("URL: " + issue.html_url);

  const body = issue.body !== null && issue.body !== undefined ? String(issue.body) : "";
  const BODY_MAX = 4000;
  out.push("");
  out.push("—— body" + (body.length > BODY_MAX ? " (truncated, " + body.length + " chars total)" : "") + " ——");
  out.push(body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body) : "(no body)");

  // comments 的非负整数由 schema 保证；这里只做缺省与「传 0 只报条数」。
  let limit = 20;
  if (input.comments !== undefined && input.comments !== null) limit = input.comments;
  const all = cres && cres.ok && Array.isArray(cres.json) ? cres.json : [];
  const fetchNote = cres && cres.ok ? "" : " (fetching comments failed: " + describeFailure(cres, repoLabel) + ")";

  out.push("");
  out.push(
    "—— comments (" + all.length + " total" +
    (limit > 0 && all.length > limit ? ", showing only the last " + limit : "") + ")" + fetchNote + " ——",
  );
  if (all.length === 0) out.push("(no comments)");
  else if (limit === 0) out.push("(comments=0 reports only the count; bodies not shown.)");
  else {
    for (const cm of all.slice(Math.max(0, all.length - limit))) {
      const cmBody = cm && cm.body !== null && cm.body !== undefined ? String(cm.body) : "";
      out.push("· @" + ((cm && cm.user && cm.user.login) || "?") + " " + fmtTime(cm && cm.created_at) + ":");
      out.push(cmBody.length > 1000 ? cmBody.slice(0, 1000) + "…" : cmBody);
    }
  }
  return out.join("\n");
}
