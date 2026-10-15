// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * cache/list：列仓库的 Actions 缓存（githana_cache 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/caches`，支撑权限 `actions: write`（D7 已授权——
 * cache 与 run / workflow 同一条权限，所以它也是一个独立名词工具，只读的 list 也要过审）。
 *
 * ## 缓存是「按 key 的桶」，不是「一个 key 一份」
 *
 * GitHub 的缓存 key 是写入时算出来的那个串，但同一个逻辑 key 在不同分支 / 不同时间会留下
 * **多条**（每条有自己的 `id`、`ref`、`created_at`、`last_accessed_at`、`size_in_bytes`）。
 * 所以「清掉某个 key」通常不是删一条，而是删一族（见 delete 的 `key` 参数与它的说明）。
 *
 * `key` 这个查询参数按 GitHub 文档是「an explicit key **or prefix**」——即它可能做前缀匹配，
 * 于是传一个 key 可能回多条**不同**的 key。这一点不在本地二次收紧：回执里逐条打出完整的 key，
 * 调用方自己核对拿到的是不是自己要的那一族（本地再判一遍只会与 GitHub 的判断不一致）。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { formatBytes } from "../../lib/ci.js";

export const command = "list";
export const summary = "List Actions caches (filterable by key / ref)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  key: z.string().optional().describe("Optional: filter by cache key (GitHub's docs say this parameter is \"key or key prefix\", so it may return several different keys)"),
  ref: z.string().optional().describe("Optional: filter by branch / ref (a full Git ref or a branch name, e.g. refs/heads/main or main)"),
  sort: z.enum(["created_at", "last_accessed_at", "size_in_bytes"]).optional().describe("Optional: sort field, defaults to last_accessed_at"),
  direction: z.enum(["asc", "desc"]).optional().describe("Optional: sort direction, defaults to desc"),
  limit: z.number().int().min(1).optional().describe("Number of results, default 30, max 100 (values above the max are clamped to 100)"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("Number of results, default 30, max 100 (values above the max are clamped to 100)"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  let limit = 30;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);

  const query = ["per_page=" + String(limit)];
  const pushIf = (k, v) => {
    if (v !== undefined && v !== null && String(v).trim() !== "") query.push(k + "=" + encodeURIComponent(String(v).trim()));
  };
  pushIf("key", input?.key);
  pushIf("ref", input?.ref);
  // 排序缺省值与端点一致（last_accessed_at / desc）；显式传才拼上去。
  if (input?.sort !== undefined && input?.sort !== null) pushIf("sort", input.sort);
  if (input?.direction !== undefined && input?.direction !== null) pushIf("direction", input.direction);

  const r = await callRest(
    [{ url: apiUrl(repo, "/actions/caches") + "?" + query.join("&"), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, repoLabel);

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const items = Array.isArray(body.actions_caches) ? body.actions_caches : [];
  const scope =
    repoLabel +
    (input?.key ? " · key=" + String(input.key) : "") +
    (input?.ref ? " · ref=" + String(input.ref) : "");

  if (items.length === 0) {
    return (
      label + " (" + scope + "): no matching caches." +
      (input?.key ? "\nnote: per GitHub's docs the key parameter is \"key or key prefix\"; if you are sure that key exists, double-check the full key computed at write time." : "")
    );
  }

  const total = items.reduce((sum, it) => sum + (Number(it && it.size_in_bytes) || 0), 0);
  const out = [
    label + " (" + scope + " · " + items.length +
      (body.total_count !== undefined ? " / " + body.total_count + " total" : "") +
      " · " + formatBytes(total) + " total):",
  ];
  for (const it of items) {
    out.push(
      "  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) +
      "  " + (it.ref || "?"),
    );
    out.push("      key: " + (it.key || "?"));
    out.push(
      "      created " + fmtTime(it.created_at) +
      (it.last_accessed_at ? " · last used " + fmtTime(it.last_accessed_at) : ""),
    );
  }
  out.push("note: to clear a key use githana_cache(action=\"delete\", key=\"<the key above>\"); to delete a single entry by id use id=<the id above>.");
  return out.join("\n");
}
