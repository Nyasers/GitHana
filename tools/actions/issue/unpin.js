// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/unpin：解除 issue 的固定（githana_issue 动词）。
 *
 * 走 GraphQL `unpinIssue` 变更（`POST /graphql`）——REST 没有 pin / unpin 端点，与 pin 对称。
 * 未固定的 issue 解一次是幂等的，本动词如实回报。
 */
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";
import { graphql } from "../../lib/graphql.js";

export const command = "unpin";
export const summary = "Unpin an issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Unpin a remote GitHub issue (the issue no longer appears at the top of the repository; changes what everyone sees on the repository home page): modifies remote GitHub state",
  ruleId: "github-toolkit-issue-unpin",
};

const UNPIN_MUTATION = [
  "mutation($id: ID!) {",
  "  unpinIssue(input: { issueId: $id }) {",
  "    issue { number title }",
  "  }",
  "}",
].join("\n");

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);

  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "Pinning PRs is not on the tool surface (githana_pr has no unpin); if you really need it, go through githana_api's GraphQL /graphql (unpinIssue accepts a PR's node_id).",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) return label + ": the response for issue #" + numStr + " has no node_id, so it cannot be unpinned via GraphQL.";

  const g = await graphql(UNPIN_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) return label + " execution failed: " + g.error;

  return [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "state: unpinned · title: \"" + (issue.title || "(untitled)") + "\"",
  ].join("\n");
}
