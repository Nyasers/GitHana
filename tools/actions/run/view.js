// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/view：看一个 run 的详情（githana_run 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/runs/{run_id}`（run 本体）与
 * `.../runs/{run_id}/jobs`（作业列表），支撑权限 `actions: write`（D7 已授权）。
 *
 * ## 两个端点一起取
 *
 * run 本体给的是「这一跑整体到哪了」（status / conclusion / 时长 / 触发），jobs 给的是
 * 「每个作业到哪了」——CI 出问题时看的是后者（哪个 job 红了），只报前者等于让人再问一次。
 * 两次请求在同一次 callRest 里，一次审批、一个返回。
 *
 * runId 缺省那一跳（= 最近一次 run）在 tools/lib/ci.js 的 resolveRunId：view / rerun /
 * cancel / delete 四个动词共用它。推断出来的编号在回执里明说，让调用方能核对。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { resolveRunId, pickedNote, stateText, conclusionText, fmtDuration, actorText } from "../../lib/ci.js";

export const command = "view";
export const summary = "View a run's details (including the state of each job)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("Optional: used to filter out the most recent run when runId is omitted (defaults to the current branch of cwd)"),
  job: z.string().optional().describe("Optional: only jobs whose name contains this substring (filtered by name; no extra request)"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  const r = await callRest(
    [
      { id: "run", url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs },
      { id: "jobs", url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/jobs") + "?per_page=100", timeoutMs },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const runRes = r.results.find((x) => x.id === "run");
  const jobsRes = r.results.find((x) => x.id === "jobs");
  if (!runRes || !runRes.ok) {
    if (runRes && runRes.status === 404) return label + ": run #" + num + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(runRes, repoLabel);
  }

  // 变量名不叫 `run`：那会与本模块导出的 run() 同名（函数体作用域遮蔽模块作用域），读起来
  // 像递归调用，实际不是——改名省掉这份误会。
  const runJson = runRes.json && typeof runRes.json === "object" ? runRes.json : {};
  const out = [];
  out.push("run #" + (runJson.id !== undefined ? runJson.id : num) + " · " + repoLabel);
  out.push("name: " + (runJson.name || runJson.display_title || "(unnamed)"));
  if (runJson.display_title && runJson.display_title !== runJson.name) out.push("title: " + String(runJson.display_title));
  out.push(
    "status: " + String(runJson.status || "?").toUpperCase() +
      (runJson.conclusion ? " · conclusion " + conclusionText(runJson.conclusion) + " (" + runJson.conclusion + ")" : ""),
  );
  out.push(
    "branch: " + (runJson.head_branch || "?") + " · event " + (runJson.event || "?") +
      (runJson.run_attempt !== undefined ? " · attempt " + runJson.run_attempt : ""),
  );
  if (runJson.head_sha) out.push("commit: " + String(runJson.head_sha).slice(0, 7) + " (" + runJson.head_sha + ")");
  if (actorText(runJson)) out.push("triggered by: " + actorText(runJson));
  out.push(
    "time: " + fmtTime(runJson.run_started_at || runJson.created_at) +
      " · took " + fmtDuration(runJson.run_started_at || runJson.created_at, runJson.updated_at),
  );
  if (runJson.html_url) out.push("URL: " + runJson.html_url);
  if (resolved.picked) out.push("note: " + pickedNote(resolved.picked, resolved.branch));

  // 作业列表：CI 出问题时看的是这一层。
  const jobFilter = input?.job !== undefined && input?.job !== null ? String(input.job).trim() : "";
  const allJobs = jobsRes && jobsRes.ok && jobsRes.json && Array.isArray(jobsRes.json.jobs) ? jobsRes.json.jobs : [];
  const jobs = jobFilter ? allJobs.filter((j) => String((j && j.name) || "").includes(jobFilter)) : allJobs;

  out.push("");
  if (!jobsRes || !jobsRes.ok) {
    out.push("—— jobs (could not fetch) ——");
    out.push("  " + (jobsRes ? describeFailure(jobsRes, repoLabel) : "the jobs request returned no result."));
  } else if (allJobs.length === 0) {
    out.push("—— jobs (0) ——");
    out.push("  (the run has no jobs yet: it may be queued, or it may just be an aggregate record with no jobs)");
  } else if (jobs.length === 0) {
    out.push("—— jobs (0 matching " + jobFilter + ", " + allJobs.length + " in total) ——");
    for (const j of allJobs) out.push("  [" + stateText(j) + "] " + ((j && j.name) || "(unnamed)"));
  } else {
    out.push("—— jobs (" + jobs.length + (jobFilter ? " matching " + jobFilter + " / " + allJobs.length + " in total" : "") + ") ——");
    for (const j of jobs) {
      const steps = Array.isArray(j && j.steps) ? j.steps : [];
      const failed = steps.filter((s) => s && s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped");
      out.push(
        "  [" + stateText(j) + "] " + ((j && j.name) || "(unnamed)") +
        " · " + fmtDuration(j && j.started_at, j && j.completed_at) +
        (steps.length ? " · steps " + steps.length + (failed.length ? " (" + failed.length + " of them not success)" : "") : ""),
      );
      // 只列非成功的步骤：成功的步骤逐个列出是噪声，而失败的那几个正是要看的东西。
      for (const s of failed) {
        out.push("      [" + String(s.conclusion).toUpperCase() + "] " + (s.name || "(no step name)"));
      }
      if (j && j.html_url) out.push("      " + j.html_url);
    }
  }
  return out.join("\n");
}
