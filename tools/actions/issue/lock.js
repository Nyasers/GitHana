// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/lock：锁定 issue 的对话（githana_issue 动词）。
 *
 * 走 REST `PUT /repos/{o}/{r}/issues/{n}/lock`（支撑权限 `issues: write`）。锁上之后非协作者
 * 不能再评论，已有的评论全部保留；理由会显示在页面上，所以说清为什么锁本身就是内容的一部分：
 *   · `off-topic`（默认）· `too heated` · `resolved` · `spam`
 *
 * 与 `pin` 的分工：pin 是把它挂到仓库顶部（可见性），lock 是关掉发言（治理）——两件独立的事。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";

export const command = "lock";
export const summary = "Lock an issue conversation (non-collaborators cannot comment)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  reason: z
    .enum(["off-topic", "too heated", "resolved", "spam"])
    .optional()
    .describe("Lock reason (default off-topic): off-topic / too heated / resolved / spam; it is displayed on the issue page"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Lock the conversation on a remote GitHub issue (non-collaborators can no longer comment, existing comments are kept; the reason is shown publicly): modifies remote GitHub state",
  ruleId: "github-toolkit-issue-lock",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  // 取值域由 schema 保证（enum）；这里只做缺省。枚举值 "too heated" 带空格，与 gh 的取值一致
  //（GitHub 只认带空格的形态）。
  const apiReason = input?.reason !== undefined && input?.reason !== null ? String(input.reason) : "off-topic";

  // 先核对是 issue 而不是 PR：锁定端点在 issues 这层、两边相同，但工具面归属不同——
  // PR 的锁定属于 githana_pr（见 lib/issue.js）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "To lock the conversation on this PR use githana_pr(action=\"lock\", prNumber=" + numStr + ").",
    );
  }

  const r = await callRest(
    [{ method: "PUT", url: apiUrl(repo, "/issues/" + numStr + "/lock"), json: { lock_reason: apiReason }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（锁定不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 403) {
      return label + " execution failed: no permission to lock the conversation (403) — this App has issues: write, so a rejection usually means a repository-side setting or rate limiting.\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  return [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "state: conversation locked · reason: " + apiReason,
    "note: non-collaborators can no longer comment, existing comments are kept; to lift it use githana_issue(action=\"unlock\").",
  ].join("\n");
}
