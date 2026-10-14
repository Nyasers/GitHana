// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/status：PR 状态速览（githana_pr 动词）。
 *
 * prNumber 缺省 = 当前分支关联 PR（见 lib/pr.js 的 resolvePrNumber）。一次请求取 PR 本体，
 * 再一次取 reviews 与 check-runs，把 gh `pr status` 关心的几档压成一块短输出：状态 / 分支 /
 * 审查 / 合并能力 / 检查计数 / URL。
 *
 * 与 `view` 的分工：`status` 是**扫一眼判断该不该动手**（短、聚合），`view` 是**要读内容**
 * （正文全文 + 规模统计）。两者都不改远端状态。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText, reviewSummary, mergeStateText, summarizeCheckRuns } from "../../lib/pr.js";

export const command = "status";
export const summary = "PR 状态速览（含审查与检查计数）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " 执行失败：" + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "?";
  const baseRef = pr.base && pr.base.ref ? String(pr.base.ref) : "?";
  const headSha = pr.head && pr.head.sha ? String(pr.head.sha) : "";

  // reviews 与 check-runs 都取一次：一个是审查现状，一个是检查现状，缺任一条都判不出能不能合。
  const batch = [{ id: "reviews", url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), timeoutMs }];
  if (headSha) {
    batch.push({
      id: "checks",
      url: apiUrl(repo, "/commits/" + headSha + "/check-runs") + "?per_page=100",
      timeoutMs,
    });
  }
  const r = await callRest(batch, { timeoutSec });
  const rvRes = r.ok ? r.results.find((x) => x.id === "reviews") : null;
  const ckRes = r.ok ? r.results.find((x) => x.id === "checks") : null;

  const review = reviewSummary(rvRes && rvRes.ok ? rvRes.json : []);
  const checks =
    headSha === ""
      ? "无检查数据（PR 响应里没有 head.sha）"
      : ckRes && ckRes.ok
        ? summarizeCheckRuns(ckRes.json).text
        : "检查数据读取失败（不影响状态本身）";

  const out = [];
  out.push(label + " PR #" + numStr + " · " + repoLabel);
  out.push("标题：" + (pr.title || "（无标题）"));
  out.push("状态：" + prStateText(pr) + " · 分支：" + headRef + " → " + baseRef);
  out.push("审查：" + review.text);
  out.push("合并：" + mergeStateText(pr.mergeable_state) + (pr.mergeable === false ? " · mergeable=false" : ""));
  out.push("检查：" + checks);
  if (pr.requested_reviewers && Array.isArray(pr.requested_reviewers) && pr.requested_reviewers.length) {
    const who = pr.requested_reviewers.map((u) => (u && u.login ? "@" + u.login : "?")).join(" · ");
    out.push("待审查人：" + who);
  }
  if (pr.html_url) out.push("URL：" + pr.html_url);
  return out.join("\n");
}
