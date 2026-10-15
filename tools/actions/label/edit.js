// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/edit：改标签的名字 / 颜色 / 描述（githana_label 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/labels/{name}`（支撑权限 `issues: write`）。
 *
 * **改名要显式传 newName**：改名与"改原名下的颜色"是两件事，但端点用同一个 PATCH——
 * 如果只把 `name` 当"新名字"用，那么"我想改 bug 的颜色"就会变成"把 bug 改成别的名字"。
 * 所以这里 `name` 只作**定位**（要改哪个标签），新名字走 `newName`。gh `label edit` 的
 * `<name>` 与 `--name` 是同一个区分。
 *
 * 没给任何要改的字段就返回引导，不发一次注定 422 的请求。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { labelLine } from "../../lib/label.js";

export const command = "edit";
export const summary = "Edit a label's name / color / description";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("The **existing** label name to edit (used for locating; to rename, also pass newName)"),
  newName: z.string().optional().describe("Optional: new name (used when renaming; if omitted the name is unchanged)"),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Optional: new six-digit hexadecimal color, an optional leading # is allowed (e.g. 0e8a16)"),
  description: z.string().optional().describe("Optional: new description (pass an empty string to clear the description)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Modify the name / color / description of a label in a remote GitHub repository (renaming renames it on every issue / PR carrying it): rewrites the repository's label surface, confirm repo, existing name and the fields to change before running",
  ruleId: "github-toolkit-label-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " argument error: name is required (the existing label name to edit).";

  const patch = {};
  const changed = [];
  if (input?.newName !== undefined && input?.newName !== null) {
    const v = String(input.newName).trim();
    if (!v) return label + " argument error: newName cannot be an empty string (label names may not be empty).";
    patch.new_name = v;
    changed.push("name → " + v);
  }
  if (input?.color !== undefined && input?.color !== null) {
    // 六位十六进制由 schema 的 regex 保证；这里只归一成 GitHub 的形态（不带 #、小写）。
    const v = String(input.color).trim().replace(/^#/, "").toLowerCase();
    patch.color = v;
    changed.push("color → #" + v);
  }
  if (input?.description !== undefined && input?.description !== null) {
    // 描述允许空串——那是"清空描述"，是明确意图。
    patch.description = String(input.description);
    changed.push("description → " + (String(input.description) === "" ? "(cleared)" : String(input.description)));
  }

  if (changed.length === 0) {
    return (
      label + " argument error: at least one field to change is required (newName / color / description).\n" +
      "Passing only name just locates that label and does not constitute a change on its own (GitHub rejects an empty PATCH)."
    );
  }

  const r = await callRest(
    [
      {
        method: "PATCH",
        url: apiUrl(repo, "/labels/" + encodeURIComponent(name)),
        json: patch,
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + ": repository " + repoLabel + " has no label named " + name + ".";
    if (res && res.status === 422) {
      return label + " execution failed: GitHub rejected this edit (422). Common cause: newName is already taken by another label.\nGitHub raw message: " + errorDetail(res);
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const after = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " done (" + repoLabel + "):",
    "located label: " + name,
    "changes: " + changed.join(" · "),
    "current label: " + labelLine(after).trim(),
  ];
  if (patch.new_name) out.push("note: renaming renames it on every issue / PR carrying the label.");
  return out.join("\n");
}
