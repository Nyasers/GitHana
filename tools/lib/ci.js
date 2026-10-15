// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/ci.js — githana_run / githana_workflow / githana_cache 三组共用的 Actions 域 helper。
 *
 * 跨名词共用（仓库上下文、仓库推断、当前分支、失败说明、时间渲染）在 tools/lib/gh.js；
 * 这里只放 **Actions 域专有** 的部分：结论与状态的渲染、时长、体积、run 一行的排版、workflow
 * 状态与路径、以及「runId 缺省 = 最近一次 run」那一跳——view / rerun / cancel / download
 * 四个动词都要它，写四份迟早漂。
 *
 * ## 三组的支撑权限都是 `actions`（D7 已授权）
 *
 * run / workflow / cache 全族（含只读的 list / view）都落在同一条 `actions: write` 上，
 * 所以三组各是一个 external_side_effect 工具，只读动词也要过审——与 repo / pr / issue 同一口径。
 *
 * ## 状态与结论是两件事
 *
 * `status` 描述「跑到哪了」（queued / in_progress / completed），`conclusion` 描述「结果如何」
 * （success / failure / cancelled / skipped …），只有 status=completed 时 conclusion 才有值。
 * 合并成一个词只为展示；判断「跑完没」请用 status。
 *
 * `GET /actions/runs` 的 `status` 查询参数**两种值都收**（GitHub 文档：Returns workflow runs
 * with the check run status or conclusion that matches the specified status），所以筛选直接透传，
 * 不在本地二次过滤——少一层会与 GitHub 判断不一致的逻辑。
 *
 * 字段定义（workflowRef / runId / runIdOptional）在 tools/lib/params.js：跨动词共用的键在那里
 * 只定义一次，这里只放渲染与解析。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";
import { describeFailure, fmtTime, currentBranch } from "./gh.js";

/** 结论 → 中文可读（未知值原样透出，不假装认识）。 */
export function conclusionText(conclusion) {
  const c = conclusion !== undefined && conclusion !== null ? String(conclusion) : "";
  if (!c) return "";
  const map = {
    success: "passed",
    failure: "failed",
    neutral: "neutral",
    cancelled: "cancelled",
    skipped: "skipped",
    timed_out: "timed out",
    action_required: "action required",
    stale: "stale",
    startup_failure: "startup failure",
  };
  return map[c] || c;
}

/**
 * run / job 的状态一行词：status=completed 时用结论，否则用状态本身（都转大写，便于扫读）。
 * 缺 status 与 conclusion 时返回 "?"。
 */
export function stateText(obj) {
  const status = obj && obj.status ? String(obj.status) : "";
  const conclusion = obj && obj.conclusion ? String(obj.conclusion) : "";
  if (status === "completed" && conclusion) return conclusion.toUpperCase();
  if (status) return status.toUpperCase();
  if (conclusion) return conclusion.toUpperCase();
  return "?";
}

