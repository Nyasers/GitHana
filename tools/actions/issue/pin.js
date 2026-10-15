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
export const summary = "把 issue 固定到仓库顶部";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "把 GitHub 远端 issue 固定到仓库顶部（每个仓库最多 3 个 pin，会改动仓库首页对所有人的展示）：修改 GitHub 远端状态，执行前请确认编号",
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
      "PR 的固定不在工具面上（githana_pr 没有 pin）；确需操作可走 githana_api 的 GraphQL /graphql（pinIssue 接受 PR 的 node_id）。",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) return label + "：issue #" + numStr + " 的响应里没有 node_id，无法走 GraphQL 固定。";

  const g = await graphql(PIN_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) {
    if (/already pinned/i.test(g.error)) {
      return label + "：issue #" + numStr + " 已经在仓库顶部固定着（already pinned），无需重复操作。";
    }
    if (/3 pinned|maximum|too many/i.test(g.error)) {
      return (
        label + " 执行失败：GitHub 拒绝这次固定，原文提到数量上限——每个仓库最多固定 3 个 issue。\n" +
        "请先用 githana_issue(action=\"unpin\") 放开一个。\nGitHub 原文：" + g.error
      );
    }
    return label + " 执行失败：" + g.error;
  }

  return [
    label + " 已执行（issue #" + numStr + " · " + repoLabel + "）：",
    "状态：已固定到仓库顶部（pinned）· 标题：「" + (issue.title || "（无标题）") + "」",
    "说明：每个仓库最多 3 个 pin；要放开用 githana_issue(action=\"unpin\")。",
  ].join("\n");
}
