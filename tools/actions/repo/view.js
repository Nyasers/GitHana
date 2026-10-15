// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/view：仓库详情（githana_repo 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}`（支撑权限 `metadata: read`，所有只读动作的底座）。默认分支、
 * 可见性、规模、许可、fork 上游一并报出——这些是「接下来能不能 clone / 有没有权限推」的判断依据。
 *
 * 只读，不改远端状态。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { repoSummary } from "../../lib/repo.js";

export const command = "view";
export const summary = "Repository details";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const r = await callRest(
    [{ url: apiUrl(repo, ""), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + ": repository " + repoLabel + " does not exist or is not visible to the token (a private repository requires the token to have access).";
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const out = [label + " details:"];
  out.push(...repoSummary(res.json));
  const perms = res.json && res.json.permissions;
  if (perms && typeof perms === "object") {
    const yes = Object.entries(perms).filter(([, v]) => v === true).map(([k]) => k);
    out.push("the token's permissions within the repository (the permissions GitHub returns): " + (yes.length ? yes.join(" / ") : "none"));
    out.push("note: this line is the effective power GitHub computes for the token, which differs from how the App's permissions are registered in the manual; the latter is authoritative.");
  }
  return out.join("\n");
}
