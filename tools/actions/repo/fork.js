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
export const summary = "fork 到当前账号下";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().optional().describe("可选：fork 后的仓库名（缺省同名）"),
  defaultBranchOnly: z.boolean().optional().describe("可选：只取默认分支（GitHub 会裁掉其它分支，省时间）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_repo",
  summary:
    "在 GitHub 上把仓库 fork 到当前登录账号下（新建一个属于你的仓库副本，父仓库可见地记下这个 fork）：修改 GitHub 远端状态，执行前请确认 repo",
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 403) {
      return (
        label + " 执行失败：GitHub 拒绝这次 fork（403）。常见原因：父仓库不允许 fork（allow_forking=false）、\n" +
        "或令牌对父仓库没有读权限。\nGitHub 原文：" + detail
      );
    }
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次 fork（422）。最常见的原因是**你的账号下已经有同名 fork**——\n" +
        "一仓库一 fork，要更新它请用 githana_repo(action=\"sync\")。\nGitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const fork = res.json && typeof res.json === "object" ? res.json : {};
  const parentRepoName = repo.split("/")[1] || repo;
  const out = [label + " 已受理（" + repoLabel + " → fork）："];
  out.push("fork 仓库：" + (fork.full_name || "?（GitHub 还在建，响应体里没有 full_name）"));
  out.push("状态：HTTP " + res.status + (res.status === 202 ? "（GitHub 在后台建，稍后可用 view / clone 确认）" : "") + " · 默认分支 " + (fork.default_branch || "?"));
  if (fork.html_url) out.push("URL：" + fork.html_url);
  if (fork.parent && fork.parent.full_name) out.push("上游：" + fork.parent.full_name);
  out.push("说明：不在克隆。要本地那份接着调 githana_repo(action=\"clone\", repo=\"" + (fork.full_name || "<你的账号>/" + parentRepoName) + "\", cwd=\"<父目录>\")。");
  out.push("说明：fork 到组织下（--org）不在本动词上（缺 organization 权限），请走 githana_api。");
  return out.join("\n");
}
