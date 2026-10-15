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
export const summary = "Re-run a run (with failedOnly=true only the failed jobs are re-run)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("Optional: used to filter out the most recent run when runId is omitted (defaults to the current branch of cwd)"),
  failedOnly: z.boolean().optional().describe("Optional: re-run only the failed jobs (POST .../rerun-failed-jobs); by default the whole run is re-run"),
  debugLogging: z.boolean().optional().describe("Optional: enable detailed logs for **this re-run** (enable_debug_logging; this does not permanently turn on debug logging for the repository)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Re-run a workflow run on remote GitHub (consumes CI quota again and may push / deploy / change remote state): confirm repo and run number before running",
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
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 201 Created 是成功（重跑创建了一次新的尝试，无正文）。
  if (!res || (!res.ok && res.status !== 201)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 403) {
      return (
        label + " execution failed: GitHub rejected this re-run (403). Common causes: the token's actions permission is insufficient, " +
        "or this run is too old (GitHub only keeps re-run ability for a limited window — see the repository settings for log and artifact retention), " +
        "or Actions are disabled for the repository.\n" +
        "GitHub raw message: " + detail
      );
    }
    if (st === 409) {
      return label + ": run #" + num + " is in a state that does not allow a re-run (409 — it may still be running, or another re-run may already be occupying it).\nGitHub raw message: " + detail;
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const out = [
    label + " triggered (" + repoLabel + " · run #" + num + "):",
    "scope: " + (failedOnly ? "re-run only the failed jobs (rerun-failed-jobs)" : "re-run the whole run (rerun)"),
    "detailed logs: " + (input?.debugLogging === true ? "yes, for this re-run (enable_debug_logging)" : "no"),
    "HTTP " + res.status + " (GitHub accepted this re-run — **not** \"it has finished\")",
  ];
  if (resolved.picked) out.push("note: " + pickedNote(resolved.picked, resolved.branch));

  // 触发后取一次现状：让回执里带上这一跑的基线（GitHub 的重跑会新建一次 attempt，状态立刻变）。
  const after = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (after.ok && after.results[0] && after.results[0].ok && after.results[0].json) {
    out.push("state right after the trigger: " + runLine(after.results[0].json));
    const url = after.results[0].json.html_url;
    if (url) out.push("URL: " + url);
  }

  out.push("note: this is a **synchronous trigger** — the receipt says \"triggered\". To see the result use githana_run(action=\"view\", runId=" + num + ");");
  out.push("to \"wait for the terminal state and then report\", use the task-style githana_run(action=\"watch\", runId=" + num + ") (it returns a background task handle and reports the conclusion back to this session when CI reaches a terminal state).");
  return out.join("\n");
}
