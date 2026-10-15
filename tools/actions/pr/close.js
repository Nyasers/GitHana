// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/close：关闭 PR（githana_pr 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/pulls/{n}` 带 `{ state: "closed" }`（支撑权限 `pull_requests: write`）。
 * 已合并的 PR 不能再关（GitHub 会拒）；已关闭的再关一次是幂等的，本动词如实回报「本来就是关闭态」。
 *
 * 关闭**不删**任何东西：分支、提交、评论都留着，可以 reopen 回来。这一点与 `merge` 不同
 * （合并不可撤销、且会改默认分支上的历史），所以两者是同级的独立动词。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText } from "../../lib/pr.js";

export const command = "close";
export const summary = "关闭 PR（可用 reopen 还原）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "关闭 GitHub 远端 PR（state=closed；不删除分支与历史，可用 reopen 还原）：修改 GitHub 远端状态，执行前请确认 repo 与 prNumber",
  ruleId: "github-toolkit-pr-close",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/pulls/" + numStr), json: { state: "closed" }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (res && res.status === 422) {
      return label + " 执行失败：无法关闭 PR #" + numStr + "（422）。已合并的 PR 不能再关闭。\nGitHub 原文：" + errorDetail(res);
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已执行（PR #" + numStr + " · " + repoLabel + "）：",
    "状态：" + prStateText(pr),
    "说明：关闭不删分支与历史；要还原用 githana_pr(action=\"reopen\")。",
  ];
  if (pr.html_url) out.push("URL：" + pr.html_url);
  return out.join("\n");
}
