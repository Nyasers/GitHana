// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/close：关闭 PR（githana_pr 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/pulls/{n}` 带 `{ state: "closed" }`（支撑权限 `pull_requests: write`）。
 * 已合并的 PR 不能再关（GitHub 会拒）；已关闭的再关一次是幂等的，本动词如实回报「本来就是关闭态」。
 *
 * 关闭**不删**任何东西：分支、提交、评论都留着，可以 reopen 回来。这一点与 `merge` 不同
 * （合并不可撤销、且会改默认分支上的历史），所以两者是同级的独立动词。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText } from "../../lib/pr.js";

export const command = "close";
export const summary = "Close a PR (can be restored with reopen)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Close a remote GitHub PR (state=closed; does not delete the branch or history, can be restored with reopen): modifies remote GitHub state, confirm repo and prNumber before running",
  ruleId: "github-toolkit-pr-close",
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
    [{ method: "PATCH", url: apiUrl(repo, "/pulls/" + numStr), json: { state: "closed" }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 422) {
      return label + " execution failed: cannot close PR #" + numStr + " (422). A merged PR cannot be closed again.\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " done (PR #" + numStr + " · " + repoLabel + "):",
    "state: " + prStateText(pr),
    "note: closing deletes no branch or history; to restore use githana_pr(action=\"reopen\").",
  ];
  if (pr.html_url) out.push("URL: " + pr.html_url);
  return out.join("\n");
}
