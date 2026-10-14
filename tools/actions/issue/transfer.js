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
export const summary = "把 issue 转到另一个仓库";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  targetRepo: z.string().describe("必填：目标仓库，格式 owner/repo"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "把 GitHub 远端 issue 转到另一个仓库（编号会变、原仓库留重定向；目标仓库没有同名标签时会丢标签）：变更 issue 的归属与其在 GitHub 上的链接，执行前请确认源与目标仓库",
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
  if (!targetRaw) return label + " 参数错误：targetRepo 必填（格式 owner/repo）。";
  const targetParts = targetRaw.split("/");
  if (targetParts.length !== 2 || !targetParts[0].trim() || !targetParts[1].trim()) {
    return label + " 参数错误：targetRepo 格式非法（收到：" + targetRaw + "）。要求 owner/repo。";
  }
  const target = targetParts[0].trim() + "/" + targetParts[1].trim();
  if (target.toLowerCase() === repo.toLowerCase()) {
    return label + " 参数错误：targetRepo 与源仓库相同（" + target + "），没有可转的地方。";
  }

  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "PR 不能转库（GitHub 不支持把 PR 转到别的仓库；githana_pr 也没有 transfer）。",
    );
  }

  const issue = cur.issue;
  const issueNodeId = issue.node_id ? String(issue.node_id) : "";
  if (!issueNodeId) return label + "：issue #" + numStr + " 的响应里没有 node_id，无法走 GraphQL 转库。";

  // 目标仓库的 node_id（GraphQL 要的是 id 不是名字）。
  const tr = await callRest([{ url: apiUrl(target, ""), timeoutMs }], { timeoutSec });
  if (!tr.ok) return label + " 执行失败：" + tr.message;
  const tres = tr.results[0];
  if (!tres || !tres.ok) {
    if (tres && tres.status === 404) {
      return label + "：目标仓库 " + target + " 不存在或令牌不可见（转库要求对目标仓库也有写权）。";
    }
    return label + " 执行失败：" + describeFailure(tres, target);
  }
  const targetNodeId = tres.json && tres.json.node_id ? String(tres.json.node_id) : "";
  if (!targetNodeId) return label + "：取不到目标仓库 " + target + " 的 node_id，无法转库。";

  const g = await graphql(TRANSFER_MUTATION, { issueId: issueNodeId, repoId: targetNodeId }, { timeoutSec });
  if (g.error) {
    if (/label/i.test(g.error)) {
      return (
        label + " 执行失败：GitHub 拒绝了这次转库，原文提到标签。\n" +
        "GitHub 的规则是：目标仓库里没有的同名标签会在转库时丢掉（不是报错就是丢标签，视版本而定）。\n" +
        "当前标签：" + (labelText(issue) || "（无）") + "\nGitHub 原文：" + g.error
      );
    }
    return label + " 执行失败：" + g.error;
  }

  const moved = g.data && g.data.transferIssue && g.data.transferIssue.issue ? g.data.transferIssue.issue : {};
  const labels = labelText(issue);
  const out = [
    label + " 已转库：",
    "源：" + repoLabel + " #" + numStr + "（「" + (issue.title || "（无标题）") + "」）",
    "目标：" + target + (moved.number !== undefined ? " #" + moved.number : "（编号见 GitHub 回执）"),
  ];
  out.push("标签：" + (labels || "（无）") + "——目标仓库里没有的同名标签会丢，需要的话先在目标仓库用 githana_label(action=\"create\") 建好再转。");
  if (moved.url) out.push("新 URL：" + moved.url);
  out.push("说明：原仓库会保留一个指向新位置的条目（GitHub 的重定向），但编号在目标仓库里是另一套。");
  return out.join("\n");
}
