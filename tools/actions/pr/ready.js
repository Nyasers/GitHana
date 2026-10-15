// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/ready：把草稿 PR 转为可审查（githana_pr 动词）。
 *
 * ## 为什么只有这一条路
 *
 * 「取消草稿」只有 GraphQL 能做，两条 REST 路都走不通（实测，见 spec gh-cli-parity 的
 * 实测记录）：
 *   · `PATCH /repos/{o}/{r}/pulls/{n}` 带 `{ draft: false }` 返回 **200 但不生效**
 *     （`isDraft` 仍是 true）——它会静默地假装成功；
 *   · `POST /repos/{o}/{r}/pulls/{n}/ready_for_review` 返回 **404**（那个端点不存在）。
 *
 * 所以本动词先用 REST 取一次 `node_id`（GraphQL 的入参是 node id，不是数字编号），
 * 再发 GraphQL 变更：`markPullRequestReadyForReview`（`undo=true` 时反向的
 * `convertPullRequestToDraft`）。这就是 spec D5「通道不设限」的样子——一个动词内部两条通道，
 * 对外一份返回结构，调用方不感知差异（AC11）。
 *
 * ## 两个方向都在同一个动词上
 *
 * 转 ready 是 `undo=false`（缺省），转草稿是 `undo=true`。gh 把它们分成
 * `pr ready` 与 `pr ready --undo`，本工具照同一条形状走，不另开一个动词。
 *
 * 支撑权限 `pull_requests: write`（D7 已授权）。幂等：已经是目标状态的 PR 不再发变更，
 * 如实回报「本来就是」，不发一次注定被拒的请求。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText } from "../../lib/pr.js";
import { graphql } from "../../lib/graphql.js";

export const command = "ready";
export const summary = "Turn a draft PR into ready for review (undo=true reverses it back to draft)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  undo: z
    .boolean()
    .optional()
    .describe("Optional: true = the reverse operation, turning the PR back into a draft (convertPullRequestToDraft); default / false = turn it ready"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Modify a remote GitHub PR's status flag: turn a draft PR into ready for review (with undo=true, back into a draft) — turning it ready notifies reviewers and lets it take part in merge decisions, while turning it back into a draft makes it unmergeable; confirm repo and prNumber before running",
  ruleId: "github-toolkit-pr-ready",
};

/** markPullRequestReadyForReview：草稿 → 可审查。入参是 PR 的 node id。 */
const MARK_READY_MUTATION = [
  "mutation($id: ID!) {",
  "  markPullRequestReadyForReview(input: { pullRequestId: $id }) {",
  "    pullRequest { number isDraft url }",
  "  }",
  "}",
].join("\n");

