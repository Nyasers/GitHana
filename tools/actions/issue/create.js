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
export const summary = "Create an issue";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  title: z.string().describe("Issue title (required)"),
  body: z.string().optional().describe("Optional: issue body (supports Markdown and Chinese)"),
  labels: z.array(z.string()).optional().describe("Optional: array of label names (GitHub returns 422 if a label does not exist)"),
  assignees: z.array(z.string()).optional().describe("Optional: array of assignee login names (without @)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Create a new issue on remote GitHub (may also apply labels, assign others and trigger notifications): modifies remote GitHub state and notifies the people involved, confirm repo, title and body before running",
  ruleId: "github-toolkit-issue-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) return label + " argument error: title is required (the issue title cannot be empty).";

  const payload = { title };
  if (input?.body !== undefined && input?.body !== null && String(input.body).trim() !== "") {
    payload.body = String(input.body);
  }
  if (Array.isArray(input?.labels) && input.labels.length) payload.labels = input.labels.map((x) => String(x));
  if (Array.isArray(input?.assignees) && input.assignees.length) payload.assignees = input.assignees.map((x) => String(x));

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest([{ method: "POST", url: apiUrl(repo, "/issues"), json: payload, timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this creation (422). Common causes: a label name does not exist, an assignee cannot be assigned\n" +
        "(or is not a collaborator), or the repository has issues disabled.\nGitHub raw message: " + errorDetail(res)
      );
    }
    if (res && res.status === 410) {
      return label + " execution failed: issues are disabled for the repository " + repoLabel + " (410 Gone).";
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
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

  const out = [label + " done:", "issue #" + number + ": \"" + title + "\" (" + repoLabel + ")"];
  if (issue.html_url) out.push("URL: " + issue.html_url);
  if (payload.labels) out.push("labels: " + payload.labels.join(" · "));
  if (payload.assignees) out.push("assignees: " + payload.assignees.map((a) => "@" + a).join(" · "));
  out.push("state: " + String(issue.state || "open").toUpperCase());
  out.push(
    appSlug
      ? "App attribution: performed_via_github_app = " + appSlug + " (the issue page will show the App badge)"
      : attributionChecked
        ? "App attribution: performed_via_github_app is empty in the issue representation (no badge shown; usually because the token is not a GitHub App user access token)"
        : "App attribution: could not be verified (fetching the issue representation failed; the issue was still created)",
  );
  return out.join("\n");
}
