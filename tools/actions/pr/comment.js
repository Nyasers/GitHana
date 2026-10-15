// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/comment：给 PR 加一条评论（githana_pr 动词）。
 *
 * PR 的评论走 **issue 评论**端点：`POST /repos/{o}/{r}/issues/{n}/comments`——GitHub 上 PR 就是
 * 一种 issue，时间线是同一层。gh `pr comment` 也是打这条。
 *
 * 与 `review`（event=comment）的分工：`comment` 是普通时间线发言（不做审查裁决），`review` 是
 * 审查记录（会进 reviews 列表、影响 reviewDecision）。要留「意见」而不表态就用这个。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure } from "../../lib/pr.js";

export const command = "comment";
export const summary = "Add a comment to a PR";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  body: z.string().describe("Comment body (supports Markdown and Chinese)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Post a comment on a remote GitHub PR (written to the PR timeline, publicly visible and cannot be withdrawn — you can only post another comment to correct it): confirm repo, prNumber and body before running",
  ruleId: "github-toolkit-pr-comment",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";
  if (!body.trim()) return label + " argument error: body is required (the comment body cannot be empty).";

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/issues/" + numStr + "/comments"), json: { body }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    // PR 被锁（locked）时评论会被拒——这是 pr_lock 的直接后果，单独给引导。
    if (res && res.status === 403 && /lock/i.test(errorDetail(res))) {
      return (
        label + " execution failed: the conversation on PR #" + numStr + " is locked, so it cannot be commented on.\n" +
        "To post, first unlock it with githana_pr(action=\"unlock\") (requires repository write permission).\nGitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const cm = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " posted (PR #" + numStr + " · " + repoLabel + "):",
    "author: " + (cm.user && cm.user.login ? "@" + cm.user.login : "?") + " · body " + body.length + " chars",
  ];
  if (cm.html_url) out.push("URL: " + cm.html_url);
  return out.join("\n");
}
