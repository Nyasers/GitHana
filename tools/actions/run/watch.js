// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/watch：盯一次 CI 到终态，把结论回投来源会话（githana_run 动词）。
 *
 * ## 为什么它**不返回结论**
 *
 * 「等 CI 跑完」以分钟计，任何形式的「在工具回调里等」都会占着宿主通道（spec gh-cli-parity
 * 的 AC10 第一条纪律）。所以本动词的返回契约与同工具的其它动词不同：它建一个**宿主后台任务**
 * 并立刻返回一个**句柄**——`ctx.tasks.create({ scope: "session", delivery: "next-step",
 * chipVisibility: "show" })`。会话任务的创建与投递要两项能力：`app/tasks.manage`（建、结算）
 * 与 `app/session.start-turn`（把结果送进会话起回合）；挡位只决定「怎么投」，不代替权限。
 * 由后台轮询器在 CI 到终态时 `complete` 那个任务，宿主按档位把结论贴回来源会话。
 *
 * ## 三条纪律（AC10）在本文件里的落点
 *
 *   1. **工具回调内不等**：`run()` 只做「定位 run + 建任务」两次短调用，随后用 setTimeout
 *      起第一跳并立刻返回；轮询循环整体跑在定时器里，从不被回调 await。
 *   2. **会话内取消即停**：每一跳先读一次宿主任务记录（`ctx.tasks.get`），记录已是终态
 *      （用户在任务项上取消会把状态置成 canceled/aborted）就不再取数、不再结算，直接收摊。
 *   3. **App 重载后恢复**：盯守坐标（repo / runId / 间隔 / 截止时刻）写在宿主任务记录的
 *      `metadata.githana` 里，本模块用 `registerTaskResumer("run-watch", …)` 登记恢复实现；
 *      app.js 在 apply 阶段调 tools/lib/tasks.js 的 resumePendingTasks()，从 `ctx.tasks.list()`
 *      把未终结的记录接回去继续盯。所以**不落任何私有状态文件**——宿主记录本身就是事实源。
 *
 * ## 与 `view` / `cancel` 的分界
 *
 * `view` 报的是**此刻**的状态（要「等」就自己隔一会儿再 view 一次）；本动词报的是
 * **到终态那一刻**的结论，并且不占调用方的回合。`cancel` 是让 run 停下来，与盯守无关
 * （盯着的时候从别处取消 run，本动词会在下一跳看到终态 cancelled 并如实回报）。
 *
 * 支撑权限 `actions: write`（D7 已授权）：轮询只读 `GET /actions/runs/{id}` 与它的 jobs，
 * 但本工具整体按写面声明（同工具其它动词会改远端状态），所以本动词也要过审。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, runLine, stateText, conclusionText, fmtDuration } from "../../lib/ci.js";
import {
  taskCapabilityError,
  createSessionTask,
  readTaskRecord,
  updateTask,
  completeTask,
  failTask,
  isTerminalTaskStatus,
  registerPoller,
  releasePoller,
  registerTaskResumer,
  githanaMetaOf,
  taskLog,
} from "../../lib/tasks.js";

export const command = "watch";
export const summary = "Watch a CI run to its terminal state (returns a background task handle; the conclusion is posted back to this session)";

/** 轮询间隔（秒）：默认 15，允许 5~300。CI 以分钟计，取值域按这个量级给。 */
const DEFAULT_INTERVAL_SEC = 15;
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 300;

/** 盯守窗口（秒）：默认 1 小时，允许 1 分钟 ~ 6 小时。到点仍未终结就如实回报，不无限盯。 */
const DEFAULT_WATCH_SEC = 3600;
const MIN_WATCH_SEC = 60;
const MAX_WATCH_SEC = 21600;

