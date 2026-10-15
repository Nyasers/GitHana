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
export const summary = "提交 PR 审查（approve / request-changes / comment）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  event: z
    .enum(["approve", "request-changes", "comment"])
    .describe("审查结论：approve（批准）/ request-changes（请求修改，必须带 body）/ comment（只留意见）"),
  body: z.string().optional().describe("审查说明：request-changes 必填；approve / comment 可选（支持 Markdown 与中文）"),
  comments: z
    .array(
      z.object({
        path: z.string().describe("文件路径（相对仓库根）"),
        line: z.number().int().min(1).describe("新文件那一侧的行号（diff 右侧）"),
        body: z.string().describe("该行的意见内容"),
      }),
    )
    .optional()
    .describe("可选：行内意见列表，每条要 path + line（新文件侧行号）+ body"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "在 GitHub 远端提交 PR 审查（批准 / 请求修改 / 留意见，可含行内意见）：写入 PR 时间线且不可撤回，执行前请确认 repo、prNumber 与审查结论",
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
    return label + " 参数错误：event=request-changes 必须带 body（GitHub 要求请求修改时说清要改什么）。";
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const st = res && res.status;
    if (st === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次审查（422）。常见原因：对自己开的 PR 请求修改、行内意见的\n" +
        "path / line 不在本次 diff 里、或 event 与 body 的组合不合法。\nGitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const rv = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已提交（PR #" + numStr + " · " + repoLabel + " · event=" + event + "）：",
    "审查人：" + (rv.user && rv.user.login ? "@" + rv.user.login : "?") +
      " · 结论：" + String(rv.state || event) +
      (rv.submitted_at ? " · " + String(rv.submitted_at) : ""),
  ];
  if (payload.comments) out.push("行内意见：" + payload.comments.length + " 条");
  if (rv.html_url) out.push("URL：" + rv.html_url);

  // 审查提交后**重新取一次**聚合：单条审查不足以外推 PR 的整体审查状态
  // （别人可能已经请求修改）。取不到就如实说明，不拿刚才那条冒充整体。
  const after = await callRest(
    [{ url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), timeoutMs, paginate: true }],
    { timeoutSec },
  );
  const aggregated = after.ok && after.results[0] && after.results[0].ok ? after.results[0].json : null;
  out.push(
    aggregated
      ? "当前审查状态（按评审记录聚合）：" + reviewSummary(aggregated).text
      : "当前审查状态：未能重新核对（读取 reviews 失败，不影响本次审查已提交）",
  );
  return out.join("\n");
}
