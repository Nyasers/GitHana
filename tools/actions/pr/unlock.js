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
export const summary = "解除 PR 对话的锁定";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary: "解除 GitHub 远端 PR 对话的锁定（非协作者可再次评论）：修改 GitHub 远端状态",
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（解锁不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (res && res.status === 403) {
      return label + " 执行失败：没有解锁对话的权限（403）。\nGitHub 原文：" + errorDetail(res);
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  return [
    label + " 已执行（PR #" + numStr + " · " + repoLabel + "）：",
    "状态：对话已解锁（未锁定），非协作者可再次评论。",
  ].join("\n");
}
