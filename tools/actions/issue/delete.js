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
export const summary = "删除 issue（不可撤销，需 confirm=true）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  confirm: z
    .boolean()
    .optional()
    .describe("必须为 true 才真删：删除 issue 不可撤销（评论、标签、时间线一起没），缺它会返回引导"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "**删除** GitHub 远端 issue（不可撤销：评论、标签与整条时间线一起消失，GitHub 不回收到回收站）：执行前请再次确认 repo 与编号",
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
      "PR 的删除不在工具面上（githana_pr 没有 delete）；要撤掉一个 PR 用 githana_pr(action=\"close\", prNumber=" +
        numStr + ")，要撤掉它的改动用 githana_pr(action=\"revert\")。",
    );
  }

  const issue = cur.issue;
  const nodeId = issue.node_id ? String(issue.node_id) : "";
  if (!nodeId) {
    return label + "：issue #" + numStr + " 的响应里没有 node_id，无法走 GraphQL 删除（REST 没有删除 issue 的端点）。";
  }

  if (input?.confirm !== true) {
    return [
      label + " 需要确认（未执行删除）：",
      "将删除 issue #" + numStr + "：「" + (issue.title || "（无标题）") + "」（" + repoLabel + "）",
      "删除**不可撤销**：评论、标签与整条时间线一起消失。要保留历史请改用 githana_issue(action=\"close\")。",
      "确认后请重发同一次调用并带上 confirm=true。",
    ].join("\n");
  }

  // 删除前记一次评论数：删掉之后就没有地方能查到"删了多少东西"，回执里给一个数。
  // issue 表示里已经带 comments 计数，不必为它多发一次请求。
  const comments = issue.comments !== undefined && issue.comments !== null ? Number(issue.comments) : null;

  const g = await graphql(DELETE_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) return label + " 删除失败：" + g.error;

  const out = [
    label + " 已删除（issue #" + numStr + " · " + repoLabel + "）：",
    "标题：" + (issue.title || "（无标题）"),
    "评论：" + (comments === null ? "?（删除前未取到）" : comments + " 条（已随 issue 一起消失）"),
    "说明：这是 GraphQL deleteIssue（REST 没有删除 issue 的端点），操作不可撤销。",
  ];
  if (g.data && g.data.deleteIssue && g.data.deleteIssue.repository) {
    out.push("GitHub 回执：repository = " + g.data.deleteIssue.repository.nameWithOwner);
  }
  return out.join("\n");
}
