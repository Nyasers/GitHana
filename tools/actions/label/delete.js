// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/delete：删除标签（githana_label 动词，需 confirm=true）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/labels/{name}`（支撑权限 `issues: write`）。
 *
 * 「删标签」在 GitHub 上的实际效果是**从所有已打该标签的 issue / PR 上摘掉**——标签定义本身
 * 不可恢复，而那个关联关系也不会留痕。所以本动词：
 *   · 只接受 `confirm=true` 才真删（缺它就返回引导）；
 *   · 删之前先取一次该标签的**打开 issue 数**（`GET /issues?labels=<name>&state=open`，
 *     只取一页的条数），好让审批与回执里都写着"会影响多少条"。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { labelLine } from "../../lib/label.js";

export const command = "delete";
export const summary = "Delete a label (removes it from every issue carrying it)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("Name of the label to delete"),
  confirm: z.boolean().optional().describe("Must be true to actually delete: deleting a label removes it from every issue / PR carrying it; without it you get guidance instead"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "**Delete** a label in a remote GitHub repository (it is removed from every issue / PR carrying it, and the association leaves no trace): modifies remote GitHub state, confirm the repository and label name again before running",
  ruleId: "github-toolkit-label-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " argument error: name is required (the label to delete).";
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先确认标签存在，并取一次它的定义（回执里要写清删的是哪个）。
  const before = await callRest(
    [{ url: apiUrl(repo, "/labels/" + encodeURIComponent(name)), timeoutMs }],
    { timeoutSec },
  );
  if (!before.ok) return label + " execution failed: " + before.message;
  const bres = before.results[0];
  if (!bres || !bres.ok) {
    if (bres && bres.status === 404) return label + ": repository " + repoLabel + " has no label named " + name + ".";
    return label + " execution failed: " + describeFailure(bres, repoLabel);
  }
  const target = bres.json && typeof bres.json === "object" ? bres.json : {};

  // 影响面：有多少打开的 issue / PR 打着这个标签（只取一页，够说明量级）。
  let affected = null;
  const useR = await callRest(
    [
      {
        url: apiUrl(repo, "/issues") + "?state=open&labels=" + encodeURIComponent(name) + "&per_page=100",
        timeoutMs,
      },
    ],
    { timeoutSec },
  );
  if (useR.ok && useR.results[0] && useR.results[0].ok && Array.isArray(useR.results[0].json)) {
    affected = useR.results[0].json.length;
  }
  // 恰好一整页（100）时无法区分「正好 100」与「100 以上」：`/issues` 不分页，这里只看得到第一页。
  // 报成精确的 100 是把截断说成事实，所以那种情况报「≥100」。`> 100` 不可能出现（页就 100 条），
  // 但用 `>=` 表达意图更直白。
  const affectedAtLeast = affected !== null && affected >= 100;

  if (input?.confirm !== true) {
    return [
      label + " confirmation required (nothing deleted yet):",
      "Will delete label: " + labelLine(target).trim() + " (" + repoLabel + ")",
      "impact: " + (affected === null ? "not fetched (does not affect the deletion itself)" : affectedAtLeast ? "≥100 open issues / PRs currently carry it (only the first page of 100 was counted); they will all lose it" : affected + " open issues / PRs currently carry it; they will all lose it") + ".",
      "Deletion is **irreversible**: once the label definition is gone it is gone, and the associations leave no trace. To merely remove the label from one issue, use githana_issue(action=\"edit\", removeLabels=[\"" + name + "\"]) instead.",
      "To confirm, resend the same call with confirm=true.",
    ].join("\n");
  }

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/labels/" + encodeURIComponent(name)), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " execution failed: " + describeFailure(res, repoLabel);

  return [
    label + " deleted (" + repoLabel + "):",
    "label: " + labelLine(target).trim(),
    "impact: " + (affected === null ? "removed from every issue / PR carrying it (count not fetched)" : affectedAtLeast ? "removed from ≥100 open issues / PRs (the count is the first page of 100 taken before deletion; there may be more)" : "removed from " + affected + " open issues / PRs (the count is the open items before deletion)"),
    "note: deletion is irreversible; to recreate a same-named label use githana_label(action=\"create\").",
  ].join("\n");
}
