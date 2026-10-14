// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/list：列出仓库的 issue（githana_issue 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/issues`（支撑权限 `issues: write`，读也在同一条上）。
 *
 * **默认滤掉 PR**：这个端点默认把 PR 也当 issue 返回（GitHub 上两者共用编号空间），
 * 而「列 issue」的意图通常不含 PR。所以本动词在本地按 `pull_request` 键过滤；
 * 要连 PR 一起看传 `includePrs=true`。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { labelText } from "../../lib/issue.js";


export const command = "list";
export const summary = "列 issue（默认不含 PR）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  state: z.enum(["open", "closed", "all"]).optional().describe("issue 状态过滤，默认 open"),
  // 标签过滤用数组而不是逗号串：同一个键 `labels` 在本工具的 create / edit 上是数组（gh 的
  // `--label` 也是可重复的），模型面的平表同键只留一份——两处形态不一致会让摘要自相矛盾。
  labels: z.array(z.string()).optional().describe("可选：按标签名过滤（多个标签是「同时都有」）"),
  assignee: z.string().optional().describe("可选：按指派人登录名过滤；传 * 表示「有指派人的」"),
  limit: z.number().int().min(1).optional().describe("返回条数，默认 15，上限 50（超过上限收敛到 50）"),
  includePrs: z.boolean().optional().describe("可选：true 时连 PR 一起列出（端点默认两者都返回，本动词默认滤掉 PR）"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 50"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(50).describe("返回条数，默认 15，上限 50（超过上限收敛到 50）"),
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  // 取值域由 schema 保证（enum）；这里只做缺省与收敛。
  const state = String(input?.state || "open");
  const includePrs = input?.includePrs === true;
  let limit = 15;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(50, input.limit);

  const query = ["state=" + encodeURIComponent(state), "sort=created", "direction=desc", "per_page=" + String(limit)];
  if (Array.isArray(input?.labels) && input.labels.length) {
    // GitHub 的 labels 过滤是逗号分隔的名单（"同时都有"）。
    query.push("labels=" + encodeURIComponent(input.labels.map((x) => String(x)).join(",")));
  }
  if (input?.assignee !== undefined && input?.assignee !== null && String(input.assignee).trim() !== "") {
    query.push("assignee=" + encodeURIComponent(String(input.assignee).trim()));
  }

  const r = await callRest(
    [{ url: apiUrl(repo, "/issues") + "?" + query.join("&"), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

  const raw = Array.isArray(res.json) ? res.json : [];
  const items = includePrs ? raw : raw.filter((it) => !(it && it.pull_request));
  const dropped = raw.length - items.length;

  const scope =
    "state=" + state +
    (Array.isArray(input?.labels) && input.labels.length ? " · labels=" + input.labels.join(",") : "") +
    (input?.assignee ? " · assignee=" + String(input.assignee).trim() : "") +
    (includePrs ? " · 含 PR" : "");
  if (items.length === 0) {
    return (
      label + "（" + repoLabel + " · " + scope + "）：没有匹配的 issue。" +
      (dropped > 0 ? "\n（端点返回的 " + dropped + " 条都是 PR，已按默认口径滤掉；要一起看传 includePrs=true。）" : "")
    );
  }

  const out = [label + "（" + repoLabel + " · " + scope + " · " + items.length + " 条）："];
  for (const it of items) {
    const isPr = !!(it && it.pull_request);
    out.push(
      "#" + it.number + " [" + String(it.state || "?").toUpperCase() + (it.locked ? "·locked" : "") + "]" +
      (isPr ? "[PR]" : "") + " " + fmtTime(it.created_at) +
      " · @" + ((it.user && it.user.login) || "?") + " · " + (it.title || ""),
    );
    const labels = labelText(it);
    if (labels) out.push("  标签：" + labels);
    if (it.comments) out.push("  评论 " + it.comments + " 条");
    if (it.html_url) out.push("  " + it.html_url);
  }
  if (dropped > 0) out.push("（另有 " + dropped + " 条 PR 已按默认口径滤掉；要一起看传 includePrs=true。）");
  return out.join("\n");
}