/** 元数据里的 kind：恢复实现按它认领记录（见 tools/lib/tasks.js 的 resumePendingTasks）。 */
const TASK_KIND = "run-watch";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("Optional: used to filter out the most recent run when runId is omitted (defaults to the current branch of cwd)"),
  intervalSec: z
    .number()
    .int()
    .min(MIN_INTERVAL_SEC)
    .max(MAX_INTERVAL_SEC)
    .optional()
    .describe("Optional: polling interval in seconds, default " + DEFAULT_INTERVAL_SEC + " (range " + MIN_INTERVAL_SEC + "–" + MAX_INTERVAL_SEC + ")"),
  watchSec: z
    .number()
    .int()
    .min(MIN_WATCH_SEC)
    .max(MAX_WATCH_SEC)
    .optional()
    .describe("Optional: watch window in seconds, default " + DEFAULT_WATCH_SEC + " (range " + MIN_WATCH_SEC + "–" + MAX_WATCH_SEC + "); if it has not reached a terminal state by then, this is reported as-is rather than watching forever"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Start a host background task that watches CI (does not change remote GitHub state): it reads the run state on a timer and posts the conclusion back to this session when the run reaches a terminal state; you can cancel it meanwhile from this session's background task item — confirm repo and run number before running",
  ruleId: "github-toolkit-run-watch",
};

/** 从入参取正整数范围（schema 已闸过，这里只做缺省与兜底）。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 取一次 run 与它的作业（轮询的每一跳都走这里；工具回调的第一跳也复用它）。 */
async function readRun(repo, repoLabel, runId, timeoutSec) {
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest(
    [
      { id: "run", url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(runId)), timeoutMs },
      { id: "jobs", url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(runId) + "/jobs") + "?per_page=100", timeoutMs },
    ],
    { timeoutSec },
  );
  if (!r.ok) return { error: r.message };
  const runRes = r.results.find((x) => x.id === "run");
  const jobsRes = r.results.find((x) => x.id === "jobs");
  if (!runRes || !runRes.ok) {
    if (runRes && runRes.status === 404) return { error: "run #" + runId + " does not exist or is not visible (" + repoLabel + ").", gone: true };
    return { error: describeFailure(runRes, repoLabel) };
  }
  const runJson = runRes.json && typeof runRes.json === "object" ? runRes.json : {};
  const jobs = jobsRes && jobsRes.ok && jobsRes.json && Array.isArray(jobsRes.json.jobs) ? jobsRes.json.jobs : [];
  return { runJson, jobs };
}

/** run 是否已到终态（GitHub 的 run status 只有 queued / in_progress / completed）。 */
function runIsTerminal(runJson) {
  return String((runJson && runJson.status) || "") === "completed";
}

/**
 * 终态结论的可读文本（回投给来源会话的那一份）。
 * 作业那一层是 CI 出问题时真正要看的，所以非成功的作业连同它们的失败步骤都列出来。
 */
function conclusionTextFor(repoLabel, runJson, jobs) {
  const out = [];
  out.push("CI reached a terminal state: run #" + (runJson.id !== undefined ? String(runJson.id) : "?") + " · " + repoLabel);
  out.push("name: " + (runJson.name || runJson.display_title || "(unnamed)"));
  out.push(
    "conclusion: " + String(runJson.conclusion || "?").toUpperCase() +
      (runJson.conclusion ? " (" + conclusionText(runJson.conclusion) + ")" : " (GitHub gave no conclusion)"),
  );
  out.push(
    "branch: " + (runJson.head_branch || "?") + " · event " + (runJson.event || "?") +
      (runJson.run_attempt !== undefined ? " · attempt " + runJson.run_attempt : ""),
  );
  out.push(
    "time: " + (runJson.run_started_at || runJson.created_at || "?") +
      " · took " + fmtDuration(runJson.run_started_at || runJson.created_at, runJson.updated_at),
  );
  if (runJson.html_url) out.push("URL: " + runJson.html_url);
  if (runJson.head_sha) out.push("commit: " + String(runJson.head_sha).slice(0, 7));

  out.push("");
  if (jobs.length === 0) {
    out.push("jobs: 0 (this run has no jobs, or they have not been registered yet)");
  } else {
    const bad = jobs.filter((j) => {
      const c = String((j && j.conclusion) || "");
      return c && c !== "success" && c !== "skipped" && c !== "neutral";
    });
    out.push("jobs: " + jobs.length + (bad.length ? " · " + bad.length + " not successful" : " · all successful / skipped"));
    for (const j of jobs) {
      out.push("  [" + stateText(j) + "] " + ((j && j.name) || "(unnamed)") + " · " + fmtDuration(j && j.started_at, j && j.completed_at));
      const steps = Array.isArray(j && j.steps) ? j.steps : [];
      for (const s of steps) {
        const c = String((s && s.conclusion) || "");
        if (!c || c === "success" || c === "skipped" || c === "neutral") continue;
        out.push("      [" + c.toUpperCase() + "] " + (s.name || "(no step name)"));
      }
    }
  }
  return out.join("\n");
}

