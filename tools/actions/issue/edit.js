// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/edit：改 issue 的标题 / 正文 / 标签 / 指派 / 里程碑（githana_issue 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/issues/{n}`（支撑权限 `issues: write`），标签另有
 * `POST|DELETE /issues/{n}/labels`。参数按**改哪个字段**分成三组，各自语义不同，不混：
 *
 *   · `title` / `body` / `milestone` → 直接改（milestone 传 null 清空不了，要用 0——
 *     0 是 GitHub 的「无里程碑」约定值）；
 *   · `labels` → **整体替换**标签集；
 *   · `addLabels` / `removeLabels` → 增删（与 `labels` 互斥：同时给会让「最终标签集是什么」
 *     有两种算法，只认一种，另一种当场拒）。
 *
 * 状态（open / closed）不在本动词上：那是 close / reopen 两个动词的事，分着放比「一个字段
 * 兼职两种语义」更好读。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage, labelText, assigneeText, issueStateText } from "../../lib/issue.js";

export const command = "edit";
export const summary = "改 issue 的标题 / 正文 / 标签 / 指派 / 里程碑";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  title: z.string().optional().describe("可选：新的标题（不能为空串）"),
  body: z.string().optional().describe("可选：新的正文（支持 Markdown；传空串即清空正文）"),
  labels: z.array(z.string()).optional().describe("可选：**整体替换**标签集（传空数组 = 清空全部标签）"),
  addLabels: z.array(z.string()).optional().describe("可选：只加这些标签（与 labels 互斥）"),
  removeLabels: z.array(z.string()).optional().describe("可选：只删这些标签（与 labels 互斥）"),
  assignees: z.array(z.string()).optional().describe("可选：**整体替换**指派人（登录名，不带 @；传空数组 = 取消全部指派）"),
  milestone: z.number().int().min(1).optional().describe("可选：里程碑编号（正整数）；取消里程碑请传 clearMilestone=true"),
  clearMilestone: z.boolean().optional().describe("可选：true 清空里程碑（GitHub 的约定值是 milestone=0，这个布尔替你填）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "修改 GitHub 远端 issue 的标题 / 正文 / 标签 / 指派 / 里程碑（改指派与标签会通知相关人）：会改写 issue 在 GitHub 上的内容，执行前请确认编号与要改的字段",
  ruleId: "github-toolkit-issue-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const hasLabels = Array.isArray(input?.labels);
  const hasAdd = Array.isArray(input?.addLabels) && input.addLabels.length > 0;
  const hasRemove = Array.isArray(input?.removeLabels) && input.removeLabels.length > 0;
  if (hasLabels && (hasAdd || hasRemove)) {
    return (
      label + " 参数错误：labels（整体替换）与 addLabels / removeLabels（增删）不能同时给。\n" +
      "「最终标签集是什么」只能有一种算法：要么给 labels 定全集，要么给增删让 GitHub 现算。"
    );
  }

  const patch = {};
  const changed = [];
  if (input?.title !== undefined && input?.title !== null) {
    const v = String(input.title).trim();
    if (!v) return label + " 参数错误：title 不能为空串（issue 标题不允许为空）。";
    patch.title = v;
    changed.push("title");
  }
  if (input?.body !== undefined && input?.body !== null) {
    // body 允许空串——那是"清空正文"，是明确意图，不是缺省。
    patch.body = String(input.body);
    changed.push("body");
  }
  if (Array.isArray(input?.assignees)) {
    patch.assignees = input.assignees.map((x) => String(x));
    changed.push("assignees（整体替换：" + (patch.assignees.length ? patch.assignees.map((a) => "@" + a).join(" · ") : "清空") + "）");
  }
  if (input?.clearMilestone === true) {
    // GitHub 的「无里程碑」约定值是 0（传 null 不生效）。
    patch.milestone = 0;
    changed.push("milestone（清空）");
  } else if (input?.milestone !== undefined && input?.milestone !== null) {
    patch.milestone = input.milestone;
    changed.push("milestone=" + input.milestone);
  }
  if (hasLabels) {
    patch.labels = input.labels.map((x) => String(x));
    changed.push("labels（整体替换：" + (patch.labels.length ? patch.labels.join(" · ") : "清空") + "）");
  }

  if (changed.length === 0 && !hasAdd && !hasRemove) {
    return (
      label + " 参数错误：至少要给一个要改的字段（title / body / labels / addLabels / removeLabels / assignees / milestone）。\n" +
      "改状态用 githana_issue(action=\"close\") 或 githana_issue(action=\"reopen\")。"
    );
  }

  // 先核对这个编号确实是 issue（不是 PR）：issue 与 PR 的编辑走不同动词（PR 在 githana_pr）。
  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "要改这个 PR 请用 githana_pr(action=\"edit\", prNumber=" + numStr + ")。",
    );
  }

  const batch = [];
  if (Object.keys(patch).length) {
    batch.push({ id: "patch", method: "PATCH", url: apiUrl(repo, "/issues/" + numStr), json: patch, timeoutMs });
  }
  if (hasAdd) {
    batch.push({
      id: "add",
      method: "POST",
      url: apiUrl(repo, "/issues/" + numStr + "/labels"),
      json: { labels: input.addLabels.map((x) => String(x)) },
      timeoutMs,
    });
  }
  // 删标签要**逐个**删：`DELETE /issues/{n}/labels`（集合形态）是"摘掉全部标签"，
  // 传 body 指定名单不会生效——那是两个不同的端点，混用会静默地把标签全清掉。
  if (hasRemove) {
    input.removeLabels.forEach((raw, i) => {
      batch.push({
        id: "remove:" + i,
        method: "DELETE",
        url: apiUrl(repo, "/issues/" + numStr + "/labels/" + encodeURIComponent(String(raw))),
        timeoutMs,
      });
    });
  }

  const r = await callRest(batch, { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;

  const patched = r.results.find((x) => x.id === "patch");
  const added = r.results.find((x) => x.id === "add");
  const removeResults = r.results.filter((x) => String(x.id).startsWith("remove:"));
  const failed = [patched, added, ...removeResults].find((x) => x && !x.ok);
  if (failed) {
    if (failed.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次修改（422）。常见原因：标签名不存在、被指派人不是协作者、\n" +
        "里程碑编号不存在。\nGitHub 原文：" + errorDetail(failed)
      );
    }
    return label + " 执行失败：" + describeFailure(failed, repoLabel);
  }
  if (added) changed.push("加标签：" + input.addLabels.join(" · "));
  if (removeResults.length) changed.push("删标签：" + input.removeLabels.join(" · "));

  // 终态**再读一次**：增删标签那条请求不回 issue 本体，而 PATCH 的响应是在增删之前拿到的，
  // 拿它报"现标签"会漏掉这次加/删的结果（回执与实际不符比不报更糟）。
  const afterRes = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  const after = afterRes.error ? cur.issue : afterRes.issue;
  const out = [
    label + " 已执行（issue #" + numStr + " · " + repoLabel + "）：",
    "改动：" + changed.join(" · "),
    "现标题：" + (after.title || "（无标题）") + " · 状态：" + issueStateText(after),
    "现标签：" + (labelText(after) || "（无）"),
    "现指派：" + (assigneeText(after) || "（无）"),
  ];
  if (afterRes.error) out.push("（终态回读失败，上面几行是改动前那一份：" + afterRes.error.trim() + "）");
  if (after.html_url) out.push("URL：" + after.html_url);
  return out.join("\n");
}
