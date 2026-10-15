// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/edit：改 PR 的标题 / 正文 / 目标分支 / 状态（githana_pr 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/pulls/{n}`（支撑权限 `pull_requests: write`）。可改的四个字段：
 *   · `title` / `body`——标题与正文；
 *   · `base`——**目标分支**（改这个等于把 PR 转向另一个分支；GitHub 会重算可合并性）；
 *   · `state`——open / closed（与 close / reopen 两个动词是同一件事，这里只为一次调用改多处）。
 *
 * `maintainerCanModify`（允许维护者推送到源分支）也在这个端点上，但它对 fork PR 才有效，
 * 这里不开这个口子——需要时走 githana_api。
 *
 * 至少要有改动项：一个字段都没给就返回引导，不发一次注定 422 的请求（GitHub 拒空 PATCH）。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure, prStateText } from "../../lib/pr.js";

export const command = "edit";
export const summary = "Edit a PR's title / body / base branch / state";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  title: z.string().optional().describe("Optional: new PR title"),
  body: z.string().optional().describe("Optional: new PR body (supports Markdown and Chinese; pass an empty string to clear the body)"),
  base: z.string().optional().describe("Optional: new target branch (changing this redirects the PR to another branch; GitHub recomputes mergeability)"),
  state: z.enum(["open", "closed"]).optional().describe("Optional: open (reopen) / closed (close); equivalent to close / reopen"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Modify a remote GitHub PR's title / body / base branch / state: rewrites the PR's content on GitHub (changing base recomputes mergeability), confirm repo, prNumber and the fields to change before running",
  ruleId: "github-toolkit-pr-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const patch = {};
  const changed = [];
  if (input?.title !== undefined && input?.title !== null) {
    const v = String(input.title).trim();
    if (!v) return label + " argument error: title cannot be an empty string (to clear the title do it on the web; GitHub does not allow an empty title).";
    patch.title = v;
    changed.push("title");
  }
  if (input?.body !== undefined && input?.body !== null) {
    // body 允许空串——那是"清空正文"，是明确意图，不是缺省。
    patch.body = String(input.body);
    changed.push("body");
  }
  if (input?.base !== undefined && input?.base !== null) {
    const v = String(input.base).trim();
    if (!v) return label + " argument error: base cannot be an empty string. Give the target branch name (e.g. main).";
    patch.base = v;
    changed.push("base=" + v);
  }
  if (input?.state !== undefined && input?.state !== null) {
    patch.state = String(input.state);
    changed.push("state=" + String(input.state));
  }

  if (changed.length === 0) {
    return (
      label + " argument error: at least one field to change is required (title / body / base / state).\n" +
      "To change only the state you can use githana_pr(action=\"close\") or githana_pr(action=\"reopen\")."
    );
  }

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/pulls/" + numStr), json: patch, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": PR #" + numStr + " does not exist or is not visible (" + repoLabel + ").";
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this edit (422). Common causes: the base branch does not exist, or the change conflicts with the PR's current state.\n" +
        "GitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " done (PR #" + numStr + " · " + repoLabel + "):",
    "changes: " + changed.join(" · "),
    "current title: " + (pr.title || "(untitled)"),
    "state: " + prStateText(pr) + " · branch: " + ((pr.head && pr.head.ref) || "?") + " → " + ((pr.base && pr.base.ref) || "?"),
  ];
  if (pr.html_url) out.push("URL: " + pr.html_url);
  return out.join("\n");
}
