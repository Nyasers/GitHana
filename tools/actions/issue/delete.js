// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/delete：删除 issue（githana_issue 动词，不可撤销）。
 *
 * 走 GraphQL `deleteIssue` 变更（`POST /graphql`），**REST 没有删除 issue 的端点**——
 * 这一点是 gh 自己的现状：`gh issue delete` 就是 GraphQL。所以本动词走 lib/graphql.js，
 * 与 REST 动词一样只有一次审批（"通道不设限"：D5 / AC11）。
 *
 * 与 `close` 的分界要说清：close 是状态位（可 reopen），delete 是**抹掉**（评论、标签、
 * 时间线一起没，GitHub 只给一次确认机会）。所以本动词：
 *   · 只接受 `confirm=true` 才真删，缺它就返回引导（这是本工具面里唯一不可撤销的动词）；
 *   · 先取 node_id 与标题，好让审批与回执里都写着"删的是哪个 issue"。
 *
 * 权限：`issues: write`（与其余 issue 动词同一条），本 App 已授权。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";
import { graphql } from "../../lib/graphql.js";

export const command = "delete";
export const summary = "Delete an issue (irreversible, requires confirm=true)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually delete: deleting an issue is irreversible (comments, labels and timeline all go with it); without it you get guidance instead"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "**Delete** a remote GitHub issue (irreversible: comments, labels and the whole timeline disappear together, GitHub has no recycle bin): confirm repo and number again before running",
  ruleId: "github-toolkit-issue-delete",
};

const DELETE_MUTATION = [
  "mutation($id: ID!) {",
  "  deleteIssue(input: { issueId: $id }) {",
  "    repository { nameWithOwner }",
  "  }",
  "}",
].join("\n");

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);

  // 先核对编号确实是 issue（不是 PR），并取出 node_id（GraphQL 的入参是 node id，不是编号）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "Deleting PRs is not on the tool surface (githana_pr has no delete); to withdraw a PR use githana_pr(action=\"close\", prNumber=" +
        numStr + "), and to undo its changes use githana_pr(action=\"revert\").",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) {
    return label + ": the response for issue #" + numStr + " has no node_id, so it cannot be deleted via GraphQL (REST has no endpoint to delete an issue).";
  }

  if (input?.confirm !== true) {
    return [
      label + " confirmation required (nothing deleted yet):",
      "Will delete issue #" + numStr + ": \"" + (issue.title || "(untitled)") + "\" (" + repoLabel + ")",
      "Deletion is **irreversible**: comments, labels and the whole timeline disappear together. To keep the history, use githana_issue(action=\"close\") instead.",
      "To confirm, resend the same call with confirm=true.",
    ].join("\n");
  }

  // 删除前记一次评论数：删掉之后就没有地方能查到"删了多少东西"，回执里给一个数。
  // issue 表示里已经带 comments 计数，不必为它多发一次请求。
  const comments = issue.comments !== undefined && issue.comments !== null ? Number(issue.comments) : null;

  const g = await graphql(DELETE_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) return label + " delete failed: " + g.error;

  const out = [
    label + " deleted (issue #" + numStr + " · " + repoLabel + "):",
    "title: " + (issue.title || "(untitled)"),
    "comments: " + (comments === null ? "? (not fetched before deletion)" : comments + " (gone along with the issue)"),
    "note: this is the GraphQL deleteIssue mutation (REST has no endpoint to delete an issue); the operation is irreversible.",
  ];
  if (g.data && g.data.deleteIssue && g.data.deleteIssue.repository) {
    out.push("GitHub receipt: repository = " + g.data.deleteIssue.repository.nameWithOwner);
  }
  return out.join("\n");
}
