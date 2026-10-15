// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/checks：PR 的 CI 检查状态（githana_pr 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/commits/{head_sha}/check-runs`（支撑权限 `checks: read`，D7 已授权）。
 * gh 的 `pr checks` 就是这一族端点；`/commits/{ref}/status` 那条是老式的 commit status，
 * 与 check-runs 是两套，本动词只报 check-runs，并在输出里说明这一点。
 *
 * 只读：不改远端状态。真正的「等 CI 到终态」是另一件事（要注册后台任务）——那是
 * `githana_run(action="watch", runId=…)`，本动词只回报**此刻**的结论。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, summarizeCheckRuns } from "../../lib/pr.js";

export const command = "checks";
export const summary = "A PR's CI check status";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

/** check-run 的 conclusion → 中文可读（未知值原样透出，不假装认识）。 */
function conclusionText(run) {
  const conclusion = run && run.conclusion ? String(run.conclusion) : "";
  if (!conclusion) return "not finished (" + (run && run.status ? String(run.status) : "?") + ")";
  const map = {
    success: "success",
    failure: "failure",
    neutral: "neutral",
    cancelled: "cancelled",
    skipped: "skipped",
    timed_out: "timed out",
    action_required: "action required",
    stale: "stale",
  };
  return map[conclusion] || conclusion;
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " execution failed: " + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  const headSha = pr.head && pr.head.sha ? String(pr.head.sha) : "";
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "?";
  if (!headSha) {
    return label + ": the response for PR #" + numStr + " has no head.sha, so the check status cannot be looked up (" + repoLabel + ").";
  }

  const r = await callRest(
    [{ url: apiUrl(repo, "/commits/" + headSha + "/check-runs") + "?per_page=100", timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const summary = summarizeCheckRuns(res.json);
  const out = [
    label + " PR #" + numStr + " · " + repoLabel + " · " + headRef + " (" + headSha.slice(0, 7) + ")",
    summary.text,
    "note: these are check-runs (GitHub Actions / App checks); legacy commit statuses are not included.",
  ];
  for (const run of summary.runs) {
    const name = run && run.name ? String(run.name) : "(unnamed)";
    out.push("  [" + conclusionText(run) + "] " + name);
    if (run && run.html_url) out.push("      " + String(run.html_url));
  }
  return out.join("\n");
}
