// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr_view：PR 详情（只读面 action）。
 *
 * prNumber 缺省时用当前分支查（REST 没有「当前分支关联 PR」的语义，所以先取当前分支再按
 * head 过滤）。输出 title/state/head→base/审查状态/合并状态/URL/body（截断）。
 *
 * 审查状态由 `GET /pulls/{n}/reviews` 的评审记录聚合而成（REST 无 reviewDecision，见 lib/pr.js）。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../lib/rest.js";
import { validatePositiveInt } from "../lib/github.js";
import { resolveContext, describeFailure, fmtTime, reviewSummary, mergeStateText, currentBranch } from "../lib/pr.js";

export const command = "pr_view";
export const summary = "PR 详情（含 reviews）";

export const fields = {
  prNumber: {
    type: "integer",
    minimum: 1,
    description: "PR 编号（正整数）；缺省 = 当前分支关联 PR（需要 cwd）",
  },
};
export const required = [];

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, cwd, timeoutSec } = c;

  let numStr = "";
  if (input?.prNumber !== undefined && input?.prNumber !== null && input?.prNumber !== "") {
    const numRes = validatePositiveInt(input.prNumber, "prNumber");
    if (numRes.error) return label + " 参数错误：" + numRes.error;
    numStr = String(numRes.value);
  }

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  if (!numStr) {
    // 缺省 = 当前分支关联 PR：先取当前分支，再按 head 过滤。
    if (!cwd) {
      return (
        label + " 参数错误：未传 prNumber，而缺省值需要 cwd 来确定当前分支（REST 无「当前分支关联 PR」语义）。\n" +
        "请传 prNumber，或在 git 仓库 cwd 内执行。"
      );
    }
    const cur = await currentBranch(cwd);
    if (cur.error) return label + " 无法确定当前分支：" + cur.error;
    const listUrl =
      apiUrl(repo, "/pulls") + "?state=open&head=" + encodeURIComponent(repo.split("/")[0] + ":" + cur.branch) + "&per_page=1";
    const lr = await callRest([{ url: listUrl, timeoutMs }], { timeoutSec });
    if (!lr.ok) return label + " 执行失败：" + lr.message;
    const lres = lr.results[0];
    if (!lres || !lres.ok) return label + " 执行失败：" + describeFailure(lres, repoLabel);
    const arr = Array.isArray(lres.json) ? lres.json : [];
    if (arr.length === 0) {
      return label + "：当前分支（" + cur.branch + "）没有打开的关联 PR。可显式传 prNumber 查看指定 PR。";
    }
    numStr = String(arr[0].number);
  }

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