/** 时长渲染（秒 → 可读）；任一端缺失返回 "?"。 */
export function fmtDuration(fromIso, toIso) {
  if (!fromIso || !toIso) return "?";
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "?";
  const sec = Math.round((to - from) / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return min + "m" + (rem ? rem + "s" : "");
  const hour = Math.floor(min / 60);
  return hour + "h" + (min % 60 ? (min % 60) + "m" : "");
}

/** 字节 → 可读（Actions 的 artifact / cache 体积都以字节给）。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}

/** run 一行的排版（list 用；view 的头部也复用它）。 */
export function runLine(run) {
  const id = run && run.id !== undefined ? String(run.id) : "?";
  const name = (run && (run.name || run.display_title)) || "(unnamed)";
  const branch = run && run.head_branch ? String(run.head_branch) : "?";
  const event = run && run.event ? String(run.event) : "?";
  const attempt = run && Number(run.run_attempt) > 1 ? " · attempt " + run.run_attempt : "";
  return (
    "#" + id + " [" + stateText(run) + "] " + name +
    " · " + branch + " · " + event +
    " · " + fmtTime(run && (run.run_started_at || run.created_at)) +
    attempt
  );
}

/** run 的触发者（渲染用；没有就返回 ""）。 */
export function actorText(run) {
  const a = run && run.actor ? run.actor.login : "";
  return a ? "@" + a : "";
}

/** workflow 的 state 值 → 中文可读（active / disabled_manually / disabled_inactivity / deleted…）。 */
export function workflowStateText(state) {
  const s = state !== undefined && state !== null ? String(state) : "";
  const map = {
    active: "enabled (active)",
    disabled_manually: "disabled manually (disabled_manually)",
    disabled_inactivity: "disabled after inactivity (disabled_inactivity)",
    disabled_fork: "disabled because of fork (disabled_fork)",
    deleted: "deleted (deleted)",
  };
  return map[s] || (s || "?");
}

/**
 * 解析 `workflow_id` 到 API 路径片段（逐段编码）。
 *
 * GitHub 的 `/actions/workflows/{workflow_id}` 数字 ID 与文件名两种都收（文档：You can also
 * pass the workflow file name as a string），所以不做「先列表再匹配」的翻译。逐段编码是必须的：
 * `ci.yml` 与 `ci/build.yml` 都合法，整串 encodeURIComponent 会把分隔用的 `/` 也编掉。
 */
export function workflowPath(workflow) {
  const raw = workflow !== undefined && workflow !== null ? String(workflow).trim() : "";
  return raw.split("/").map(encodeURIComponent).join("/");
}

/**
 * runId 缺省那一跳：取最近一次 run（可按 branch 过滤；branch 缺省从 cwd 的当前分支取）。
 *
 * 这个端点**没有** sort / direction 参数（它自己的文档里只有 actor / branch / event / status /
 * created / head_sha / exclude_pull_requests / per_page / page），返回顺序按创建时间倒序是它
 * 缺省的行为——所以不额外拼排序键，只取一页的 1 条。branch 过滤用它的 `branch` 参数。
 *
 * @param {object} input 工具入参（读 input.runId / input.branch）
 * @param {{ repo: string, repoLabel: string, cwd: string, timeoutSec: * }} c resolveContext 的结果
 * @param {string} label 报错前缀（工具名(action)）
 * @returns {Promise<{ runId: string, picked: object|null, branch: string } | { error: string }>}
 *   picked 非空表示 runId 是**推断**出来的，调用方应把它报给调用方核对。
 */
export async function resolveRunId(input, c, label) {
  const explicit = input && input.runId !== undefined && input.runId !== null ? String(input.runId).trim() : "";
  if (explicit) return { runId: explicit, picked: null, branch: "" };

  const { repo, repoLabel, cwd, timeoutSec } = c;
  let branch = input && input.branch !== undefined && input.branch !== null ? String(input.branch).trim() : "";
  if (!branch && cwd) {
    const cur = await currentBranch(cwd);
    if (!cur.error) branch = cur.branch;
  }

  const query = ["per_page=1"];
  if (branch) query.push("branch=" + encodeURIComponent(branch));
  const url = apiUrl(repo, "/actions/runs") + "?" + query.join("&");
  const r = await callRest([{ url, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }], { timeoutSec });
  if (!r.ok) return { error: label + " failed: " + r.message };
  const res = r.results[0];
  if (!res || !res.ok) return { error: label + " failed: " + describeFailure(res, repoLabel) };

  const runs = res.json && Array.isArray(res.json.workflow_runs) ? res.json.workflow_runs : [];
  if (runs.length === 0) {
    return {
      error:
        label + " cannot determine the run id: repository " + repoLabel +
        (branch ? " (branch " + branch + ")" : "") +
        " has no workflow run at all. Pass runId explicitly, or use githana_run(action=\"list\") first to see which runs exist.",
    };
  }
  const picked = runs[0];
  return { runId: String(picked.id), picked, branch };
}

/** 推断出 runId 时的说明行（调用方拼进回执，让调用方能核对推断对不对）。 */
export function pickedNote(picked, branch) {
  if (!picked) return "";
  return (
    "the run id was inferred (runId was not passed explicitly): using the most recent run of the repository" +
    (branch ? " on branch " + branch : "") +
    " — " + runLine(picked) + ". Pass an explicit runId to target a different run."
  );
}
