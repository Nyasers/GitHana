// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/pin：把 issue 固定到仓库顶部（githana_issue 动词）。
 *
 * 走 GraphQL `pinIssue` 变更（`POST /graphql`）。**REST 没有 pin 的端点**——gh `issue pin`
 * 就是 GraphQL，所以本动词走 lib/graphql.js（支撑权限 `issues: write`，D7 已授权）。
 *
 * 两条平台约束如实回报，不假装成功：
 *   · 每个仓库**最多 3 个** pin，超了 GitHub 会拒；
 *   · 固定的是 issue 表示（PR 也用同一变更，但本动词只收 issue：收到 PR 编号会指向 githana_pr）。
 */
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";
import { graphql } from "../../lib/graphql.js";

export const command = "pin";
export const summary = "Pin an issue to the top of the repository";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Pin a remote GitHub issue to the top of the repository (at most 3 pins per repository; changes what everyone sees on the repository home page): modifies remote GitHub state, confirm the number before running",
  ruleId: "github-toolkit-issue-pin",
};

const PIN_MUTATION = [
  "mutation($id: ID!) {",
  "  pinIssue(input: { issueId: $id }) {",
  "    issue { number title }",
  "  }",
  "}",
].join("\n");

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);

  // 先核对是 issue 且取出 node_id（GraphQL 的入参）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "Pinning PRs is not on the tool surface (githana_pr has no pin); if you really need it, go through githana_api's GraphQL /graphql (pinIssue accepts a PR's node_id).",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) return label + ": the response for issue #" + numStr + " has no node_id, so it cannot be pinned via GraphQL.";

  const g = await graphql(PIN_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) {
    if (/already pinned/i.test(g.error)) {
      return label + ": issue #" + numStr + " is already pinned to the top of the repository (already pinned); no need to repeat the operation.";
    }
    if (/3 pinned|maximum|too many/i.test(g.error)) {
      return (
        label + " execution failed: GitHub rejected this pin and the raw message mentions a count limit — at most 3 issues can be pinned per repository.\n" +
        "First unpin one with githana_issue(action=\"unpin\").\nGitHub raw message: " + g.error
      );
    }
    return label + " execution failed: " + g.error;
  }

  return [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "state: pinned to the top of the repository · title: \"" + (issue.title || "(untitled)") + "\"",
    "note: at most 3 pins per repository; to lift it use githana_issue(action=\"unpin\").",
  ].join("\n");
}
