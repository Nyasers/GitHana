// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/unlock：解除 PR 对话的锁定（githana_pr 动词）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/issues/{n}/lock`（支撑权限 `pull_requests: write`）。
 * 与 lock 对称：解掉之后非协作者可以再次评论。未锁定的 PR 解一次是幂等的（GitHub 返回 204）。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure } from "../../lib/pr.js";

export const command = "unlock";
export const summary = "Unlock a PR conversation";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary: "Unlock the conversation on a remote GitHub PR (non-collaborators can comment again): modifies remote GitHub state",
  ruleId: "github-toolkit-pr-unlock",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/issues/" + numStr + "/lock"), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（解锁不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 403) {
      return label + " execution failed: no permission to unlock the conversation (403).\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  return [
    label + " done (PR #" + numStr + " · " + repoLabel + "):",
    "state: conversation unlocked (not locked); non-collaborators can comment again.",
  ].join("\n");
}
