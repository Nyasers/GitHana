// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/reopen：重新打开已关闭的 PR（githana_pr 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/pulls/{n}` 带 `{ state: "open" }`（支撑权限 `pull_requests: write`）。
 * 已经打开的 PR 再开一次是幂等的，本动词如实回报「本来就是打开态」。
 *
 * **已合并的 PR 不能 reopen**：合并是一次性的历史事实，不是状态位。要重做只能新开一个 PR——
 * 这里明确报错并指向 create，不静默失败。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText } from "../../lib/pr.js";

export const command = "reopen";
export const summary = "Reopen a closed PR";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Reopen a closed remote GitHub PR (state=open; a merged PR cannot be reopened): modifies remote GitHub state, confirm repo and prNumber before running",
  ruleId: "github-toolkit-pr-reopen",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先看现状：已合并的 PR 不能重开，这个判断要给出比 422 原文更有用的引导。
  const before = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  if (before.ok && before.results[0] && before.results[0].ok) {
    const cur = before.results[0].json && typeof before.results[0].json === "object" ? before.results[0].json : {};
    if (cur.merged === true) {
      return (
        label + ": PR #" + numStr + " is already merged, so it cannot be reopened — a merge is a one-time historical fact, not a reversible status flag.\n" +
        "To redo it, open a new PR (githana_pr(action=\"create\"))."
      );
    }
    if (String(cur.state) === "open") {
      const out = [label + ": PR #" + numStr + " is already open; no need to reopen.", "state: " + prStateText(cur)];
      if (cur.html_url) out.push("URL: " + cur.html_url);
      return out.join("\n");
    }
  }

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/pulls/" + numStr), json: { state: "open" }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 422) {
      return label + " execution failed: cannot reopen PR #" + numStr + " (422).\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const out = [label + " done (PR #" + numStr + " · " + repoLabel + "):", "state: " + prStateText(pr)];
  if (pr.html_url) out.push("URL: " + pr.html_url);
  return out.join("\n");
}