/**
 * 起一个轮询器：按 intervalSec 读 run，到终态结算宿主任务。
 *
 * 全程用 setTimeout 串行排下一跳（不 await 在调用链上），所以它不占任何回调；
 * stop 由三处触发——到终态结算完成、盯守窗口到点、宿主任务已终态（用户取消）。
 */
function startWatchPoller({ taskId, repo, repoLabel, runId, intervalSec, watchSec, timeoutSec, deadlineAt }) {
  const state = { stopped: false, timer: null, polls: 0, readErrors: 0, recordErrors: 0, lastPhase: "" };
  const stop = () => {
    state.stopped = true;
    if (state.timer) {
      try {
        clearTimeout(state.timer);
      } catch {
        /* 已清理 */
      }
      state.timer = null;
    }
    releasePoller(taskId);
  };
  registerPoller(taskId, stop);

  const schedule = () => {
    if (state.stopped) return;
    // 下一跳不越过盯守窗口：否则窗口末尾会被一个完整的 interval 拖过去，到点结算晚一整拍。
    const remainMs = deadlineAt - Date.now();
    const delayMs = Math.max(0, Math.min(intervalSec * 1000, remainMs));
    state.timer = setTimeout(() => {
      tick().catch((e) => {
        taskLog("warn", "polling error (task=" + taskId + "): " + describeTaskErrorText(e));
      });
    }, delayMs);
    // 不把这个定时器当成进程存活的条件（App 进程的寿命由宿主决定）。
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  };

  const tick = async () => {
    if (state.stopped) return;

    // 纪律②：会话内取消 → 宿主把任务置为终态。先读记录，已是终态就收摊，不再取数、不结算
    // （对已终结的宿主任务再 complete/fail 只会报错，而且那是用户已经表达的意图）。
    //
    // 读失败（宿主一跳抖动）**不等于**「没取消」：那一次不结算、也不停，下一跳再读。
    // 但连续读不出（任务面已不可用/权限被撤）时不能无限盯——那时停掉并留一行日志，
    // 因为「结论回投」这条承诺的落点已经没了。
    const rec = await readTaskRecord(taskId);
    // stop() 只清 pending timer：本次 tick 若已在飞，await 返回后必须自己让路——实例可能已被
    // dispose，而新实例从 ctx.tasks.list() 恢复了同一条任务、也在 poll，两边同时 settle 会撞。
    if (state.stopped) return;
    if (rec.error) {
      state.recordErrors += 1;
      taskLog("warn", "failed to read the host task record (attempt " + state.recordErrors + ", task=" + taskId + "): " + rec.error);
      if (state.recordErrors >= 3) {
        // 结算尽力而为：任务面若真不可用，这次也会失败——那时只剩日志可留（见 tools/lib/tasks.js）。
        await failTask(
          taskId,
          "watch interrupted: the host task record could not be read repeatedly (the delivery target is unavailable), so polling has stopped.\n" +
            "Last error: " + rec.error + "\n" +
            "For the state right now use githana_run(action=\"view\", runId=" + runId + ").",
        );
        taskLog("warn", "host task record unreadable repeatedly; stopping polling (task=" + taskId + "): the delivery target is unavailable, so fetching more data has no point");
        stop();
        return;
      }
    } else {
      state.recordErrors = 0;
      if (rec.record && isTerminalTaskStatus(rec.record.status)) {
        taskLog("info", "task " + taskId + " is already terminal (" + rec.record.status + ", cancelled in-session) — stopping polling");
        stop();
        return;
      }
    }

    state.polls += 1;
    const cur = await readRun(repo, repoLabel, runId, timeoutSec);
    if (state.stopped) return;
    if (cur.error) {
      // 单跳失败（网络抖动 / 限流）不放弃：记下来继续下一跳，到窗口末尾一并如实回报。
      state.readErrors += 1;
      taskLog("warn", "poll #" + state.polls + " failed to read run #" + runId + ": " + cur.error);
      if (cur.gone) {
        await failTask(taskId, "watch interrupted: run #" + runId + " no longer exists or is not visible on " + repoLabel + " (it may have been deleted).");
        stop();
        return;
      }
    } else {
      // 进度回写（宿主从任务记录派生「后台进程」里的状态与进度）：只在**状态词变化**时写，
      // 不让每一跳都打一次宿主往返。它不唤醒模型，也不改投递档位（见 tools/lib/tasks.js 的 updateTask）。
      const phase = String(cur.runJson.status || "");
      if (phase !== state.lastPhase) {
        state.lastPhase = phase;
        const u = await updateTask(taskId, {
          status: "running",
          progress: { phase: phase || "unknown", repo, runId, polls: state.polls },
        });
        if (u.error) taskLog("warn", "progress write-back failed (task=" + taskId + "): " + u.error);
      }
      // 这次 await 期间可能已被 stop（dispose / 用户取消）：不再往任务面写结算。
      if (state.stopped) return;
      if (runIsTerminal(cur.runJson)) {
        const text = conclusionTextFor(repoLabel, cur.runJson, cur.jobs);
        const res = await completeTask(taskId, {
          githana: {
            action: "watch",
            repo,
            runId: Number(cur.runJson.id !== undefined && cur.runJson.id !== null ? cur.runJson.id : runId),
            status: String(cur.runJson.status || ""),
            conclusion: cur.runJson.conclusion ? String(cur.runJson.conclusion) : null,
            url: cur.runJson.html_url ? String(cur.runJson.html_url) : null,
            polls: state.polls,
            text,
          },
        });
        if (res.error) taskLog("warn", "posting the conclusion back failed (task=" + taskId + "): " + res.error);
        else taskLog("info", "run #" + runId + " conclusion " + String(cur.runJson.conclusion || "?") + " posted back (task=" + taskId + ")");
        stop();
        return;
      }
    }

    if (Date.now() >= deadlineAt) {
      if (state.stopped) return;
      const note = state.readErrors
        ? " (" + state.readErrors + " polls failed to read during this watch — so whether it reaches a terminal state by the end of the window is uncertain)"
        : "";
      await failTask(
        taskId,
        "watch window expired: run #" + runId + " (" + repoLabel + ") did not reach a terminal state within " + watchSec + " seconds" + note + ".\n" +
          "This is not a CI failure; it just means this verb's watch window ended. To keep watching, call githana_run(action=\"watch\", runId=" + runId + ") again, " +
          "and for the state right now use githana_run(action=\"view\", runId=" + runId + ").",
      );
      taskLog("info", "watch window expired (task=" + taskId + ", run=" + runId + ")");
      stop();
      return;
    }

    schedule();
  };

  // 第一跳立刻（0ms）：runId 已定位好，此刻的状态马上就能取到，不必白等一个间隔。
  state.timer = setTimeout(() => {
    tick().catch((e) => {
      taskLog("warn", "polling error (task=" + taskId + "): " + describeTaskErrorText(e));
    });
  }, 0);
  if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  return stop;
}

