// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/update-branch：把目标分支的新提交合进 PR 源分支（githana_pr 动词）。
 *
 * 走 REST `PUT /repos/{o}/{r}/pulls/{n}/update-branch`（支撑权限 `pull_requests: write`
 * + `contents: write`，见 spec D7）。gh `pr update-branch` 就是这条：GitHub 自己在服务端把
 * base 分支合进 head。
 *
 * `expectedHeadSha`：乐观并发保护——传了它，GitHub 会先核对源分支 HEAD 是否仍是这个 sha，
 * 不是就返回 422 而不是在一个已经变了的分支上动手。多台机器同时操作时用它。
 *
 * 两种失败要分开说：**没冲突但不需要更新**（already up to date，无事发生）与**有冲突**
 * （GitHub 不做自动合并，要人解决）——前者不是错误。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure } from "../../lib/pr.js";

export const command = "update-branch";
export const summary = "Merge the base branch into the PR's source branch";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  expectedHeadSha: z
    .string()
    .optional()
    .describe("Optional: the expected HEAD sha of the source branch (optimistic concurrency protection); on a mismatch GitHub returns 422 rather than acting on a branch that has already changed"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Have GitHub merge the PR's base branch into its source branch (may produce a merge commit and rewrite the source branch): modifies remote GitHub state, confirm repo, prNumber and expectedHeadSha before running",
  ruleId: "github-toolkit-pr-update-branch",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const payload = {};
  if (input?.expectedHeadSha !== undefined && input?.expectedHeadSha !== null && String(input.expectedHeadSha).trim() !== "") {
    payload.expected_head_sha = String(input.expectedHeadSha).trim();
  }

  const r = await callRest(
    [{ method: "PUT", url: apiUrl(repo, "/pulls/" + numStr + "/update-branch"), json: payload, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  const detail = errorDetail(res);

  // 202 = 已受理（更新是异步落地的）；422 分两种：已经在最新 / 有冲突。
  if (res && res.status === 202) {
    const out = [
      label + " accepted (PR #" + numStr + " · " + repoLabel + "):",
      "GitHub has started merging the base branch into the source branch (asynchronous; check the result shortly with view / status).",
      res.json && res.json.message ? "raw message: " + String(res.json.message) : "",
    ];
    return out.filter(Boolean).join("\n");
  }
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 422) {
      if (/up.to.date|no new commits|already/i.test(detail)) {
        return label + ": the source branch of PR #" + numStr + " is already up to date with the base branch; no update is needed (this is not an error).\nGitHub raw message: " + detail;
      }
      if (/merge conflict|conflict/i.test(detail)) {
        return (
          label + ": PR #" + numStr + " conflicts with the base branch, and GitHub does not merge automatically.\n" +
          "Resolve the conflict locally and push to the source branch, or check the conflict state with githana_pr(action=\"view\").\nGitHub raw message: " + detail
        );
      }
      if (/expected_head_sha|head sha/i.test(detail)) {
        return (
          label + ": the source branch HEAD of PR #" + numStr + " is no longer expectedHeadSha (someone pushed new commits in the meantime).\n" +
          "Read the PR again to confirm the latest sha, then decide.\nGitHub raw message: " + detail
        );
      }
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const out = [label + " done (PR #" + numStr + " · " + repoLabel + "):", "state: the base branch has been merged into the source branch"];
  if (res.json && res.json.message) out.push("raw message: " + String(res.json.message));

  // 取一次终态确认（更新也是异步落地的）。
  const conf = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  const cp = conf.ok && conf.results[0] && conf.results[0].ok ? conf.results[0].json : null;
  if (cp) {
    const headSha = cp.head && cp.head.sha ? String(cp.head.sha) : "";
    out.push("confirmation: state=" + String(cp.state || "?").toUpperCase() + (headSha ? " · source branch HEAD " + headSha.slice(0, 7) : ""));
  }
  return out.join("\n");
}