/** convertPullRequestToDraft：可审查 → 草稿（`undo=true` 走这条）。 */
const CONVERT_TO_DRAFT_MUTATION = [
  "mutation($id: ID!) {",
  "  convertPullRequestToDraft(input: { pullRequestId: $id }) {",
  "    pullRequest { number isDraft url }",
  "  }",
  "}",
].join("\n");

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const undo = input?.undo === true;
  const toText = undo ? "draft" : "ready for review";
  const fromText = undo ? "ready for review" : "draft";

  // ① REST 取 PR 本体：node_id 是 GraphQL 的入参，draft 是幂等判断的依据。
  const r = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }
  const pr = res.json && typeof res.json === "object" ? res.json : {};

  // 状态位只在 open 的 PR 上有意义：已关闭 / 已合并的 PR 不在 review 状态，报「无需操作」会让
  // 调用方以为它还在评审队列里。所以这一条排在幂等分支（以及 node_id 的形状检查）**之前**，
  // 并按状态给不同去处。
  if (String(pr.state || "") !== "open") {
    const next =
      pr.merged === true
        ? "It has already been merged and the changes are on the base branch — to undo them use githana_pr(action=\"revert\", prNumber=" + numStr + ")."
        : "To put it back into review, reopen it first: githana_pr(action=\"reopen\", prNumber=" + numStr + ").";
    return [
      label + " cannot change the status flag (PR #" + numStr + " · " + repoLabel + "):",
      "its state is " + prStateText(pr) + ", so it is not in the open review flow — the status flag is only meaningful for open PRs.",
      next,
    ].join("\n");
  }

  const nodeId = pr.node_id ? String(pr.node_id) : "";
  if (!nodeId) {
    return (
      label + " execution failed: the REST response for PR #" + numStr + " has no node_id." +
      "The GraphQL mutation only accepts a node id, so without it the state cannot be changed (this is not a permission problem but an abnormal response shape)."
    );
  }

  const isDraft = pr.draft === true;
  // 幂等：已经是目标状态就不再发变更——转 ready 只对草稿有意义，反向只对非草稿有意义。
  if (!undo && !isDraft) {
    return [
      label + " nothing to do (PR #" + numStr + " · " + repoLabel + "):",
      "it is not a draft to begin with (current state: " + prStateText(pr) + ").",
      "To turn a ready-for-review PR back into a draft, add undo=true.",
    ].join("\n");
  }
  if (undo && isDraft) {
    return [
      label + " nothing to do (PR #" + numStr + " · " + repoLabel + "):",
      "it is already a draft (current state: " + prStateText(pr) + ").",
      "To make it ready, just call githana_pr(action=\"ready\") (without undo).",
    ].join("\n");
  }

  // ② GraphQL 变更：un-draft 只有这一条路（REST 的 PATCH draft:false 实测 200 但不生效）。
  const g = await graphql(undo ? CONVERT_TO_DRAFT_MUTATION : MARK_READY_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) {
    if (/not a draft|already.*ready/i.test(g.error)) {
      return label + ": PR #" + numStr + " is not a draft at this moment (GitHub's raw message indicates the state has changed); no need to repeat the operation.";
    }
    if (/is a draft|already.*draft/i.test(g.error) && undo) {
      return label + ": PR #" + numStr + " is already a draft at this moment (GitHub's raw message indicates the state has changed); no need to repeat the operation.";
    }
    return label + " execution failed: " + g.error;
  }

  const payload = g.data && typeof g.data === "object" ? g.data : {};
  const changed =
    (undo ? payload.convertPullRequestToDraft : payload.markPullRequestReadyForReview) || null;
  const after = changed && changed.pullRequest && typeof changed.pullRequest === "object" ? changed.pullRequest : {};

  const out = [
    label + " done (PR #" + numStr + " · " + repoLabel + "):",
    "status flag: " + fromText + " → " + toText,
    "channel: GraphQL " + (undo ? "convertPullRequestToDraft" : "markPullRequestReadyForReview") +
      " (REST cannot move this status flag: PATCH with draft returns 200 but has no effect, and the ready_for_review endpoint returns 404)",
  ];
  if (after.isDraft !== undefined && after.isDraft !== null) {
    // 报的是**方向**而不是字面值：isDraft=true 在转 ready 那边是「没生效」，在 undo 这边是「成了」。
    const ok = undo ? after.isDraft === true : after.isDraft === false;
    out.push(
      "isDraft as reported by GitHub: " + String(after.isDraft === true) +
        " (" + (ok ? "matches the target state" : "does not match the target state — verify with githana_pr(action=\"view\")") + ")",
    );
  }
  if (after.url) out.push("URL: " + String(after.url));
  else if (pr.html_url) out.push("URL: " + pr.html_url);
  if (!undo) out.push("note: once ready, the PR notifies reviewers and takes part in merge decisions; to turn it back into a draft use githana_pr(action=\"ready\", undo=true).");
  else out.push("note: once back in draft, the PR cannot be merged and does not appear in the review queue; to make it ready again use githana_pr(action=\"ready\").");
  return out.join("\n");
}
