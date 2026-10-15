// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/license：列出 GitHub 提供的许可证模板（githana_repo 动词）。
 *
 * 走 REST `GET /licenses`（账号级端点，支撑权限 `metadata: read`）。这是 gh
 * `repo create --license` 的**查名动词**：端点的 `key`（如 mit / apache-2.0）才是建仓库时
 * 要传的值，`name` 是显示名。默认只报 key/name/spdx_id 三列，省 token；
 * `full=true` 才打完整响应（含正文与各字段的说明链接）。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiRoot, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { requireAuth, describeFailure } from "../../lib/gh.js";

export const command = "license";
export const summary = "List license templates (the key is used for create's license parameter)";

export const schema = {
  full: z
    .boolean()
    .optional()
    .describe("Optional: true returns the full response (including per-field descriptions and the body); by default only the columns key / name / SPDX ID are listed"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const authErr = requireAuth(label);
  if (authErr) return authErr;

  const timeoutSec = input?.timeoutSec;
  const r = await callRest(
    [{ url: apiRoot("/licenses"), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, "");

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) return label + ": GitHub returned an empty license list (abnormal; please retry later).";

  if (input?.full === true) {
    const text = JSON.stringify(items, null, 2);
    const MAX = 20000;
    return [
      label + " (full response · " + items.length + " items):",
      text.length > MAX ? text.slice(0, MAX) + "\n…(truncated, " + text.length + " chars total)" : text,
    ].join("\n");
  }

  const out = [label + " (licenses provided by GitHub · " + items.length + " items):"];
  for (const it of items) {
    out.push("  " + (it.key || "?") + "  ·  " + (it.name || "") + (it.spdx_id ? "  ·  " + it.spdx_id : ""));
  }
  out.push("usage: githana_repo(action=\"create\", name=\"<repository name>\", license=\"<the key in the first column above>\").");
  out.push("to see the full response (including the body): githana_repo(action=\"license\", full=true).");
  return out.join("\n");
}
