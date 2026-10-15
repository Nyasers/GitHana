// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/rerun：重跑一次 workflow run（githana_run 动词）。
 *
 * ## 同步触发，不是任务型
 *
 * `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun` 是**同步触发**：GitHub 收下就返回 201，
 * 它不会等到 CI 跑完（跑完要几分钟）。所以本动词回执里写的是「已触发」，不是「已通过」——
 * 这一点与 `run watch`（任务型，返回句柄、到终态回投会话）是**两种返回契约**，不能混。
 * 要知道结果：隔一会儿 `githana_run(action="view", runId=<同一个>)` 看结论；
 * 要自动等终态用 `githana_run(action="watch", runId=<同一个>)`（任务型，返回句柄、到终态回投会话）。
 *
 * ## `debugLogging` 的语义要说清
 *
 * 置 true 会在**重跑的那一次**打详细日志（GitHub 文档：Enable debug logging for this run；
 * 请求体字段是 `enable_debug_logging`）。它不是「永久打开这个仓库的调试日志」——那种误解会让
 * 人以为一次调用改变了仓库配置。gh 的对应开关是 `gh run rerun --debug`。
 *
 * ## API 的两个分支
 *
 * `POST .../rerun` 重跑整个 run，`POST .../rerun-failed-jobs` 只重跑失败的作业。两者参数形状
 * 相同（只有 `enable_debug_logging`），语义不同，所以合成一个 `failedOnly` 布尔——**不是**
 * 一次调用里的「两步」，是一个请求的两种写法。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, runLine } from "../../lib/ci.js";

export const command = "rerun";
export const summary = "重跑一次 run（failedOnly=true 时只重跑失败的作业）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("可选：runId 缺省时用它过滤出最近一次 run（缺省取 cwd 的当前分支）"),
  failedOnly: z.boolean().optional().describe("可选：只重跑失败的作业（POST .../rerun-failed-jobs）；缺省重跑整个 run"),
  debugLogging: z.boolean().optional().describe("可选：**这一次重跑**打详细日志（enable_debug_logging；不是永久打开本仓库的调试日志）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "在 GitHub 远端重跑一次 workflow run（会重新占用 CI 额度，可能推送 / 部署 / 改远端状态）：执行前请确认 repo 与 run 编号",
  ruleId: "github-toolkit-run-rerun",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  const failedOnly = input?.failedOnly === true;
  const payload = {};
  if (input?.debugLogging === true) payload.enable_debug_logging = true;

  const path = "/actions/runs/" + encodeURIComponent(num) + (failedOnly ? "/rerun-failed-jobs" : "/rerun");
  const r = await callRest(
    [
      {
        method: "POST",
        url: apiUrl(repo, path),
        json: payload,
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 201 Created 是成功（重跑创建了一次新的尝试，无正文）。
  if (!res || (!res.ok && res.status !== 201)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 403) {
      return (
        label + " 执行失败：GitHub 拒绝这次重跑（403）。常见原因：令牌对 actions 的权限不足、" +
        "或这个 run 太久（GitHub 只保留一段时间内的重跑能力——日志与产物的保留期见仓库设置），" +
        "或仓库的 Actions 被停用。\n" +
        "GitHub 原文：" + detail
      );
    }
    if (st === 409) {
      return label + "：run #" + num + " 当前状态不允许重跑（409——它可能还在跑，或已经被别的重跑占用）。\nGitHub 原文：" + detail;
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const out = [
    label + " 已触发（" + repoLabel + " · run #" + num + "）：",
    "范围：" + (failedOnly ? "只重跑失败的作业（rerun-failed-jobs）" : "重跑整个 run（rerun）"),
    "详细日志：" + (input?.debugLogging === true ? "这一次重跑会打（enable_debug_logging）" : "否"),
    "HTTP " + res.status + "（GitHub 已收下这次重跑，**不是**「已经跑完」）",
  ];
  if (resolved.picked) out.push("说明：" + pickedNote(resolved.picked, resolved.branch));

  // 触发后取一次现状：让回执里带上这一跑的基线（GitHub 的重跑会新建一次 attempt，状态立刻变）。
  const after = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (after.ok && after.results[0] && after.results[0].ok && after.results[0].json) {
    out.push("触发后的现状：" + runLine(after.results[0].json));
    const url = after.results[0].json.html_url;
    if (url) out.push("URL：" + url);
  }

  out.push("说明：这是**同步触发**——回执写的是「已触发」。要看结果用 githana_run(action=\"view\", runId=" + num + ")；");
  out.push("「等到终态再回报」用任务型的 githana_run(action=\"watch\", runId=" + num + ")（返回后台任务句柄，CI 到终态时结论回投本会话）。");
  return out.join("\n");
}
