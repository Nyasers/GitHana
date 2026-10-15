// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/delete：删除标签（githana_label 动词，需 confirm=true）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/labels/{name}`（支撑权限 `issues: write`）。
 *
 * 「删标签」在 GitHub 上的实际效果是**从所有已打该标签的 issue / PR 上摘掉**——标签定义本身
 * 不可恢复，而那个关联关系也不会留痕。所以本动词：
 *   · 只接受 `confirm=true` 才真删（缺它就返回引导）；
 *   · 删之前先取一次该标签的**打开 issue 数**（`GET /issues?labels=<name>&state=open`，
 *     只取一页的条数），好让审批与回执里都写着"会影响多少条"。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { labelLine } from "../../lib/label.js";

export const command = "delete";
export const summary = "删除标签（从所有已打该标签的 issue 上摘掉）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("要删的标签名"),
  confirm: z.boolean().optional().describe("必须为 true 才真删：删标签会从所有已打它的 issue / PR 上摘掉，缺它会返回引导"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "**删除** GitHub 远端仓库的标签（会从所有已打该标签的 issue / PR 上一起摘掉，关联关系不留痕）：修改 GitHub 远端状态，执行前请再次确认仓库与标签名",
  ruleId: "github-toolkit-label-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " 参数错误：name 必填（要删的标签名）。";
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 先确认标签存在，并取一次它的定义（回执里要写清删的是哪个）。
  const before = await callRest(
    [{ url: apiUrl(repo, "/labels/" + encodeURIComponent(name)), timeoutMs }],
    { timeoutSec },
  );
  if (!before.ok) return label + " 执行失败：" + before.message;
  const bres = before.results[0];
  if (!bres || !bres.ok) {
    if (bres && bres.status === 404) return label + "：仓库 " + repoLabel + " 里没有名为 " + name + " 的标签。";
    return label + " 执行失败：" + describeFailure(bres, repoLabel);
  }
  const target = bres.json && typeof bres.json === "object" ? bres.json : {};

  // 影响面：有多少打开的 issue / PR 打着这个标签（只取一页，够说明量级）。
  let affected = null;
  const useR = await callRest(
    [
      {
        url: apiUrl(repo, "/issues") + "?state=open&labels=" + encodeURIComponent(name) + "&per_page=100",
        timeoutMs,
      },
    ],
    { timeoutSec },
  );
  if (useR.ok && useR.results[0] && useR.results[0].ok && Array.isArray(useR.results[0].json)) {
    affected = useR.results[0].json.length;
  }
  // 恰好一整页（100）时无法区分「正好 100」与「100 以上」：`/issues` 不分页，这里只看得到第一页。
  // 报成精确的 100 是把截断说成事实，所以那种情况报「≥100」。`> 100` 不可能出现（页就 100 条），
  // 但用 `>=` 表达意图更直白。
  const affectedAtLeast = affected !== null && affected >= 100;

  if (input?.confirm !== true) {
    return [
      label + " 需要确认（未执行删除）：",
      "将删除标签：" + labelLine(target).trim() + "（" + repoLabel + "）",
      "影响：" + (affected === null ? "未取到（不影响删除本身）" : affectedAtLeast ? "当前有 ≥100 个打开的 issue / PR 打着它（只统计了第一页 100 条），会一起被摘掉" : "当前有 " + affected + " 个打开的 issue / PR 打着它，会一起被摘掉") + "。",
      "删除**不可撤销**：标签定义删了就没了，关联关系也不留痕。只想去掉某个 issue 上的标签，请用 githana_issue(action=\"edit\", removeLabels=[\"" + name + "\"])。",
      "确认后请重发同一次调用并带上 confirm=true。",
    ].join("\n");
  }

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/labels/" + encodeURIComponent(name)), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " 执行失败：" + describeFailure(res, repoLabel);

  return [
    label + " 已删除（" + repoLabel + "）：",
    "标签：" + labelLine(target).trim(),
    "影响：" + (affected === null ? "已从所有已打该标签的 issue / PR 上摘掉（数量未取到）" : affectedAtLeast ? "已从 ≥100 个打开的 issue / PR 上摘掉（数量为删除前统计的第一页 100 条，实际可能更多）" : "已从 " + affected + " 个打开的 issue / PR 上摘掉（数量为删除前的打开项）"),
    "说明：删除不可撤销；要重建同名标签用 githana_label(action=\"create\")。",
  ].join("\n");
}
