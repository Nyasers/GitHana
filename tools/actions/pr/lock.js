// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/lock：锁定 PR 的对话（githana_pr 动词）。
 *
 * 走 REST `PUT /repos/{o}/{r}/issues/{n}/lock`（支撑权限 `pull_requests: write`）。锁定的对象是
 * **issue 对话**（PR 就是一种 issue），所以打的是 issues 这条：锁上之后非协作者不能再评论，
 * 已有的评论全部保留。
 *
 * 与 gh `pr lock` 一致，附带 `lock_reason`：
 *   · `off-topic`（默认）· `too heated` · `resolved` · `spam`
 * 这些理由会显示在 PR 页面上，所以说清为什么锁本身就是内容的一部分。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure } from "../../lib/pr.js";

export const command = "lock";
export const summary = "Lock a PR conversation (non-collaborators cannot comment)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  reason: z
    .enum(["off-topic", "too heated", "resolved", "spam"])
    .optional()
    .describe("Lock reason (default off-topic): off-topic / too heated / resolved / spam; it is displayed on the PR page"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Lock the conversation on a remote GitHub PR (non-collaborators can no longer comment, existing comments are kept; the reason is shown publicly): modifies remote GitHub state",
  ruleId: "github-toolkit-pr-lock",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // reason 的取值域由 schema 保证（enum）；这里只做缺省。枚举值 "too heated" 带空格，
  // 与 gh 的取值一致（GitHub 只认带空格的形态）。
  const apiReason = input?.reason !== undefined && input?.reason !== null ? String(input.reason) : "off-topic";

  const r = await callRest(
    [{ method: "PUT", url: apiUrl(repo, "/issues/" + numStr + "/lock"), json: { lock_reason: apiReason }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（锁定不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 403) {
      return label + " execution failed: no permission to lock the conversation (403) — locking requires repository write permission (this App has pull_requests: write).\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  return [
    label + " done (PR #" + numStr + " · " + repoLabel + "):",
    "state: conversation locked · reason: " + apiReason,
    "note: non-collaborators can no longer comment, existing comments are kept; to lift it use githana_pr(action=\"unlock\").",
  ].join("\n");
}
