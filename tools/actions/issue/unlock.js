// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/unlock：解除 issue 对话的锁定（githana_issue 动词）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/issues/{n}/lock`（支撑权限 `issues: write`）。与 lock 对称：
 * 解掉之后非协作者可以再次评论。未锁定的 issue 解一次是幂等的（GitHub 返回 204）。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";

export const command = "unlock";
export const summary = "Unlock an issue conversation";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary: "Unlock the conversation on a remote GitHub issue (non-collaborators can comment again): modifies remote GitHub state",
  ruleId: "github-toolkit-issue-unlock",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先核对是 issue 而不是 PR：解锁端点在 issues 这层、两边相同，但工具面归属不同（见 lib/issue.js）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "To unlock the conversation on this PR use githana_pr(action=\"unlock\", prNumber=" + numStr + ").",
    );
  }

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/issues/" + numStr + "/lock"), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（解锁不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 403) {
      return label + " execution failed: no permission to unlock the conversation (403).\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  return [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "state: conversation unlocked (not locked); non-collaborators can comment again.",
  ].join("\n");
}
