// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/reopen：重新打开已关闭的 issue（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}` 带 `{ state: "open", state_reason: "reopened" }`
 * （支撑权限 `issues: write`）。state_reason 用 `reopened` 是 GitHub 的约定值，不传也行，
 * 传了能让「为什么又开着」在时间线上可读。
 *
 * 已经是打开状态的 issue 再开一次是幂等的，本动词如实回报「本来就是打开态」。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { notAnIssueMessage, issueStateText } from "../../lib/issue.js";

export const command = "reopen";
export const summary = "重新打开已关闭的 issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  comment: z.string().optional().describe("可选：重开时附一条说明评论（先评论再重开，两次请求）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "重新打开 GitHub 远端已关闭的 issue（state=open，state_reason=reopened）：修改 GitHub 远端状态，执行前请确认 repo 与编号",
  ruleId: "github-toolkit-issue-reopen",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先看现状：本来就是打开态就不用发这条 PATCH（如实回报，不假装做了一次改动）。
  const before = await callRest(
    [{ url: apiUrl(repo, "/issues/" + numStr), timeoutMs }],
    { timeoutSec },
  );
  if (before.ok && before.results[0] && before.results[0].ok) {
    const cur = before.results[0].json && typeof before.results[0].json === "object" ? before.results[0].json : {};
    // PR 与 issue 共用编号空间：是 PR 就指向 githana_pr，不按 issue 代劳（见 lib/issue.js）。
    if (cur.pull_request && cur.pull_request.url) {
      return notAnIssueMessage(
        label,
        numStr,
        repoLabel,
        cur,
        "要重开这个 PR 请用 githana_pr(action=\"reopen\", prNumber=" + numStr + ")。",
      );
    }
    if (String(cur.state) === "open") {
      const out = [label + "：issue #" + numStr + " 本来就是打开状态（open），无需重开。", "状态：" + issueStateText(cur)];
      if (cur.html_url) out.push("URL：" + cur.html_url);
      return out.join("\n");
    }
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
    id: "reopen",
    method: "PATCH",
    url: apiUrl(repo, "/issues/" + numStr),
    json: { state: "open", state_reason: "reopened" },
    timeoutMs,
  });

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const rres = r.results.find((x) => x.id === "reopen");
  const cmres = r.results.find((x) => x.id === "comment");
  if (!rres || !rres.ok) {
    if (rres && rres.status === 404) return label + "：#" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (rres && rres.status === 422) {
      return label + " 执行失败：无法重开 issue #" + numStr + "（422）。\nGitHub 原文：" + errorDetail(rres);
    }
    return label + " 执行失败：" + describeFailure(rres, repoLabel);
  }

  const issue = rres.json && typeof rres.json === "object" ? rres.json : {};
  const out = [label + " 已执行（issue #" + numStr + " · " + repoLabel + "）：", "状态：" + issueStateText(issue)];
  if (comment.trim() !== "") {
    out.push(
      cmres && cmres.ok
        ? "已附说明评论（" + comment.length + " 字符）。"
        : "说明评论发布失败（" + (cmres ? describeFailure(cmres, repoLabel) : "无结果") + "），重开本身已生效。",
    );
  }
  if (issue.html_url) out.push("URL：" + issue.html_url);
  return out.join("\n");
}
