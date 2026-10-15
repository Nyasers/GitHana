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
export const summary = "列 Actions 缓存（可按 key / ref 过滤）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  key: z.string().optional().describe("可选：按缓存 key 过滤（GitHub 文档说这个参数是「key 或 key 前缀」，所以可能回多条不同的 key）"),
  ref: z.string().optional().describe("可选：按分支 / ref 过滤（Git ref 全称或分支名，如 refs/heads/main 或 main）"),
  sort: z.enum(["created_at", "last_accessed_at", "size_in_bytes"]).optional().describe("可选：排序字段，缺省 last_accessed_at"),
  direction: z.enum(["asc", "desc"]).optional().describe("可选：排序方向，缺省 desc"),
  limit: z.number().int().min(1).optional().describe("返回条数，默认 30，上限 100（超过上限收敛到 100）"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("返回条数，默认 30，上限 100（超过上限收敛到 100）"),
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const items = Array.isArray(body.actions_caches) ? body.actions_caches : [];
  const scope =
    repoLabel +
    (input?.key ? " · key=" + String(input.key) : "") +
    (input?.ref ? " · ref=" + String(input.ref) : "");

  if (items.length === 0) {
    return (
      label + "（" + scope + "）：没有匹配的缓存。" +
      (input?.key ? "\n注意：GitHub 的 key 参数按文档是「key 或 key 前缀」，若确认该 key 存在，请核对写入时算出的完整 key。" : "")
    );
  }

  const total = items.reduce((sum, it) => sum + (Number(it && it.size_in_bytes) || 0), 0);
  const out = [
    label + "（" + scope + " · " + items.length + " 条" +
      (body.total_count !== undefined ? " / 共 " + body.total_count : "") +
      " · 合计 " + formatBytes(total) + "）：",
  ];
  for (const it of items) {
    out.push(
      "  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) +
      "  " + (it.ref || "?"),
    );
    out.push("      key：" + (it.key || "?"));
    out.push(
      "      创建 " + fmtTime(it.created_at) +
      (it.last_accessed_at ? " · 最后使用 " + fmtTime(it.last_accessed_at) : ""),
    );
  }
  out.push("说明：要清掉某个 key 用 githana_cache(action=\"delete\", key=\"<上面那条 key>\")；按 id 删单条用 id=<上面的 id>。");
  return out.join("\n");
}
