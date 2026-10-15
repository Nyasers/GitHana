// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/edit：改 issue 的标题 / 正文 / 标签 / 指派 / 里程碑（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}`（支撑权限 `issues: write`），标签另有
 * `POST|DELETE /issues/{n}/labels`。参数按**改哪个字段**分成三组，各自语义不同，不混：
 *
 *   · `title` / `body` / `milestone` → 直接改（milestone 传 null 清空不了，要用 0——
 *     0 是 GitHub 的「无里程碑」约定值）；
 *   · `labels` → **整体替换**标签集；
 *   · `addLabels` / `removeLabels` → 增删（与 `labels` 互斥：同时给会让「最终标签集是什么」
 *     有两种算法，只认一种，另一种当场拒）。
 *
 * 状态（open / closed）不在本动词上：那是 close / reopen 两个动词的事，分着放比「一个字段
 * 兼职两种语义」更好读。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage, labelText, assigneeText, issueStateText } from "../../lib/issue.js";

export const command = "edit";
export const summary = "Edit an issue's title / body / labels / assignees / milestone";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  title: z.string().optional().describe("Optional: new title (cannot be an empty string)"),
  body: z.string().optional().describe("Optional: new body (supports Markdown; pass an empty string to clear the body)"),
  labels: z.array(z.string()).optional().describe("Optional: **replace the whole** label set (pass an empty array = clear all labels)"),
  addLabels: z.array(z.string()).optional().describe("Optional: only add these labels (mutually exclusive with labels)"),
  removeLabels: z.array(z.string()).optional().describe("Optional: only remove these labels (mutually exclusive with labels)"),
  assignees: z.array(z.string()).optional().describe("Optional: **replace the whole** assignee set (login names, without @; pass an empty array = clear all assignees)"),
  milestone: z.number().int().min(1).optional().describe("Optional: milestone number (positive integer); to clear the milestone pass clearMilestone=true"),
  clearMilestone: z.boolean().optional().describe("Optional: true clears the milestone (GitHub's convention value is milestone=0; this boolean fills it in for you)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Modify the title / body / labels / assignees / milestone of a remote GitHub issue (changing assignees and labels notifies the people involved): rewrites the issue's content on GitHub, confirm the number and the fields to change before running",
  ruleId: "github-toolkit-issue-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const hasLabels = Array.isArray(input?.labels);
  const hasAdd = Array.isArray(input?.addLabels) && input.addLabels.length > 0;
  const hasRemove = Array.isArray(input?.removeLabels) && input.removeLabels.length > 0;
  if (hasLabels && (hasAdd || hasRemove)) {
    return (
      label + " argument error: labels (whole-set replacement) and addLabels / removeLabels (incremental) cannot be given together.\n" +
      "The final label set can only have one algorithm: either give labels to define the full set, or give the adds/removes and let GitHub compute it."
    );
  }

  const patch = {};
  const changed = [];
  if (input?.title !== undefined && input?.title !== null) {
    const v = String(input.title).trim();
    if (!v) return label + " argument error: title cannot be an empty string (issue titles may not be empty).";
    patch.title = v;
    changed.push("title");
  }
  if (input?.body !== undefined && input?.body !== null) {
    // body 允许空串——那是"清空正文"，是明确意图，不是缺省。
    patch.body = String(input.body);
    changed.push("body");
  }
  if (Array.isArray(input?.assignees)) {
    patch.assignees = input.assignees.map((x) => String(x));
    changed.push("assignees (whole-set replacement: " + (patch.assignees.length ? patch.assignees.map((a) => "@" + a).join(" · ") : "cleared") + ")");
  }
  if (input?.clearMilestone === true) {
    // GitHub 的「无里程碑」约定值是 0（传 null 不生效）。
    patch.milestone = 0;
    changed.push("milestone (cleared)");
  } else if (input?.milestone !== undefined && input?.milestone !== null) {
    patch.milestone = input.milestone;
    changed.push("milestone=" + input.milestone);
  }
  if (hasLabels) {
    patch.labels = input.labels.map((x) => String(x));
    changed.push("labels (whole-set replacement: " + (patch.labels.length ? patch.labels.join(" · ") : "cleared") + ")");
  }

  if (changed.length === 0 && !hasAdd && !hasRemove) {
    return (
      label + " argument error: at least one field to change is required (title / body / labels / addLabels / removeLabels / assignees / milestone).\n" +
      "To change the state use githana_issue(action=\"close\") or githana_issue(action=\"reopen\")."
    );
  }

  // 先核对这个编号确实是 issue（不是 PR）：issue 与 PR 的编辑走不同动词（PR 在 githana_pr）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "To edit this PR use githana_pr(action=\"edit\", prNumber=" + numStr + ").",
    );
  }

  const batch = [];
  if (Object.keys(patch).length) {
    batch.push({ id: "patch", method: "PATCH", url: apiUrl(repo, "/issues/" + numStr), json: patch, timeoutMs });
  }
  if (hasAdd) {
    batch.push({
      id: "add",
      method: "POST",
      url: apiUrl(repo, "/issues/" + numStr + "/labels"),
      json: { labels: input.addLabels.map((x) => String(x)) },
      timeoutMs,
    });
  }
  // 删标签要**逐个**删：`DELETE /issues/{n}/labels`（集合形态）是"摘掉全部标签"，
  // 传 body 指定名单不会生效——那是两个不同的端点，混用会静默地把标签全清掉。
  if (hasRemove) {
    input.removeLabels.forEach((raw, i) => {
      batch.push({
        id: "remove:" + i,
        method: "DELETE",
        url: apiUrl(repo, "/issues/" + numStr + "/labels/" + encodeURIComponent(String(raw))),
        timeoutMs,
      });
    });
  }

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " execution failed: " + r.message;

  const patched = r.results.find((x) => x.id === "patch");
  const added = r.results.find((x) => x.id === "add");
  const removeResults = r.results.filter((x) => String(x.id).startsWith("remove:"));
  const failed = [patched, added, ...removeResults].find((x) => x && !x.ok);
  if (failed) {
    if (failed.status === 422) {
      return (
        label + " execution failed: GitHub rejected this edit (422). Common causes: a label name does not exist, an assignee is not a collaborator,\n" +
        "or the milestone number does not exist.\nGitHub raw message: " + errorDetail(failed)
      );
    }
    return label + " execution failed: " + describeFailure(failed, repoLabel);
  }
  if (added) changed.push("labels added: " + input.addLabels.join(" · "));
  if (removeResults.length) changed.push("labels removed: " + input.removeLabels.join(" · "));

  // 终态**再读一次**：增删标签那条请求不回 issue 本体，而 PATCH 的响应是在增删之前拿到的，
  // 拿它报"现标签"会漏掉这次加/删的结果（回执与实际不符比不报更糟）。
  const afterRes = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  const after = afterRes.error ? cur.issue : afterRes.issue;
  const out = [
    label + " done (issue #" + numStr + " · " + repoLabel + "):",
    "changes: " + changed.join(" · "),
    "current title: " + (after.title || "(untitled)") + " · state: " + issueStateText(after),
    "current labels: " + (labelText(after) || "(none)"),
    "current assignees: " + (assigneeText(after) || "(none)"),
  ];
  if (afterRes.error) out.push("(final-state re-read failed; the lines above are the pre-edit snapshot: " + afterRes.error.trim() + ")");
  if (after.html_url) out.push("URL: " + after.html_url);
  return out.join("\n");
}
