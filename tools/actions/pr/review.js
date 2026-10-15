// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/review：提交 PR 审查（githana_pr 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/pulls/{n}/reviews`（支撑权限 `pull_requests: write`）。
 * 三档 event 对应 gh `pr review` 的三个开关：
 *   · `approve`          → APPROVE
 *   · `request-changes`  → REQUEST_CHANGES（**必须**带 body，GitHub 拒空说明）
 *   · `comment`          → COMMENT（只留审查意见，不改裁决）
 *
 * 行内意见（`comments`）：每条要 `path` + `line` + `body`。`line` 是**新文件那一侧**的行号
 * （diff 右侧）；要指向被删掉的行得用 `side: "LEFT"`，那种场合很少，这里不开口子——需要时走
 * `githana_api` 直接打这个端点。
 *
 * 不可撤销：审查一旦提交就在 PR 的时间线上（可以再提交一次相反的审查，但记录不会消失）。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, reviewSummary } from "../../lib/pr.js";

export const command = "review";
export const summary = "Submit a PR review (approve / request-changes / comment)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  event: z
    .enum(["approve", "request-changes", "comment"])
    .describe("Review verdict: approve / request-changes (must carry a body) / comment (leave an opinion only)"),
  body: z.string().optional().describe("Review text: required for request-changes; optional for approve / comment (supports Markdown and Chinese)"),
  comments: z
    .array(
      z.object({
        path: z.string().describe("File path (relative to the repository root)"),
        line: z.number().int().min(1).describe("Line number on the new-file side (the right side of the diff)"),
        body: z.string().describe("The comment text for that line"),
      }),
    )
    .optional()
    .describe("Optional: list of inline comments; each needs path + line (new-file side line number) + body"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Submit a PR review on remote GitHub (approve / request changes / leave a comment, optionally with inline comments): written to the PR timeline and cannot be withdrawn — confirm repo, prNumber and the review verdict before running",
  ruleId: "github-toolkit-pr-review",
};

/** gh 的开关名 → REST 的 event 值。 */
const EVENT_MAP = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" };

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // event 的取值域由 schema 保证（enum）；这里只做映射与跨字段约束。
  const kind = String(input.event);
  const event = EVENT_MAP[kind];
  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";

  if (kind === "request-changes" && !body.trim()) {
    return label + " argument error: event=request-changes must carry a body (GitHub requires you to say what should change when requesting changes).";
  }

  const payload = { event };
  if (body.trim()) payload.body = body;
  if (Array.isArray(input?.comments) && input.comments.length > 0) {
    payload.comments = input.comments.map((it) => ({
      path: String(it.path),
      line: Number(it.line),
      body: String(it.body),
    }));
  }

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), json: payload, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const st = res && res.status;
    if (st === 422) {
      return (
        label + " execution failed: GitHub rejected this review (422). Common causes: requesting changes on a PR you opened yourself, an inline comment's\n" +
        "path / line not being in this diff, or an invalid combination of event and body.\nGitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const rv = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " submitted (PR #" + numStr + " · " + repoLabel + " · event=" + event + "):",
    "reviewer: " + (rv.user && rv.user.login ? "@" + rv.user.login : "?") +
      " · verdict: " + String(rv.state || event) +
      (rv.submitted_at ? " · " + String(rv.submitted_at) : ""),
  ];
  if (payload.comments) out.push("inline comments: " + payload.comments.length);
  if (rv.html_url) out.push("URL: " + rv.html_url);

  // 审查提交后**重新取一次**聚合：单条审查不足以外推 PR 的整体审查状态
  // （别人可能已经请求修改）。取不到就如实说明，不拿刚才那条冒充整体。
  const after = await callRest(
    [{ url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), timeoutMs, paginate: true }],
    { timeoutSec },
  );
  const aggregated = after.ok && after.results[0] && after.results[0].ok ? after.results[0].json : null;
  out.push(
    aggregated
      ? "current review state (aggregated from the review records): " + reviewSummary(aggregated).text
      : "current review state: could not be re-verified (reading reviews failed; this review was still submitted)",
  );
  return out.join("\n");
}
