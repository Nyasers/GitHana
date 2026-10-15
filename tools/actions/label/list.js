// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/list：列出仓库的标签（githana_label 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/labels`（支撑权限 `issues: write`，标签与 issue 同一条）。
 * 输出名 / 颜色 / 描述——描述在 issue 页面上悬停可见，是标签的"什么时候该用它"那半句话。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { labelLine } from "../../lib/label.js";

export const command = "list";
export const summary = "List repository labels";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  limit: z.number().int().min(1).optional().describe("Number of results, default 50, max 100 (values above the max are clamped to 100)"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("Number of results, default 50, max 100 (values above the max are clamped to 100)"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  let limit = 50;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);

  const r = await callRest(
    [
      {
        url: apiUrl(repo, "/labels") + "?per_page=" + String(limit),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) return label + " (" + repoLabel + "): the repository has no labels yet.";
  const out = [label + " (" + repoLabel + " · " + items.length + "):"];
  for (const it of items) out.push(labelLine(it));
  out.push("note: to edit one use githana_label(action=\"edit\"), to delete one use githana_label(action=\"delete\");");
  out.push("to copy a whole set from another repository use githana_label(action=\"clone\").");
  return out.join("\n");
}
