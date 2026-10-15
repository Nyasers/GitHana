// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/view：PR 详情（githana_pr 动词）。
 *
 * prNumber 缺省时用当前分支查（REST 没有「当前分支关联 PR」的语义，所以先取当前分支再按
 * head 过滤，见 lib/pr.js 的 resolvePrNumber）。输出 title/state/head→base/审查状态/合并状态/
 * URL/body（截断）。
 *
 * 审查状态由 `GET /pulls/{n}/reviews` 的评审记录聚合而成（REST 无 reviewDecision，见 lib/pr.js）。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, fmtTime, reviewSummary, mergeStateText } from "../../lib/pr.js";

export const command = "view";
export const summary = "PR 详情（含 reviews）";

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

  // prNumber 缺省 = 当前分支关联 PR（共享那一跳，见 lib/pr.js）。
  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const r = await callRest(
    [
      { id: "pr", url: apiUrl(repo, "/pulls/" + numStr), timeoutMs },
      { id: "reviews", url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), timeoutMs, paginate: true },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const prRes = r.results.find((x) => x.id === "pr");
  const rvRes = r.results.find((x) => x.id === "reviews");
  if (!prRes || !prRes.ok) {
    const st = prRes && prRes.status;
    if (st === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(prRes, repoLabel);
  }

  const pr = prRes.json && typeof prRes.json === "object" ? prRes.json : {};
  const author = pr.user && pr.user.login ? "@" + pr.user.login : "?";
  const headRef = pr.head && pr.head.ref ? pr.head.ref : "?";
  const baseRef = pr.base && pr.base.ref ? pr.base.ref : "?";
  const review = reviewSummary(rvRes && rvRes.ok ? rvRes.json : []);

  const out = [];
  out.push("PR #" + pr.number + "：「" + (pr.title || "（无标题）") + "」");
  out.push(
    "状态：" + String(pr.state || "?").toUpperCase() + (pr.draft ? "（草稿 draft）" : "") +
    (pr.merged ? "（已合并）" : "") +
    " · 分支：" + headRef + " → " + baseRef +
    " · 作者：" + author,
  );
  out.push("审查：" + review.text + " · 合并：" + mergeStateText(pr.mergeable_state));
  if (pr.created_at) out.push("创建于：" + fmtTime(pr.created_at) + (pr.merged_at ? " · 合并于：" + fmtTime(pr.merged_at) : ""));
  if (pr.html_url) out.push("URL：" + pr.html_url);
  const stats =
    (pr.commits !== undefined ? "提交 " + pr.commits : "") +
    (pr.changed_files !== undefined ? " · 文件 " + pr.changed_files : "") +
    (pr.additions !== undefined ? " · +" + pr.additions : "") +
    (pr.deletions !== undefined ? " · -" + pr.deletions : "");
  if (stats) out.push("规模：" + stats);
  const body = pr.body !== null && pr.body !== undefined ? String(pr.body) : "";
  const BODY_MAX = 2000;
  out.push("");
  out.push("—— 正文" + (body.length > BODY_MAX ? "（截断，共 " + body.length + " 字符）" : "") + " ——");
  out.push(body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body) : "（无正文）");
  return out.join("\n");
}
