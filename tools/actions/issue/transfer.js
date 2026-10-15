// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/transfer：把 issue 转到另一个仓库（githana_issue 动词）。
 *
 * 走 GraphQL `transferIssue` 变更（`POST /graphql`）。**REST 没有 issue 转库的端点**——
 * gh `issue transfer` 就是 GraphQL，所以本动词走 lib/graphql.js。
 *
 * 转库的边界（如实写在输出里，不假装它只是改个字段）：
 *   · 目标仓库里**必须已有**同名标签与里程碑**或**转过去的 issue 会丢标签（GitHub 的规则）；
 *     本动词在转之前把当前标签列出来，好让调用方自己判断要不要先建标签；
 *   · 编号会变（目标仓库自己那套编号），GitHub 会在目标库里保持一个重定向；
 *   · 权限上要求对两个仓库都有写权，本 App 有 `issues: write`（D7）。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage, labelText } from "../../lib/issue.js";
import { graphql } from "../../lib/graphql.js";

export const command = "transfer";
export const summary = "Transfer an issue to another repository";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  targetRepo: z.string().describe("Required: target repository, in owner/repo form"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Transfer a remote GitHub issue to another repository (the number changes and the original repository keeps a redirect; labels are lost if the target repository lacks them): changes the issue's ownership and its links on GitHub, confirm the source and target repositories before running",
  ruleId: "github-toolkit-issue-transfer",
};

const TRANSFER_MUTATION = [
  "mutation($issueId: ID!, $repoId: ID!) {",
  "  transferIssue(input: { issueId: $issueId, repositoryId: $repoId }) {",
  "    issue { number url }",
  "  }",
  "}",
].join("\n");

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const targetRaw = input?.targetRepo !== undefined && input?.targetRepo !== null ? String(input.targetRepo).trim() : "";
  if (!targetRaw) return label + " argument error: targetRepo is required (owner/repo form).";
  const targetParts = targetRaw.split("/");
  if (targetParts.length !== 2 || !targetParts[0].trim() || !targetParts[1].trim()) {
    return label + " argument error: targetRepo is malformed (received: " + targetRaw + "). Expected owner/repo.";
  }
  const target = targetParts[0].trim() + "/" + targetParts[1].trim();
  if (target.toLowerCase() === repo.toLowerCase()) {
    return label + " argument error: targetRepo is the same as the source repository (" + target + "); there is nowhere to transfer to.";
  }

  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "PRs cannot be transferred (GitHub does not support transferring a PR to another repository, and githana_pr has no transfer).",
    );
  }

  const issue = cur.issue;
  const issueNodeId = issue.node_id ? String(issue.node_id) : "";
  if (!issueNodeId) return label + ": the response for issue #" + numStr + " has no node_id, so it cannot be transferred via GraphQL.";

  // 目标仓库的 node_id（GraphQL 要的是 id 不是名字）。
  const tr = await callRest([{ url: apiUrl(target, ""), timeoutMs }], { timeoutSec });
  if (!tr.ok) return label + " execution failed: " + tr.message;
  const tres = tr.results[0];
  if (!tres || !tres.ok) {
    if (tres && tres.status === 404) {
      return label + ": target repository " + target + " does not exist or is not visible to the token (transferring requires write access to the target repository too).";
    }
    return label + " execution failed: " + describeFailure(tres, target);
  }
  const targetNodeId = tres.json && tres.json.node_id ? String(tres.json.node_id) : "";
  if (!targetNodeId) return label + ": cannot fetch the node_id of target repository " + target + "; the transfer cannot proceed.";

  const g = await graphql(TRANSFER_MUTATION, { issueId: issueNodeId, repoId: targetNodeId }, { timeoutSec });
  if (g.error) {
    if (/label/i.test(g.error)) {
      return (
        label + " execution failed: GitHub rejected this transfer and the raw message mentions labels.\n" +
        "GitHub's rule is that labels with no same-named counterpart in the target repository are dropped on transfer (depending on the version this either errors or loses labels).\n" +
        "Current labels: " + (labelText(issue) || "(none)") + "\nGitHub raw message: " + g.error
      );
    }
    return label + " execution failed: " + g.error;
  }

  const moved = g.data && g.data.transferIssue && g.data.transferIssue.issue ? g.data.transferIssue.issue : {};
  const labels = labelText(issue);
  const out = [
    label + " transferred:",
    "source: " + repoLabel + " #" + numStr + " (\"" + (issue.title || "(untitled)") + "\")",
    "target: " + target + (moved.number !== undefined ? " #" + moved.number : " (see the GitHub receipt for the number)"),
  ];
  out.push("labels: " + (labels || "(none)") + " — labels with no same-named counterpart in the target repository are dropped; if needed, create them first in the target repository with githana_label(action=\"create\") and then transfer.");
  if (moved.url) out.push("new URL: " + moved.url);
  out.push("note: the original repository keeps an entry pointing to the new location (GitHub's redirect), but the numbering in the target repository is a different one.");
  return out.join("\n");
}
