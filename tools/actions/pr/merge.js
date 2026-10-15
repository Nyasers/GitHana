// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/merge：合并 PR（githana_pr 动词，不可撤销）。
 *
 * prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?（合并后删源分支）。
 * 走 REST `PUT /pulls/{n}/merge`，成功后再取一次终态确认（合并是异步落地，取一次更可靠）。
 *
 * deleteBranch 删的是 `DELETE /repos/{o}/{r}/git/refs/heads/{branch}`。删之前必须先取源分支
 * 的**来源仓库**：源分支可能来自 fork，而删的是 base 仓库的 refs——只看 head.ref 就删，会在
 * 同名的无关分支上动手（fork PR 的常见情形）。所以跨仓一律不删。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/pr.js";

export const command = "merge";
export const summary = "Merge a PR (irreversible)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumber.describe("PR number (positive integer), required"),
  // 合并方式：取值域在这里是确定的，所以写成 enum（运行期由 schema 拒绝非法值）。
  method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (default merge)"),
  deleteBranch: z.boolean().optional().describe("Delete the source branch after merging (skipped when the source branch comes from a fork; never deletes across repositories)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Merge a remote GitHub PR (through this App's own REST channel): irreversible; it merges the code and may delete the source branch (deleteBranch) — confirm repo and prNumber before running",
  ruleId: "github-toolkit-pr-merge",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  // prNumber / method 的形状由 schema 保证（正整数；merge / squash / rebase）。
  const num = input.prNumber;
  const method = input?.method !== undefined && input?.method !== null ? String(input.method) : "merge";
  const deleteBranch = input?.deleteBranch === true;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 合并前取一次源分支信息（deleteBranch 要用，且合并后 head 仍可读，这里取一次更稳）。
  // 必须连**源仓库**一起取：源分支可能来自 fork，而下面删的是 base 仓库的 refs。
  // 只看 head.ref 就删，会在同名的无关分支上动手（fork PR 的常见情形）。
  let headRef = "";
  let headRepoFull = "";
  if (deleteBranch) {
    const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
    const pr = prRes.ok && prRes.results[0] && prRes.results[0].json ? prRes.results[0].json : null;
    if (pr && pr.head) {
      if (pr.head.ref) headRef = String(pr.head.ref);
      if (pr.head.repo && pr.head.repo.full_name) headRepoFull = String(pr.head.repo.full_name);
    }
  }

  const mr = await callRest(
    [{ method: "PUT", url: apiUrl(repo, "/pulls/" + num + "/merge"), json: { merge_method: method }, timeoutMs }],
    { timeoutSec },
  );
  if (!mr.ok) return label + " execution failed (PR #" + num + "): " + mr.message;
  const mres = mr.results[0];
  const mjson = mres && mres.json ? mres.json : null;
  const merged = Boolean(mjson && mjson.merged);

  if (!mres || !mres.ok || !merged) {
    const detail = errorDetail(mres);
    const st = mres && mres.status;
    if (/already merged/i.test(detail)) {
      return label + ": PR #" + num + " is already merged (it cannot be merged twice).\n" + detail;
    }
    if (st === 405) {
      return label + ": PR #" + num + " is not mergeable right now (405). Common causes: conflicts, a required check that has not passed, or a missing required review.\nGitHub raw message: " + detail;
    }
    if (st === 409) {
      return label + ": PR #" + num + " has a merge conflict (409): the source and target branches conflict and it must be resolved first.\nGitHub raw message: " + detail;
    }
    return label + " execution failed (PR #" + num + "): " + describeFailure(mres, repoLabel);
  }

  const out = [
    label + " done (PR #" + num + " · " + repoLabel + " · method=" + method + (deleteBranch ? " · deleteBranch" : "") + "):",
    "state: MERGED" + (mjson && mjson.message ? " · " + String(mjson.message) : ""),
  ];

  // 删源分支：DELETE /repos/{o}/{r}/git/refs/heads/{branch}
  if (deleteBranch) {
    // resolveContext 返回的 repo 已经是 "owner/repo" 字符串（不是对象）。
    // 与 headRepoFull（GitHub 的 full_name）比较时忽略大小写：两边大小写不保证一致。
    const baseFull = repo;
    if (!headRef) {
      out.push("source branch deletion: could not fetch the source branch name (deletion skipped).");
    } else if (headRepoFull && headRepoFull.toLowerCase() !== baseFull.toLowerCase()) {
      // fork 来的 PR：head.ref 在源仓库，同名分支在 base 仓库里只是同名而已，
      // 删它等于误删他人分支。不跨仓删。
      out.push(
        "source branch: " + headRef + " comes from " + headRepoFull + " (not this repository), deletion skipped" +
          " (branches are never deleted across repositories; if you need to clean up, do it in the source repository).",
      );
    } else {
      const dr = await callRest(
        [{ method: "DELETE", url: apiUrl(repo, "/git/refs/heads/" + encodeURIComponent(headRef)), timeoutMs }],
        { timeoutSec },
      );
      const dres = dr.ok ? dr.results[0] : null;
      if (dres && (dres.ok || dres.status === 404 || dres.status === 422)) {
        out.push("source branch: " + headRef + " deleted" + (dres.status === 404 ? " (it did not exist in the first place)" : ""));
      } else {
        out.push("source branch: deleting " + headRef + " failed — " + (dres ? describeFailure(dres, repoLabel) : dr.message));
      }
    }
  }

  // 终态确认（合并是异步落地，取一次 state/merged 更可靠）。
  const conf = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  const cp = conf.ok && conf.results[0] && conf.results[0].json ? conf.results[0].json : null;
  if (cp) {
    out.push("confirmation: state=" + String(cp.state || "?").toUpperCase() + (cp.merged ? " · merged=true" : "") +
      (cp.merged_at ? " · merged at " + fmtTime(cp.merged_at) : ""));
    if (cp.html_url) out.push("URL: " + cp.html_url);
  }
  return out.join("\n");
}
