// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr_merge：合并 PR（写面 action，不可撤销）。
 *
 * prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?（合并后删源分支）。
 * 走 REST `PUT /pulls/{n}/merge`，成功后再取一次终态确认（合并是异步落地，取一次更可靠）。
 *
 * deleteBranch 删的是 `DELETE /repos/{o}/{r}/git/refs/heads/{branch}`。删之前必须先取源分支
 * 的**来源仓库**：源分支可能来自 fork，而删的是 base 仓库的 refs——只看 head.ref 就删，会在
 * 同名的无关分支上动手（fork PR 的常见情形）。所以跨仓一律不删。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../lib/rest.js";
import { validatePositiveInt } from "../lib/github.js";
import { resolveContext, describeFailure, fmtTime } from "../lib/pr.js";

export const command = "pr_merge";
export const summary = "合并 PR（不可撤销）";

export const fields = {
  prNumber: {
    type: "integer",
    minimum: 1,
    description: "PR 编号（正整数），必填",
  },
  method: {
    type: "string",
    enum: ["merge", "squash", "rebase"],
    description: "合并方式（默认 merge）",
  },
  deleteBranch: {
    type: "boolean",
    description: "合并后删除源分支（源分支来自 fork 时跳过，不跨仓库删）",
  },
};
export const required = ["prNumber"];

export const sideEffect = {
  kind: "github_pr",
  summary:
    "合并 GitHub 远端 PR（自写 REST 通道）：不可撤销，会合并代码并可能删除源分支（deleteBranch），执行前请确认 repo 与 prNumber",
  ruleId: "github-toolkit-pr-merge",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = validatePositiveInt(input?.prNumber, "prNumber");
  if (numRes.error) return label + " 参数错误：" + numRes.error + "（merge 必须指定要合并的 PR 编号）。";
  const num = numRes.value;

  const method = input?.method !== undefined && input?.method !== null ? String(input.method).trim() : "merge";
  if (!["merge", "squash", "rebase"].includes(method)) {
    return label + " 参数错误：method 必须是 merge / squash / rebase（收到：" + method + "）。";
  }
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
  if (!mr.ok) return label + " 执行失败（PR #" + num + "）：" + mr.message;
  const mres = mr.results[0];
  const mjson = mres && mres.json ? mres.json : null;
  const merged = Boolean(mjson && mjson.merged);

  if (!mres || !mres.ok || !merged) {
    const detail = errorDetail(mres);
    const st = mres && mres.status;
    if (/already merged/i.test(detail)) {
      return label + "：PR #" + num + " 已经合并（不可重复合并）。\n" + detail;
    }
    if (st === 405) {
      return label + "：PR #" + num + " 当前不可合并（405）。常见原因：有冲突、必需检查未通过、或缺少必需审查。\nGitHub 原文：" + detail;
    }
    if (st === 409) {
      return label + "：PR #" + num + " 合并冲突（409）：源分支与目标分支有冲突，需先解决。\nGitHub 原文：" + detail;
    }
    return label + " 执行失败（PR #" + num + "）：" + describeFailure(mres, repoLabel);
  }

  const out = [
    label + " 已执行（PR #" + num + " · " + repoLabel + " · method=" + method + (deleteBranch ? " · deleteBranch" : "") + "）：",
    "状态：MERGED（已合并）" + (mjson && mjson.message ? " · " + String(mjson.message) : ""),
  ];

  // 删源分支：DELETE /repos/{o}/{r}/git/refs/heads/{branch}
  if (deleteBranch) {
    // resolveContext 返回的 repo 已经是 "owner/repo" 字符串（不是对象）。
    // 与 headRepoFull（GitHub 的 full_name）比较时忽略大小写：两边大小写不保证一致。
    const baseFull = repo;
    if (!headRef) {
      out.push("源分支删除：未能取到源分支名（跳过删除）。");
    } else if (headRepoFull && headRepoFull.toLowerCase() !== baseFull.toLowerCase()) {
      // fork 来的 PR：head.ref 在源仓库，同名分支在 base 仓库里只是同名而已，
      // 删它等于误删他人分支。不跨仓删。
      out.push(
        "源分支：" + headRef + " 来自 " + headRepoFull + "（不是本仓库），跳过删除" +
          "（不跨仓库删分支；如需清理请到源仓库操作）。",
      );
    } else {
      const dr = await callRest(
        [{ method: "DELETE", url: apiUrl(repo, "/git/refs/heads/" + encodeURIComponent(headRef)), timeoutMs }],
        { timeoutSec },
      );
      const dres = dr.ok ? dr.results[0] : null;
      if (dres && (dres.ok || dres.status === 404 || dres.status === 422)) {
        out.push("源分支：" + headRef + " 已删除" + (dres.status === 404 ? "（本来就不存在）" : ""));
      } else {
        out.push("源分支：" + headRef + " 删除失败——" + (dres ? describeFailure(dres, repoLabel) : dr.message));
      }
    }
  }

  // 终态确认（合并是异步落地，取一次 state/merged 更可靠）。
  const conf = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  const cp = conf.ok && conf.results[0] && conf.results[0].json ? conf.results[0].json : null;
  if (cp) {
    out.push("确认：state=" + String(cp.state || "?").toUpperCase() + (cp.merged ? " · merged=true" : "") +
      (cp.merged_at ? " · 合并于 " + fmtTime(cp.merged_at) : ""));
    if (cp.html_url) out.push("URL：" + cp.html_url);
  }
  return out.join("\n");
}
