// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/close：关闭 issue（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}` 带 `{ state: "closed", state_reason }`
 * （支撑权限 `issues: write`）。`state_reason` 是 GitHub 的关单理由：
 *   · `completed`（默认，已解决）· `not_planned`（不打算做）· `reopened`（那是 reopen 用的，
 *     这里不收）；gh `issue close --reason` 给的正是前两个。
 *
 * 关闭**不删**任何东西：评论与标签都留着，可以 reopen 回来。这一点与 `delete` 不同
 * （删不可撤销），所以两者是同级的独立动词。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage, issueStateText } from "../../lib/issue.js";

export const command = "close";
export const summary = "Close an issue (can be restored with reopen)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  reason: z
    .enum(["completed", "not_planned"])
    .optional()
    .describe("Close reason (default completed): completed (resolved) / not_planned (not going to be done)"),
  comment: z.string().optional().describe("Optional: attach an explanatory comment when closing (comment first, then close — two requests)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Close a remote GitHub issue (state=closed, optionally with a close reason; does not delete comments or history, can be restored with reopen): modifies remote GitHub state, confirm repo and number before running",
  ruleId: "github-toolkit-issue-close",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  // 取值域由 schema 保证（enum）；这里只做缺省。
  const reason = String(input?.reason || "completed");

  // 先核对这个编号是 issue 而不是 PR：关闭端点两者相同，但工具面的归属不同——
  // 对 PR 该走 githana_pr(action="close")，这里如实指向它，不代劳（见 lib/issue.js）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "To close this PR use githana_pr(action=\"close\", prNumber=" + numStr + ").",
    );
  }

  const batch = [];
  const comment = input?.comment !== undefined && input?.comment !== null ? String(input.comment) : "";
  if (comment.trim() !== "") {
    batch.push({
      id: "comment",
      method: "POST",
      url: apiUrl(repo, "/issues/" + numStr + "/comments"),
      json: { body: comment },
      timeoutMs,
    });
  }
  batch.push({
    id: "close",
    method: "PATCH",
    url: apiUrl(repo, "/issues/" + numStr),
    json: { state: "closed", state_reason: reason },
    timeoutMs,
  });

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;
  const cres = r.results.find((x) => x.id === "close");
  const cmres = r.results.find((x) => x.id === "comment");
  if (!cres || !cres.ok) {
    if (cres && cres.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(cres, repoLabel);
  }

  const issue = cres.json && typeof cres.json === "object" ? cres.json : {};
  const out = [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "state: " + issueStateText(issue) + " · reason: " + reason,
    "note: closing deletes no comments or history; use githana_issue(action=\"reopen\") to restore.",
  ];
  if (comment.trim() !== "") {
    out.push(
      cmres && cmres.ok
        ? "Attached explanatory comment (" + comment.length + " chars)."
        : "Posting the explanatory comment failed (" + (cmres ? describeFailure(cmres, repoLabel) : "no result") + "), but the close itself took effect.",
    );
  }
  if (issue.html_url) out.push("URL: " + issue.html_url);
  return out.join("\n");
}
