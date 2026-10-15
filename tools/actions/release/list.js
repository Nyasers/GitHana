// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/list：列出发布（githana_release 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/releases?per_page=`，支撑权限 `contents`（D7 里授权到 write 档；
 * release 全组都靠它，读也在同一条上）。
 *
 * **默认不含草稿**：`GET /releases` 不带 `draft` 参数时**草稿也会返回**（草稿是「未发布」而不是
 * 「不可见」），与人的直觉相反。所以本动词在本地按 `draft` 过滤：默认只报已发布的，
 * `includeDrafts=true` 才连草稿一起列。这不是为了少发请求，是为了让「列发布」的输出与词义一致。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { releaseLine } from "../../lib/release.js";

export const command = "list";
export const summary = "List releases (drafts excluded by default)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  limit: z.number().int().min(1).optional().describe("Number of results, default 20, max 100 (values above the max are clamped to 100)"),
  includeDrafts: z.boolean().optional().describe("Optional: list drafts as well (the endpoint returns drafts by default; this verb filters them out by default)"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("Number of results, default 20, max 100 (values above the max are clamped to 100)"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  let limit = 20;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);
  const includeDrafts = input?.includeDrafts === true;

  const r = await callRest(
    [{ url: apiUrl(repo, "/releases") + "?per_page=" + String(limit), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const raw = Array.isArray(res.json) ? res.json : [];
  const items = includeDrafts ? raw : raw.filter((it) => !(it && it.draft));
  const dropped = raw.length - items.length;

  const scope = repoLabel + (includeDrafts ? " · including drafts" : " · excluding drafts");
  if (items.length === 0) {
    return (
      label + " (" + scope + "): no matching releases." +
      (dropped > 0 ? "\n(the " + dropped + " items the endpoint returned are all drafts and were filtered out by the default convention; pass includeDrafts=true to see them too.)" : "")
    );
  }

  const out = [label + " (" + scope + " · " + items.length + " · newest first):"];
  for (const it of items) out.push(releaseLine(it));
  if (dropped > 0) out.push("(" + dropped + " more drafts were filtered out by the default convention; pass includeDrafts=true to see them too.)");
  return out.join("\n");
}
