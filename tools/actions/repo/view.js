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
export const summary = "仓库详情";

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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + "：仓库 " + repoLabel + " 不存在或令牌不可见（私有仓库需要令牌有访问权）。";
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const out = [label + " 详情："];
  out.push(...repoSummary(res.json));
  const perms = res.json && res.json.permissions;
  if (perms && typeof perms === "object") {
    const yes = Object.entries(perms).filter(([, v]) => v === true).map(([k]) => k);
    out.push("令牌的仓库内权限（GitHub 返回的 permissions）：" + (yes.length ? yes.join(" / ") : "无"));
    out.push("说明：这一行是 GitHub 按令牌算的实权，与手册里 App 权限的登记口径不同，以后者为准。");
  }
  return out.join("\n");
}
