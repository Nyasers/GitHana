// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/reopen：重新打开已关闭的 issue（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}` 带 `{ state: "open", state_reason: "reopened" }`
 * （支撑权限 `issues: write`）。state_reason 用 `reopened` 是 GitHub 的约定值，不传也行，
 * 传了能让「为什么又开着」在时间线上可读。
 *
 * 已经是打开状态的 issue 再开一次是幂等的，本动词如实回报「本来就是打开态」。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { notAnIssueMessage, issueStateText } from "../../lib/issue.js";

export const command = "reopen";
export const summary = "Reopen a closed issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  comment: z.string().optional().describe("Optional: attach an explanatory comment when reopening (comment first, then reopen — two requests)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Reopen a closed remote GitHub issue (state=open, state_reason=reopened): modifies remote GitHub state, confirm repo and number before running",
  ruleId: "github-toolkit-issue-reopen",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先看现状：本来就是打开态就不用发这条 PATCH（如实回报，不假装做了一次改动）。
  const before = await callRest(
    [{ url: apiUrl(repo, "/issues/" + numStr), timeoutMs }],
    { timeoutSec },
  );
  if (before.ok && before.results[0] && before.results[0].ok) {
    const cur = before.results[0].json && typeof before.results[0].json === "object" ? before.results[0].json : {};
    // PR 与 issue 共用编号空间：是 PR 就指向 githana_pr，不按 issue 代劳（见 lib/issue.js）。
    if (cur.pull_request && cur.pull_request.url) {
      return notAnIssueMessage(
        label,
        numStr,
        repoLabel,
        cur,
        "To reopen this PR use githana_pr(action=\"reopen\", prNumber=" + numStr + ").",
      );
    }
    if (String(cur.state) === "open") {
      const out = [label + ": issue #" + numStr + " is already open; no need to reopen.", "state: " + issueStateText(cur)];
      if (cur.html_url) out.push("URL: " + cur.html_url);
      return out.join("\n");
    }
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
    id: "reopen",
    method: "PATCH",
    url: apiUrl(repo, "/issues/" + numStr),
    json: { state: "open", state_reason: "reopened" },
    timeoutMs,
  });

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;
  const rres = r.results.find((x) => x.id === "reopen");
  const cmres = r.results.find((x) => x.id === "comment");
  if (!rres || !rres.ok) {
    if (rres && rres.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (rres && rres.status === 422) {
      return label + " execution failed: cannot reopen issue #" + numStr + " (422).\nGitHub raw message: " + errorDetail(rres);
    }
    return label + " execution failed: " + describeFailure(rres, repoLabel);
  }

  const issue = rres.json && typeof rres.json === "object" ? rres.json : {};
  const out = [label + " done (issue #" + numStr + " · " + repoLabel + "):", "state: " + issueStateText(issue)];
  if (comment.trim() !== "") {
    out.push(
      cmres && cmres.ok
        ? "Attached explanatory comment (" + comment.length + " chars)."
        : "Posting the explanatory comment failed (" + (cmres ? describeFailure(cmres, repoLabel) : "no result") + "), but the reopen itself took effect.",
    );
  }
  if (issue.html_url) out.push("URL: " + issue.html_url);
  return out.join("\n");
}
