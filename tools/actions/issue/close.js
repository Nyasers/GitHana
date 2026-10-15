// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/close：关闭 issue（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}` 带 `{ state: "closed", state_reason }`
 * （支撑权限 `issues: write`）。`state_reason` 是 GitHub 的关单理由：
 *   · `completed`（默认，已解决）· `not_planned`（不打算做）· `reopened`（那是 reopen 用的，
 *     这里不收）；gh `issue close --reason` 给的正是前两个。
 *
 * 关闭**不删**任何东西：评论与标签都留着，可以 reopen 回来。这一点与 `delete` 不同
 * （删不可撤销），所以两者是同级的独立动词。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage, issueStateText } from "../../lib/issue.js";

export const command = "close";
export const summary = "关闭 issue（可用 reopen 还原）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  reason: z
    .enum(["completed", "not_planned"])
    .optional()
    .describe("关闭理由（默认 completed）：completed（已解决）/ not_planned（不打算做）"),
  comment: z.string().optional().describe("可选：关闭时附一条说明评论（先评论再关闭，两次请求）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "关闭 GitHub 远端 issue（state=closed，可带关闭理由；不删除评论与历史，可用 reopen 还原）：修改 GitHub 远端状态，执行前请确认 repo 与编号",
  ruleId: "github-toolkit-issue-close",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  // 取值域由 schema 保证（enum）；这里只做缺省。
  const reason = String(input?.reason || "completed");

  // 先核对这个编号是 issue 而不是 PR：关闭端点两者相同，但工具面的归属不同——
  // 对 PR 该走 githana_pr(action="close")，这里如实指向它，不代劳（见 lib/issue.js）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "要关闭这个 PR 请用 githana_pr(action=\"close\", prNumber=" + numStr + ")。",
    );
  }

  const batch = [];
  const comment = input?.comment !== undefined && input?.comment !== null ? String(input.comment) : "";
  if (comment.trim() !== "") {
    batch.push({
      id: "comment",
      method: "POST",
      url: apiUrl(repo, "/issues/" + numStr + "/comments"),
      json: { body: comment },
      timeoutMs,
    });
  }
  batch.push({
    id: "close",
    method: "PATCH",
    url: apiUrl(repo, "/issues/" + numStr),
    json: { state: "closed", state_reason: reason },
    timeoutMs,
  });

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const cres = r.results.find((x) => x.id === "close");
  const cmres = r.results.find((x) => x.id === "comment");
  if (!cres || !cres.ok) {
    if (cres && cres.status === 404) return label + "：#" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(cres, repoLabel);
  }

  const issue = cres.json && typeof cres.json === "object" ? cres.json : {};
  const out = [
    label + " 已执行（issue #" + numStr + " · " + repoLabel + "）：",
    "状态：" + issueStateText(issue) + " · 理由：" + reason,
    "说明：关闭不删评论与历史；要还原用 githana_issue(action=\"reopen\")。",
  ];
  if (comment.trim() !== "") {
    out.push(
      cmres && cmres.ok
        ? "已附说明评论（" + comment.length + " 字符）。"
        : "说明评论发布失败（" + (cmres ? describeFailure(cmres, repoLabel) : "无结果") + "），关闭本身已生效。",
    );
  }
  if (issue.html_url) out.push("URL：" + issue.html_url);
  return out.join("\n");
}
