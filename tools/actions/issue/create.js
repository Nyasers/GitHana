// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/create：新建 issue（githana_issue 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/issues`（支撑权限 `issues: write`）。labels / assignees 直接带上，
 * 一次请求完成（与 gh `issue create --label/--assignee` 同）。
 *
 * 走 REST 而不是 GraphQL 的理由与 `pr create` 一致：REST 写 `performed_via_github_app`，
 * 那是 App 角标的来源。创建后单独查一次 issue 表示并**如实回报**归因结果（查不到就说未确认）。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";

export const command = "create";
export const summary = "新建 issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  title: z.string().describe("issue 标题（必填）"),
  body: z.string().optional().describe("可选：issue 正文（支持 Markdown 与中文）"),
  labels: z.array(z.string()).optional().describe("可选：标签名数组（标签不存在时 GitHub 会 422）"),
  assignees: z.array(z.string()).optional().describe("可选：指派人的登录名数组（不带 @）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "在 GitHub 远端新建一个 issue（可能同时打标签、指派给他人并触发通知）：修改 GitHub 远端状态且会通知相关人，执行前请确认 repo、标题与正文",
  ruleId: "github-toolkit-issue-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) return label + " 参数错误：title 必填（issue 标题不能为空）。";

  const payload = { title };
  if (input?.body !== undefined && input?.body !== null && String(input.body).trim() !== "") {
    payload.body = String(input.body);
  }
  if (Array.isArray(input?.labels) && input.labels.length) payload.labels = input.labels.map((x) => String(x));
  if (Array.isArray(input?.assignees) && input.assignees.length) payload.assignees = input.assignees.map((x) => String(x));

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest([{ method: "POST", url: apiUrl(repo, "/issues"), json: payload, timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次创建（422）。常见原因：标签名不存在、被指派人无权被指派\n" +
        "（或不是协作者）、仓库禁用了 issue。\nGitHub 原文：" + errorDetail(res)
      );
    }
    if (res && res.status === 410) {
      return label + " 执行失败：仓库 " + repoLabel + " 的 issue 功能已关闭（410 Gone）。";
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const issue = res.json && typeof res.json === "object" ? res.json : {};
  const number = issue.number !== undefined && issue.number !== null ? String(issue.number) : "?";

  // 归因：查 issue 表示（角标读的那一层）。查不到就如实说未确认，不假装。
  let appSlug = "";
  let attributionChecked = false;
  if (issue.number !== undefined && issue.number !== null) {
    const ar = await callRest(
      [{ url: apiUrl(repo, "/issues/" + number), timeoutMs }],
      { timeoutSec },
    );
    const ares = ar.ok ? ar.results[0] : null;
    if (ares && ares.ok && ares.json) {
      attributionChecked = true;
      const app = ares.json.performed_via_github_app;
      if (app && app.slug) appSlug = String(app.slug);
    }
  }

  const out = [label + " 完成：", "issue #" + number + "：「" + title + "」（" + repoLabel + "）"];
  if (issue.html_url) out.push("URL：" + issue.html_url);
  if (payload.labels) out.push("标签：" + payload.labels.join(" · "));
  if (payload.assignees) out.push("指派：" + payload.assignees.map((a) => "@" + a).join(" · "));
  out.push("状态：" + String(issue.state || "open").toUpperCase());
  out.push(
    appSlug
      ? "App 归因：performed_via_github_app = " + appSlug + "（issue 页会显示 App 角标）"
      : attributionChecked
        ? "App 归因：issue 表示里 performed_via_github_app 为空（角标不显示；通常是令牌不是 GitHub App 的 user access token）"
        : "App 归因：未能核对（查询 issue 表示失败，不影响 issue 已创建）",
  );
  return out.join("\n");
}
