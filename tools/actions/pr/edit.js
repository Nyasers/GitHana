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
export const summary = "改 PR 的标题 / 正文 / 目标分支 / 状态";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  title: z.string().optional().describe("可选：新的 PR 标题"),
  body: z.string().optional().describe("可选：新的 PR 正文（支持 Markdown 与中文；传空串即清空正文）"),
  base: z.string().optional().describe("可选：新的目标分支（改这个会把 PR 转向另一个分支，GitHub 会重算可合并性）"),
  state: z.enum(["open", "closed"]).optional().describe("可选：open（重开）/ closed（关闭）；与 close / reopen 等价"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "修改 GitHub 远端 PR 的标题 / 正文 / 目标分支 / 状态：会改写 PR 在 GitHub 上的内容（改 base 会重算可合并性），执行前请确认 repo、prNumber 与要改的字段",
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
    if (!v) return label + " 参数错误：title 不能为空串（要清空标题请到网页操作；GitHub 不允许空标题）。";
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
    if (!v) return label + " 参数错误：base 不能为空串。请给出目标分支名（如 main）。";
    patch.base = v;
    changed.push("base=" + v);
  }
  if (input?.state !== undefined && input?.state !== null) {
    patch.state = String(input.state);
    changed.push("state=" + String(input.state));
  }

  if (changed.length === 0) {
    return (
      label + " 参数错误：至少要给一个要改的字段（title / body / base / state）。\n" +
      "只改状态可以用 githana_pr(action=\"close\") 或 githana_pr(action=\"reopen\")。"
    );
  }

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/pulls/" + numStr), json: patch, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次修改（422）。常见原因：base 分支不存在、或改动与 PR 当前状态冲突。\n" +
        "GitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已执行（PR #" + numStr + " · " + repoLabel + "）：",
    "改动：" + changed.join(" · "),
    "现标题：" + (pr.title || "（无标题）"),
    "状态：" + prStateText(pr) + " · 分支：" + ((pr.head && pr.head.ref) || "?") + " → " + ((pr.base && pr.base.ref) || "?"),
  ];
  if (pr.html_url) out.push("URL：" + pr.html_url);
  return out.join("\n");
}
