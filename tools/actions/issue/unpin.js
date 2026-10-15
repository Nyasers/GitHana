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
export const summary = "解除 issue 的固定";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "解除 GitHub 远端 issue 的固定（该 issue 不再出现在仓库顶部，会改动仓库首页对所有人的展示）：修改 GitHub 远端状态",
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
      "PR 的固定不在工具面上（githana_pr 没有 unpin）；确需操作可走 githana_api 的 GraphQL /graphql（unpinIssue 接受 PR 的 node_id）。",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) return label + "：issue #" + numStr + " 的响应里没有 node_id，无法走 GraphQL 解除固定。";

  const g = await graphql(UNPIN_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) return label + " 执行失败：" + g.error;

  return [
    label + " 已执行（issue #" + numStr + " · " + repoLabel + "）：",
    "状态：已解除固定（unpinned）· 标题：「" + (issue.title || "（无标题）") + "」",
  ].join("\n");
}
