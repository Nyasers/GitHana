// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/create：创建 PR（githana_pr 动词）。
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
import { runCli } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure, defaultBranch, currentBranch } from "../../lib/pr.js";

export const command = "create";
export const summary = "Create a PR";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  base: z.string().optional().describe("Target branch (defaults to the repository default branch, e.g. main)"),
  title: z.string().optional().describe("PR title (defaults to the first line of the HEAD commit in cwd; if both cwd and title are missing, guidance is returned)"),
  body: z.string().optional().describe("PR body (optional, supports Markdown and Chinese)"),
  draft: z.boolean().optional().describe("Create the PR as a draft"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Create a Pull Request on remote GitHub (through this App's own REST channel; the branch must already be pushed to the remote): modifies remote GitHub state, confirm repo, the head/base branches and the title before running",
  ruleId: "github-toolkit-pr-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, cwd, timeoutSec } = c;

  let title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) {
    if (!cwd) {
      return label + " argument error: defaulting title requires cwd (to take the first line of the current branch's HEAD commit), but cwd was not passed. Pass title or cwd.";
    }
    const headR = await runCli("git", ["log", "-1", "--format=%s"], { cwd, timeoutSec: 30 });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet/i.test(raw)) {
        return label + " cannot derive a title: the cwd repository has no commits yet (HEAD does not exist). Pass title explicitly.";
      }
      if (/not a git repository/i.test(raw)) {
        return label + ": cwd is not a git repository (git says: " + (raw.split("\n")[0] || raw) + "). Pass the repository cwd, or pass title + repo explicitly.";
      }
      return label + " failed to read the HEAD title: " + (raw || headR.message);
    }
    title = headR.stdout.trim();
    if (!title) {
      return label + " cannot derive a title: the HEAD commit has no first-line content; pass title explicitly.";
    }
  }

  // head：REST 必填，取 cwd 当前分支。
  let head = "";
  if (cwd) {
    const cur = await currentBranch(cwd);
    if (cur.error) return label + " cannot determine the source branch: " + cur.error;
    head = cur.branch;
  } else {
    return (
      label + " argument error: cwd is missing, so it cannot be determined which branch to submit (creating a PR via REST requires the source branch explicitly).\n" +
      "Pass cwd (inside the repository holding the target branch), or run inside a git repository as cwd."
    );
  }

  // base：缺省取仓库默认分支。
  let base = input?.base !== undefined && input?.base !== null ? String(input.base).trim() : "";
  if (!base) {
    const db = await defaultBranch(repo, timeoutSec);
    if (db.error) return label + " cannot determine the target branch: " + db.error;
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
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    // 分支未推送是这条路上最常见的失败，单独给引导（REST 不做 gh 的自动推分支）。
    const detail = errorDetail(res);
    const notPushed =
      res && res.status === 422 && /"field"\s*:\s*"head"|head.*invalid|No commits between/i.test(JSON.stringify(res.json || ""));
    if (notPushed) {
      return (
        label + " execution failed: the source branch " + head + " does not exist on the remote or has no new commits.\n" +
        "Creating a PR via REST requires the branch to be pushed to the remote (this verb does not push automatically): push that branch with githana_git(action=\"push\") first, then retry.\n" +
        "GitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel) +
      (res && res.status === 422 ? "\n(common causes of 422: the branch was not pushed, the base branch does not exist, or a PR from the same branch is already open)" : "");
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

  const lines = [label + " done:"];
  if (url) {
    lines.push("PR URL: " + url);
    lines.push("PR number: #" + number);
  } else {
    lines.push("(no html_url in the response — see the raw output below)");
    lines.push(String(res.text || "").slice(0, 800));
  }
  lines.push("title: " + title);
  lines.push("branch: " + head + " → " + base + " (" + repoLabel + ")");
  if (body.trim()) lines.push("body length: " + body.length + " chars");
  if (input?.draft === true) lines.push("draft: yes");
  // 角标归因：如实回报（没确认也说明白了，不假装）。
  lines.push(
    appSlug
      ? "App attribution: performed_via_github_app = " + appSlug + " (the PR page will show the App badge)"
      : attributionChecked
        ? "App attribution: performed_via_github_app is empty in the issue representation (no badge shown; usually because the token is not a GitHub App user access token)"
        : "App attribution: could not be verified (fetching the issue representation failed; the PR was still created)",
  );
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      ok: true,
      action: "create",
      number: pr.number ?? null,
      url,
      title,
      head,
      base,
      repo: repoLabel,
      draft: input?.draft === true,
      appAttribution: appSlug || null,
    },
  };
}
