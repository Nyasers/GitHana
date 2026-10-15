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
export const summary = "看一个 run 的详情（含各作业状态）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("可选：runId 缺省时用它过滤出最近一次 run（缺省取 cwd 的当前分支）"),
  job: z.string().optional().describe("可选：只看名字匹配这个子串的作业（按名字过滤，不额外发请求）"),
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const runRes = r.results.find((x) => x.id === "run");
  const jobsRes = r.results.find((x) => x.id === "jobs");
  if (!runRes || !runRes.ok) {
    if (runRes && runRes.status === 404) return label + "：run #" + num + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(runRes, repoLabel);
  }

  // 变量名不叫 `run`：那会与本模块导出的 run() 同名（函数体作用域遮蔽模块作用域），读起来
  // 像递归调用，实际不是——改名省掉这份误会。
  const runJson = runRes.json && typeof runRes.json === "object" ? runRes.json : {};
  const out = [];
  out.push("run #" + (runJson.id !== undefined ? runJson.id : num) + " · " + repoLabel);
  out.push("名称：" + (runJson.name || runJson.display_title || "（无名）"));
  if (runJson.display_title && runJson.display_title !== runJson.name) out.push("标题：" + String(runJson.display_title));
  out.push(
    "状态：" + String(runJson.status || "?").toUpperCase() +
      (runJson.conclusion ? " · 结论 " + conclusionText(runJson.conclusion) + "（" + runJson.conclusion + "）" : ""),
  );
  out.push(
    "分支：" + (runJson.head_branch || "?") + " · 事件 " + (runJson.event || "?") +
      (runJson.run_attempt !== undefined ? " · 第 " + runJson.run_attempt + " 次尝试" : ""),
  );
  if (runJson.head_sha) out.push("提交：" + String(runJson.head_sha).slice(0, 7) + "（" + runJson.head_sha + "）");
  if (actorText(runJson)) out.push("触发者：" + actorText(runJson));
  out.push(
    "时间：" + fmtTime(runJson.run_started_at || runJson.created_at) +
      " · 耗时 " + fmtDuration(runJson.run_started_at || runJson.created_at, runJson.updated_at),
  );
  if (runJson.html_url) out.push("URL：" + runJson.html_url);
  if (resolved.picked) out.push("说明：" + pickedNote(resolved.picked, resolved.branch));

  // 作业列表：CI 出问题时看的是这一层。
  const jobFilter = input?.job !== undefined && input?.job !== null ? String(input.job).trim() : "";
  const allJobs = jobsRes && jobsRes.ok && jobsRes.json && Array.isArray(jobsRes.json.jobs) ? jobsRes.json.jobs : [];
  const jobs = jobFilter ? allJobs.filter((j) => String((j && j.name) || "").includes(jobFilter)) : allJobs;

  out.push("");
  if (!jobsRes || !jobsRes.ok) {
    out.push("—— 作业（取不到）——");
    out.push("  " + (jobsRes ? describeFailure(jobsRes, repoLabel) : "作业请求没有结果。"));
  } else if (allJobs.length === 0) {
    out.push("—— 作业（0 个）——");
    out.push("  （run 里还没有作业：可能是 queued，或它只是个没有 job 的聚合记录）");
  } else if (jobs.length === 0) {
    out.push("—— 作业（0 个匹配 " + jobFilter + "，共 " + allJobs.length + " 个）——");
    for (const j of allJobs) out.push("  [" + stateText(j) + "] " + ((j && j.name) || "（无名）"));
  } else {
    out.push("—— 作业（" + jobs.length + " 个" + (jobFilter ? "匹配 " + jobFilter + " / 共 " + allJobs.length : "") + "）——");
    for (const j of jobs) {
      const steps = Array.isArray(j && j.steps) ? j.steps : [];
      const failed = steps.filter((s) => s && s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped");
      out.push(
        "  [" + stateText(j) + "] " + ((j && j.name) || "（无名）") +
        " · " + fmtDuration(j && j.started_at, j && j.completed_at) +
        (steps.length ? " · 步骤 " + steps.length + (failed.length ? "（其中 " + failed.length + " 个非 success）" : "") : ""),
      );
      // 只列非成功的步骤：成功的步骤逐个列出是噪声，而失败的那几个正是要看的东西。
      for (const s of failed) {
        out.push("      [" + String(s.conclusion).toUpperCase() + "] " + (s.name || "（无步名）"));
      }
      if (j && j.html_url) out.push("      " + j.html_url);
    }
  }
  return out.join("\n");
}
