// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/fork：把仓库 fork 到当前登录账号（或指定组织）下（githana_repo 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/forks`，支撑权限 `metadata: read` + 仓库写权限（父仓库侧）。
 * 与 gh `repo fork` 的两处差别，如实写在输出里、不假装：
 *
 *   1. **不在克隆**：gh 默认会顺手把 fork 克隆到本地；REST 端点只负责在服务端建 fork。
 *      要本地那份请接着调 githana_repo(action="clone", repo="<你的账号>/<仓库名>")——
 *      合成一步会让「建了但克隆失败」变成半途状态，也把两条独立语义绑在一次审批里。
 *   2. **`--org` 形态不声明**：`POST /orgs/{org}/repos/{o}/{r}/forks` 要 organization 权限
 *      （本 App 一项未申请）。要 fork 到组织下请走 githana_api，GitHub 会如实 403。
 *
 * fork 是**异步**的：GitHub 返回 202 并在后台建；本动词把响应里的状态如实回报，不谎报完成。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";

export const command = "fork";
export const summary = "Fork under the current account";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().optional().describe("Optional: name of the forked repository (defaults to the same name)"),
  defaultBranchOnly: z.boolean().optional().describe("Optional: only fetch the default branch (GitHub trims the other branches, saving time)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_repo",
  summary:
    "Fork the repository on GitHub under the current login account (creates a copy of the repository that belongs to you, and the parent repository visibly records this fork): modifies remote GitHub state, confirm repo before running",
  ruleId: "github-toolkit-repo-fork",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const payload = {};
  if (input?.name !== undefined && input?.name !== null && String(input.name).trim() !== "") {
    payload.name = String(input.name).trim();
  }
  if (input?.defaultBranchOnly === true) payload.default_branch_only = true;

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/forks"), json: payload, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 403) {
      return (
        label + " execution failed: GitHub rejected this fork (403). Common causes: the parent repository does not allow forking (allow_forking=false),\n" +
        "or the token has no read permission on the parent repository.\nGitHub raw message: " + detail
      );
    }
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this fork (422). The most common cause is that **your account already has a fork with the same name** —\n" +
        "one fork per repository; to update it use githana_repo(action=\"sync\").\nGitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const fork = res.json && typeof res.json === "object" ? res.json : {};
  const parentRepoName = repo.split("/")[1] || repo;
  const out = [label + " accepted (" + repoLabel + " → fork):"];
  out.push("fork repository: " + (fork.full_name || "? (GitHub is still creating it; the response has no full_name)"));
  out.push("state: HTTP " + res.status + (res.status === 202 ? " (GitHub is creating it in the background; confirm later with view / clone)" : "") + " · default branch " + (fork.default_branch || "?"));
  if (fork.html_url) out.push("URL: " + fork.html_url);
  if (fork.parent && fork.parent.full_name) out.push("upstream: " + fork.parent.full_name);
  out.push("note: no local clone is made. For the local copy, follow up with githana_repo(action=\"clone\", repo=\"" + (fork.full_name || "<your account>/" + parentRepoName) + "\", cwd=\"<parent directory>\").");
  out.push("note: forking under an organization (--org) is not on this verb (the organization permission is missing); go through githana_api instead.");
  return out.join("\n");
}
