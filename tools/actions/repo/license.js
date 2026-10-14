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
export const summary = "列许可证模板（key 用于 create 的 license 参数）";

export const schema = {
  full: z
    .boolean()
    .optional()
    .describe("可选：true 返回完整响应（含各字段说明与正文）；默认只列 key / 名称 / SPDX ID 三列"),
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, "");

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) return label + "：GitHub 返回了空的许可证清单（异常，请稍后重试）。";

  if (input?.full === true) {
    const text = JSON.stringify(items, null, 2);
    const MAX = 20000;
    return [
      label + "（完整响应 · " + items.length + " 项）：",
      text.length > MAX ? text.slice(0, MAX) + "\n…（截断，共 " + text.length + " 字符）" : text,
    ].join("\n");
  }

  const out = [label + "（GitHub 提供的许可证 · " + items.length + " 项）："];
  for (const it of items) {
    out.push("  " + (it.key || "?") + "  ·  " + (it.name || "") + (it.spdx_id ? "  ·  " + it.spdx_id : ""));
  }
  out.push("用法：githana_repo(action=\"create\", name=\"<仓库名>\", license=\"<上面第一列的 key>\")。");
  out.push("要看完整响应（含正文）：githana_repo(action=\"license\", full=true)。");
  return out.join("\n");
}
