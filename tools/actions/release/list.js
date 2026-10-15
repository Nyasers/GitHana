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
export const summary = "列发布（默认不含草稿）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  limit: z.number().int().min(1).optional().describe("返回条数，默认 20，上限 100（超过上限收敛到 100）"),
  includeDrafts: z.boolean().optional().describe("可选：连草稿一起列（端点默认就返回草稿，本动词默认滤掉）"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("返回条数，默认 20，上限 100（超过上限收敛到 100）"),
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

  const raw = Array.isArray(res.json) ? res.json : [];
  const items = includeDrafts ? raw : raw.filter((it) => !(it && it.draft));
  const dropped = raw.length - items.length;

  const scope = repoLabel + (includeDrafts ? " · 含草稿" : " · 不含草稿");
  if (items.length === 0) {
    return (
      label + "（" + scope + "）：没有匹配的发布。" +
      (dropped > 0 ? "\n（端点返回的 " + dropped + " 条都是草稿，已按默认口径滤掉；要一起看传 includeDrafts=true。）" : "")
    );
  }

  const out = [label + "（" + scope + " · " + items.length + " 条 · 按创建时间倒序）："];
  for (const it of items) out.push(releaseLine(it));
  if (dropped > 0) out.push("（另有 " + dropped + " 条草稿已按默认口径滤掉；要一起看传 includeDrafts=true。）");
  return out.join("\n");
}
