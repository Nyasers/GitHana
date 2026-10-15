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
export const summary = "把目标分支合进 PR 源分支";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  expectedHeadSha: z
    .string()
    .optional()
    .describe("可选：源分支的预期 HEAD sha（乐观并发保护）；不符时 GitHub 返回 422，不在已变化的分支上动手"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "让 GitHub 把 PR 的目标分支合进源分支（可能产生一个合并提交并改写源分支）：修改 GitHub 远端状态，执行前请确认 repo、prNumber 与 expectedHeadSha",
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  const detail = errorDetail(res);

  // 202 = 已受理（更新是异步落地的）；422 分两种：已经在最新 / 有冲突。
  if (res && res.status === 202) {
    const out = [
      label + " 已受理（PR #" + numStr + " · " + repoLabel + "）：",
      "GitHub 已开始把目标分支合进源分支（异步落地，稍后用 view / status 看结果）。",
      res.json && res.json.message ? "原文：" + String(res.json.message) : "",
    ];
    return out.filter(Boolean).join("\n");
  }
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (res && res.status === 422) {
      if (/up.to.date|no new commits|already/i.test(detail)) {
        return label + "：PR #" + numStr + " 的源分支已经是目标分支的最新状态，无需更新（不是错误）。\nGitHub 原文：" + detail;
      }
      if (/merge conflict|conflict/i.test(detail)) {
        return (
          label + "：PR #" + numStr + " 与目标分支有冲突，GitHub 不做自动合并。\n" +
          "请在本地解决冲突后推到源分支，或用 githana_pr(action=\"view\") 看冲突状态。\nGitHub 原文：" + detail
        );
      }
      if (/expected_head_sha|head sha/i.test(detail)) {
        return (
          label + "：PR #" + numStr + " 的源分支 HEAD 已不是 expectedHeadSha（有人在期间推了新提交）。\n" +
          "请重新读一次 PR 确认最新 sha 再决定。\nGitHub 原文：" + detail
        );
      }
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const out = [label + " 已执行（PR #" + numStr + " · " + repoLabel + "）：", "状态：目标分支已合入源分支"];
  if (res.json && res.json.message) out.push("原文：" + String(res.json.message));

  // 取一次终态确认（更新也是异步落地的）。
  const conf = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  const cp = conf.ok && conf.results[0] && conf.results[0].ok ? conf.results[0].json : null;
  if (cp) {
    const headSha = cp.head && cp.head.sha ? String(cp.head.sha) : "";
    out.push("确认：state=" + String(cp.state || "?").toUpperCase() + (headSha ? " · 源分支 HEAD " + headSha.slice(0, 7) : ""));
  }
  return out.join("\n");
}
