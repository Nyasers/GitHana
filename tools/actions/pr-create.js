// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr_create：创建 PR（写面 action）。
 *
 * base?（缺省取仓库默认分支）、title?（缺省取 cwd 内 HEAD commit 首行；cwd 与 title 均缺 → 引导）、
 * body?、draft?；head 取 cwd 的当前分支（REST 必填）。输出新建 PR 的 URL 与编号。
 *
 * 走 REST `POST /repos/{o}/{r}/pulls`——**这是 App 角标的来源**：GraphQL 的 createPullRequest
 * 不写 `performed_via_github_app`，REST 写。归因字段只在 **issue 表示**上（`GET /issues/{n}`），
 * `POST /pulls` 与 `GET /pulls/{n}` 的响应体都不带它，所以创建完成后单独查一次，如实回报
 * （没确认也说明白了，不假装）。
 */
import { z } from "zod";
import { runCli } from "../lib/exec.js";
import * as params from "../lib/params.js";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../lib/rest.js";
import { resolveContext, describeFailure, defaultBranch, currentBranch } from "../lib/pr.js";

export const command = "pr_create";
export const summary = "创建 PR";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  base: z.string().optional().describe("目标分支（缺省取仓库默认分支，如 main）"),
  title: z.string().optional().describe("PR 标题（缺省取 cwd 内 HEAD commit 首行；cwd 与 title 均缺则返回引导）"),
  body: z.string().optional().describe("PR 正文（可选，支持 Markdown 与中文）"),
  draft: z.boolean().optional().describe("以草稿（draft）创建 PR"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "在 GitHub 远端创建 Pull Request（自写 REST 通道，分支须已推送到远端）：修改 GitHub 远端状态，执行前请确认 repo、head/base 分支与标题",
  ruleId: "github-toolkit-pr-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, cwd, timeoutSec } = c;

  let title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) {
    if (!cwd) {
      return label + " 参数错误：title 缺省需要 cwd（取当前分支 HEAD commit 首行），但未传 cwd。请传 title 或 cwd。";
    }
    const headR = await runCli("git", ["log", "-1", "--format=%s"], { cwd, timeoutSec: 30 });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet/i.test(raw)) {
        return label + " 无法推导 title：cwd 仓库尚无提交（HEAD 不存在）。请显式传 title。";
      }
      if (/not a git repository/i.test(raw)) {
        return label + "：cwd 不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请传仓库 cwd 或显式 title+repo。";
      }
      return label + " 读取 HEAD title 失败：" + (raw || headR.message);
    }
    title = headR.stdout.trim();
    if (!title) {
      return label + " 无法推导 title：HEAD commit 无首行内容，请显式传 title。";
    }
  }

  // head：REST 必填，取 cwd 当前分支。
  let head = "";
  if (cwd) {
    const cur = await currentBranch(cwd);
    if (cur.error) return label + " 无法确定源分支：" + cur.error;
    head = cur.branch;
  } else {
    return (
      label + " 参数错误：缺少 cwd，无法确定要提交哪个分支（REST 创建 PR 必须显式给出源分支）。\n" +
      "请传 cwd（在目标分支所在仓库内），或在 git 仓库 cwd 内执行。"
    );
  }

  // base：缺省取仓库默认分支。
  let base = input?.base !== undefined && input?.base !== null ? String(input.base).trim() : "";
  if (!base) {
    const db = await defaultBranch(repo, timeoutSec);
    if (db.error) return label + " 无法确定目标分支：" + db.error;
    base = db.branch;
  }

  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";
  const payload = { title, head, base };
  if (body.trim()) payload.body = body;
  if (input?.draft === true) payload.draft = true;

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/pulls"), json: payload, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    // 分支未推送是这条路上最常见的失败，单独给引导（REST 不做 gh 的自动推分支）。
    const detail = errorDetail(res);
    const notPushed =
      res && res.status === 422 && /"field"\s*:\s*"head"|head.*invalid|No commits between/i.test(JSON.stringify(res.json || ""));
    if (notPushed) {
      return (
        label + " 执行失败：源分支 " + head + " 在远端不存在或没有新提交。\n" +
        "REST 创建 PR 要求分支已推送到远端（本 action 不做自动推送）：请先 githana(action=\"push\") 该分支，再重试。\n" +
        "GitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel) +
      (res && res.status === 422 ? "\n（422 常见原因：分支未推送、base 分支不存在、或同分支已有打开的 PR）" : "");
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const number = pr.number !== undefined && pr.number !== null ? String(pr.number) : "?";
  const url = pr.html_url ? String(pr.html_url) : "";

  // 归因：查 issue 表示（角标读的那一层）。查不到就如实说未确认，不假装。
  let appSlug = "";
  let attributionChecked = false;
  if (pr.number !== undefined && pr.number !== null) {
    const ar = await callRest(
      [{ url: apiUrl(repo, "/issues/" + String(pr.number)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
      { timeoutSec },
    );
    const ares = ar.ok ? ar.results[0] : null;
    if (ares && ares.ok && ares.json) {
      attributionChecked = true;
      const app = ares.json.performed_via_github_app;
      if (app && app.slug) appSlug = String(app.slug);
    }
  }

  const lines = [label + " 完成："];
  if (url) {
    lines.push("PR URL：" + url);
    lines.push("PR 编号：#" + number);
  } else {
    lines.push("（响应里没有 html_url——见下方原始输出）");
    lines.push(String(res.text || "").slice(0, 800));
  }
  lines.push("标题：" + title);
  lines.push("分支：" + head + " → " + base + "（" + repoLabel + "）");
  if (body.trim()) lines.push("body 长度：" + body.length + " 字符");
  if (input?.draft === true) lines.push("草稿：是");
  // 角标归因：如实回报（没确认也说明白了，不假装）。
  lines.push(
    appSlug
      ? "App 归因：performed_via_github_app = " + appSlug + "（PR 页会显示 App 角标）"
      : attributionChecked
        ? "App 归因：issue 表示里 performed_via_github_app 为空（角标不显示；通常是令牌不是 GitHub App 的 user access token）"
        : "App 归因：未能核对（查询 issue 表示失败，不影响 PR 已创建）",
  );
  return lines.join("\n");
}
