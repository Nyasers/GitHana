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
export const summary = "把草稿 PR 转为可审查（undo=true 反向转回草稿）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  undo: z
    .boolean()
    .optional()
    .describe("可选：true = 反向操作，把 PR 转回草稿（convertPullRequestToDraft）；缺省 / false = 转 ready"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "修改 GitHub 远端 PR 的状态位：把草稿 PR 转为可审查（undo=true 则是转回草稿）——转 ready 后 PR 会通知审查者并参与合并判断，转回草稿会让它不能合并，执行前请确认 repo 与 prNumber",
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
  const toText = undo ? "草稿（draft）" : "可审查（ready for review）";
  const fromText = undo ? "可审查（ready for review）" : "草稿（draft）";

  // ① REST 取 PR 本体：node_id 是 GraphQL 的入参，draft 是幂等判断的依据。
  const r = await callRest([{ url: apiUrl(repo, "/pulls/" + numStr), timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }
  const pr = res.json && typeof res.json === "object" ? res.json : {};

  // 状态位只在 open 的 PR 上有意义：已关闭 / 已合并的 PR 不在 review 状态，报「无需操作」会让
  // 调用方以为它还在评审队列里。所以这一条排在幂等分支（以及 node_id 的形状检查）**之前**，
  // 并按状态给不同去处。
  if (String(pr.state || "") !== "open") {
    const next =
      pr.merged === true
        ? "它已经合并了，改动已在目标分支上——要撤销请用 githana_pr(action=\"revert\", prNumber=" + numStr + ")。"
        : "要让它重新进入评审请先重开：githana_pr(action=\"reopen\", prNumber=" + numStr + ")。";
    return [
      label + " 无法改状态位（PR #" + numStr + " · " + repoLabel + "）：",
      "它的状态是 " + prStateText(pr) + "，不在 open 的评审流程里——状态位只在 open 的 PR 上有意义。",
      next,
    ].join("\n");
  }

  const nodeId = pr.node_id ? String(pr.node_id) : "";
  if (!nodeId) {
    return (
      label + " 执行失败：PR #" + numStr + " 的 REST 响应里没有 node_id。" +
      "GraphQL 的变更只收 node id，缺它就无法转状态（这不是权限问题，是响应形态异常）。"
    );
  }

  const isDraft = pr.draft === true;
  // 幂等：已经是目标状态就不再发变更——转 ready 只对草稿有意义，反向只对非草稿有意义。
  if (!undo && !isDraft) {
    return [
      label + " 无需执行（PR #" + numStr + " · " + repoLabel + "）：",
      "它本来就不是草稿（当前状态：" + prStateText(pr) + "）。",
      "要把一个可审查的 PR 转回草稿请加 undo=true。",
    ].join("\n");
  }
  if (undo && isDraft) {
    return [
      label + " 无需执行（PR #" + numStr + " · " + repoLabel + "）：",
      "它本来就是草稿（当前状态：" + prStateText(pr) + "）。",
      "要转 ready 直接调 githana_pr(action=\"ready\")（不带 undo）。",
    ].join("\n");
  }

  // ② GraphQL 变更：un-draft 只有这一条路（REST 的 PATCH draft:false 实测 200 但不生效）。
  const g = await graphql(undo ? CONVERT_TO_DRAFT_MUTATION : MARK_READY_MUTATION, { id: nodeId }, { timeoutSec });
  if (g.error) {
    if (/not a draft|already.*ready/i.test(g.error)) {
      return label + "：PR #" + numStr + " 此刻已经不是草稿了（GitHub 原文说明状态已变），无需重复操作。";
    }
    if (/is a draft|already.*draft/i.test(g.error) && undo) {
      return label + "：PR #" + numStr + " 此刻已经是草稿了（GitHub 原文说明状态已变），无需重复操作。";
    }
    return label + " 执行失败：" + g.error;
  }

  const payload = g.data && typeof g.data === "object" ? g.data : {};
  const changed =
    (undo ? payload.convertPullRequestToDraft : payload.markPullRequestReadyForReview) || null;
  const after = changed && changed.pullRequest && typeof changed.pullRequest === "object" ? changed.pullRequest : {};

  const out = [
    label + " 已执行（PR #" + numStr + " · " + repoLabel + "）：",
    "状态位：" + fromText + " → " + toText,
    "通道：GraphQL " + (undo ? "convertPullRequestToDraft" : "markPullRequestReadyForReview") +
      "（REST 改不动这个状态位：PATCH 带 draft 返回 200 但不生效，ready_for_review 端点返回 404）",
  ];
  if (after.isDraft !== undefined && after.isDraft !== null) {
    // 报的是**方向**而不是字面值：isDraft=true 在转 ready 那边是「没生效」，在 undo 这边是「成了」。
    const ok = undo ? after.isDraft === true : after.isDraft === false;
    out.push(
      "GitHub 回报的 isDraft：" + String(after.isDraft === true) +
        "（" + (ok ? "与目标状态一致" : "与目标状态不一致——请用 githana_pr(action=\"view\") 核对") + "）",
    );
  }
  if (after.url) out.push("URL：" + String(after.url));
  else if (pr.html_url) out.push("URL：" + pr.html_url);
  if (!undo) out.push("说明：转 ready 后 PR 会通知审查者并参与合并判断；要再转回草稿用 githana_pr(action=\"ready\", undo=true)。");
  else out.push("说明：转回草稿后 PR 不能合并，也不会出现在需要审查的队列里；要再转 ready 用 githana_pr(action=\"ready\")。");
  return out.join("\n");
}
