// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/list：列仓库里的工作流（githana_workflow 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/workflows`，支撑权限 `actions: write`（D7 已授权）。
 *
 * ## `enabledOnly` 在本地过滤，不靠查询参数
 *
 * 这个端点**没有**状态过滤参数（文档里只有 per_page / page），返回的是仓库里的全部工作流，
 * 含被停用的那些（每个条目自己的 `state` 字段说明它处于哪一档）。所以过滤在本地做：
 * 只发一次请求，`enabledOnly=true` 时按 `state === "active"` 筛。多花一次请求去取「只启用的」
 * 会依赖一个文档里没有的参数——那种用法在端点行为变化时会静默变成「什么都没筛」。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { workflowStateText } from "../../lib/ci.js";

export const command = "list";
export const summary = "列仓库里的工作流（默认含被停用的）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  enabledOnly: z.boolean().optional().describe("可选：只看启用的（state=active；端点在本地按 state 筛，不靠查询参数）"),
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
  const enabledOnly = input?.enabledOnly === true;

  const r = await callRest(
    [
      {
        url: apiUrl(repo, "/actions/workflows") + "?per_page=" + String(limit),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const all = Array.isArray(body.workflows) ? body.workflows : [];
  const items = enabledOnly ? all.filter((wf) => String((wf && wf.state) || "") === "active") : all;
  const dropped = all.length - items.length;

  if (items.length === 0) {
    if (all.length === 0) {
      return label + "（" + repoLabel + "）：这个仓库没有工作流（.github/workflows/ 下没有定义，或令牌不可见）。";
    }
    return label + "（" + repoLabel + " · 仅启用）：没有启用的工作流（共 " + all.length + " 个，全部处于停用状态）。";
  }

  const out = [
    label + "（" + repoLabel + " · " + items.length + " 个" + (enabledOnly ? " · 仅启用" : "") +
      (body.total_count !== undefined ? " / 共 " + body.total_count : "") + "）：",
  ];
  for (const wf of items) {
    out.push("  " + (wf.name || "（无名）") + "  " + workflowStateText(wf.state));
    out.push(
      "      ID：" + (wf.id !== undefined ? wf.id : "?") + " · 路径：" + (wf.path || "?") +
      (wf.updated_at ? " · 更新 " + fmtTime(wf.updated_at) : ""),
    );
    if (wf.html_url) out.push("      " + String(wf.html_url));
  }
  if (dropped > 0) out.push("（另有 " + dropped + " 个被停用的已按 enabledOnly 滤掉。）");
  out.push("说明：ID 与路径（文件名）都能当其它动词的 workflow 参数（view / run / enable / disable）。");
  return out.join("\n");
}