/** 轮询链路里的异常文本（日志用，永不抛）。 */
function describeTaskErrorText(e) {
  return e && e.message ? String(e.message) : String(e || "unknown error");
}

/**
 * 恢复实现（纪律③）：App 换代后，宿主任务记录里未终结的 run-watch 记录交回这里继续盯。
 * 坐标不够（repo / runId 缺失，如被人改过 metadata）就把任务结算掉——不留下一个永远挂着、
 * 却没有任何东西在推进的任务。
 */
async function resumeWatchTask(record) {
  const taskId = record && record.taskId ? String(record.taskId) : "";
  if (!taskId) return { error: "record is missing taskId" };
  const meta = githanaMetaOf(record) || {};
  const repo = meta.repo ? String(meta.repo) : "";
  const runId = meta.runId !== undefined && meta.runId !== null ? String(meta.runId) : "";
  if (!repo || !runId) {
    await failTask(
      taskId,
      "the watch cannot be resumed: the task record is missing repo / runId (metadata.githana is incomplete)." +
        "Please call githana_run(action=\"watch\") again; for the state right now use githana_run(action=\"view\").",
    );
    return { error: "metadata.githana is missing repo / runId" };
  }
  const intervalSec = clampInt(meta.intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  const watchSec = clampInt(meta.watchSec, DEFAULT_WATCH_SEC, MIN_WATCH_SEC, MAX_WATCH_SEC);
  const stored = Number(meta.deadlineAt);
  const deadlineAt = Number.isFinite(stored) && stored > 0 ? stored : Date.now() + watchSec * 1000;
  startWatchPoller({
    taskId,
    repo,
    repoLabel: repo,
    runId,
    intervalSec,
    watchSec,
    timeoutSec: undefined,
    deadlineAt,
  });
  taskLog("info", "watch resumed (task=" + taskId + ", run #" + runId + ", " + repo + ")");
  return { ok: true };
}

registerTaskResumer(TASK_KIND, resumeWatchTask);

export async function run(input, ctx, { label }) {
  // 两处前置检查放在最前面：它们是「这个动词能不能跑」的判据，比仓库上下文更根本——
  // 先报它们，调用方不会为了一件注定跑不通的事先去修 repo / cwd。
  //
  // ① 能力未授予 → 可读错误，不空转（spec 的 Boundary Conditions）。
  const capErr = taskCapabilityError(label);
  if (capErr) return capErr;

  // ② 来源会话是靠宿主注入的一次性调用令牌绑定的；没有它，「结论回投」这句承诺就是假的。
  const callToken = input && input.context && input.context.callToken ? String(input.context.callToken) : "";
  if (!callToken) {
    return (
      label + " cannot create a background task: this call did not carry the host-injected callToken (which binds the task to the source session).\n" +
      "This verb is only meaningful on the \"model tool call\" path — starting it from elsewhere (such as a page route) has no session to post back to.\n" +
      "What to do now: use githana_run(action=\"view\") to see the run's state right now."
    );
  }

  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  // 建任务之前先取一次现状：一是让 runId 的推断结果可核对，二是不存在的 run 当场报错
  // （建了任务再发现 run 不在，只会留一条空转的宿主记录）。
  const first = await readRun(repo, repoLabel, num, timeoutSec);
  if (first.error) return label + " execution failed: " + first.error;

  const intervalSec = clampInt(input?.intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  const watchSec = clampInt(input?.watchSec, DEFAULT_WATCH_SEC, MIN_WATCH_SEC, MAX_WATCH_SEC);
  const deadlineAt = Date.now() + watchSec * 1000;
  const runTitle = first.runJson.display_title || first.runJson.name || "";

  // 宿主任务记录里的盯守坐标：App 换代后由 resumePendingTasks 读它接回去（纪律③）。
  // 值只用字符串 / 数字 / null：这份 metadata 要过宿主 RPC 与持久化，不放 undefined。
  const githanaMeta = {
    kind: TASK_KIND,
    repo,
    runId: num,
    intervalSec,
    watchSec,
    deadlineAt,
    startedAt: Date.now(),
    url: first.runJson.html_url ? String(first.runJson.html_url) : null,
  };
  const created = await createSessionTask({
    taskLabel: "watch CI #" + num + (runTitle ? ": " + String(runTitle).slice(0, 40) : ""),
    callToken,
    metadata: { githana: githanaMeta },
  });
  if (created.error) return label + " execution failed: " + created.error;

  // 起轮询：本函数**不**等它（纪律①）。
  startWatchPoller({
    taskId: created.taskId,
    repo,
    repoLabel,
    runId: num,
    intervalSec,
    watchSec,
    timeoutSec,
    deadlineAt,
  });

  const out = [
    label + " watch started (" + repoLabel + " · run #" + num + ") — **it does not wait for the conclusion**; this call ends here:",
    "handle: taskId " + created.taskId + " (host background task; delivery=" + String(created.record && created.record.delivery ? created.record.delivery : "next-step") + ")",
    "state right now: " + runLine(first.runJson),
    "polling: reads the run and its jobs every " + intervalSec + " seconds; watch window " + watchSec + " seconds (if it does not finish by then this is reported as-is rather than watching forever)",
    "where the conclusion goes: when the run reaches a terminal state, the host posts the conclusion back to **this session**'s next input point (the next-step tier); you do not have to hold the turn open waiting for it.",
    "to stop it midway: cancel it from this session's background task item — the poller sees the task is terminal and stops (it will fetch no more data and post back nothing more).",
    "for the state right now without waiting: githana_run(action=\"view\", runId=" + num + ").",
  ];
  if (resolved.picked) out.push("note: " + pickedNote(resolved.picked, resolved.branch));
  return out.join("\n");
}
