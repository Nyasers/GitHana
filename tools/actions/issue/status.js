// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/status：issue 状态速览（githana_issue 动词）。
 *
 * 与 `view` 的分工（与 pr 的 status / view 同一口径）：`status` 是**扫一眼判断该不该动手**
 * （短、聚合：状态 / 标签 / 指派 / 评论数 / 锁），`view` 是**要读内容**（正文全文 + 评论）。
 *
 * 一次请求取 issue 本体；收到 PR 编号时如实说明并指向 githana_pr。只读，不改远端状态。
 */
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { notAnIssueMessage, issueStateText, labelText, assigneeText } from "../../lib/issue.js";

export const command = "status";
export const summary = "issue 状态速览";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const r = await callRest(
    [{ url: apiUrl(repo, "/issues/" + numStr), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：#" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const issue = res.json && typeof res.json === "object" ? res.json : {};
  if (issue.pull_request && issue.pull_request.url) {
    return notAnIssueMessage(label, numStr, repoLabel, issue);
  }

  const out = [];
  out.push(label + " issue #" + numStr + " · " + repoLabel);
  out.push("标题：" + (issue.title || "（无标题）"));
  out.push("状态：" + issueStateText(issue) + " · 作者：@" + ((issue.user && issue.user.login) || "?"));
  out.push("标签：" + (labelText(issue) || "（无）"));
  out.push("指派：" + (assigneeText(issue) || "（无）"));
  if (issue.milestone && issue.milestone.title) out.push("里程碑：" + issue.milestone.title);
  out.push(
    "评论：" + (issue.comments !== undefined ? issue.comments : "?") + " 条" +
    " · 创建 " + fmtTime(issue.created_at) +
    (issue.updated_at ? " · 更新 " + fmtTime(issue.updated_at) : "") +
    (issue.closed_at ? " · 关闭 " + fmtTime(issue.closed_at) : ""),
  );
  // 其它字段单独一行：没有就不打（"没有也算一种信息"靠的是不虚构，不是靠打一行空话）。
  const linked = [];
  if (issue.active_lock_reason) linked.push("锁定理由 " + issue.active_lock_reason);
  if (issue.locked === true && !issue.active_lock_reason) linked.push("已锁定（locked）");
  if (linked.length) out.push("其它：" + linked.join(" · "));
  if (issue.html_url) out.push("URL：" + issue.html_url);
  return out.join("\n");
}
