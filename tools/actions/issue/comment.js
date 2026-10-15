// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/comment：给 issue 加一条评论（githana_issue 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/issues/{n}/comments`（支撑权限 `issues: write`）。
 *
 * 与 `develop`（建关联分支 / PR）的分工：那个会改仓库里的东西（建分支、开 PR），这个只是发言。
 * 被锁定的 issue 无法评论——这是 issue_lock 的直接后果，单独给引导。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";

export const command = "comment";
export const summary = "Add a comment to an issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  body: z.string().describe("Comment body (supports Markdown and Chinese)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Post a comment on a remote GitHub issue (written to the timeline, publicly visible and cannot be withdrawn — you can only post another comment to correct it; subscribers are notified): confirm repo, number and body before running",
  ruleId: "github-toolkit-issue-comment",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";
  if (!body.trim()) return label + " argument error: body is required (the comment body cannot be empty).";

  // 先核对这个编号是 issue 而不是 PR：评论本身两边端点相同（都是 issue 评论），但工具面的
  // 归属不同——对 PR 评论该走 githana_pr(action="comment")，这里如实指向它，不代劳。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "To comment on this PR use githana_pr(action=\"comment\", prNumber=" + numStr + ").",
    );
  }

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/issues/" + numStr + "/comments"), json: { body }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    // 锁定时 GitHub 报 403 且原文含 locked。
    if (res && res.status === 403 && /lock/i.test(errorDetail(res))) {
      return (
        label + " execution failed: the conversation on #" + numStr + " is locked, so it cannot be commented on.\n" +
        "To post, first unlock it with githana_issue(action=\"unlock\").\nGitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const cm = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " posted (issue #" + numStr + " · " + repoLabel + "):",
    "author: @" + ((cm.user && cm.user.login) || "?") + " · body " + body.length + " chars",
  ];
  if (cm.html_url) out.push("URL: " + cm.html_url);
  return out.join("\n");
}
