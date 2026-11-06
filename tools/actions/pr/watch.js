// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/watch：盯一个 PR 的 check-runs 到终态，把结论回投来源会话（githana_pr 动词）。
 *
 * ## 它补的是哪一个洞
 *
 * `githana_run(action="watch")` 盯的是 **Actions run**（`GET /actions/runs/{id}`）。PR 上的检查
 * 有两套来源：Actions 跑出来的 check-run，和 GitHub App（CodeRabbit、SonarCloud、DCO 之类）
 * 自己注册的 check-run。后者**没有对应的 workflow run**，所以 run 那条 watch 覆盖不到它——
 * 而「等审查机器人出结论」恰恰是最常要等的那一类。本动词盯的是 PR head 上**全部** check-run
 * （`GET /commits/{sha}/check-runs`），两套来源一视同仁。
 *
 * ## 与 `checks` / `run watch` 的分界
 *
 *   · `checks` 报的是**此刻**的清单（要「等」就自己隔一会儿再看一次）；
 *   · 本动词报的是**到终态那一刻**的结论，不占调用方的回合；
 *   · `run watch` 盯一条 run 的 jobs/steps（CI 内部的失败步骤在那里最清楚），本动词盯 PR 的
 *     检查集合（哪个 App 卡住、哪个没过）。
 *
 * ## 盯的是「PR 当前 head」，不是「一开始那个提交」
 *
 * check-run 挂在 commit 上，而 PR 的 head 会因为新推送而变。每跳先读 `GET /pulls/{n}` 取
 * 当前 head sha，与上一跳不同就把盯守坐标换过去并重新起算宽限期——推了新提交之后仍然等旧
 * 提交的检查，是「等一个不会再变的结果」。结论里如实写明跟过几次 head 变化。
 *
 * ## 空集不是「通过」，刚看到集合也不等于「等完了」
 *
 * 两道时间闸，各挡一个反向的错误：
 *
 *   · **空集宽限 `graceSec`**：App 注册 check-run 是异步的，PR 刚建或刚推送时 head 上可能一条都没有。
 *     空集在宽限期里继续等，过了才结算成「没有可等的东西」（不是失败）——实测过：PR 建完之后
 *     check-run 会晚几十秒到几分钟才出现。
 *   · **结算静默期 `settleSec`**：Actions 的 check-run 在 push 时立刻注册、往往先跑完，而 App 的
 *     检查可能几十秒后才到。没有这一层，PR 上只有 CI 一条已完结时就会当场报 PASSED，把后面的
 *     审查机器人整个漏掉。所以结算前要求「已见集合连续 `settleSec` 秒没有新成员」。
 *
 * ## 返回契约：任务句柄，不是结论
 *
 * 与 `run watch` 同一形状（spec gh-cli-parity AC10 的三条纪律同样落在这里）：
 *
 *   1. **工具回调内不等**：`run()` 只做「定位 PR + 取一次现状 + 建任务」三次短调用，轮询跑在
 *      setTimeout 里，从不被回调 await。
 *   2. **会话内取消即停**：每跳先读宿主任务记录，已是终态就不再取数、不再结算。
 *   3. **App 重载后恢复**：盯守坐标写在 `metadata.githana`，`registerTaskResumer` 登记恢复实现，
 *      app.js 的 apply 阶段用 `resumePendingTasks()` 接回去。不落私有状态文件。
 *
 * 支撑权限：`checks: read`（轮询只读 check-runs）与 `pull_requests: read`（读 PR 取 head）。
 * 本工具整体按写面声明（同工具其它动词会改远端状态），所以本动词也要过审。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import {
  resolveContext,
  resolvePrNumber,
  describeFailure,
  prStateText,
  summarizeCheckRuns,
  checkConclusionText,
  checkRunIsTerminal,
} from "../../lib/pr.js";
import { fmtDuration } from "../../lib/ci.js";
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
export const summary =
  "Watch a PR's check-runs (GitHub Actions checks and GitHub App checks alike) to their terminal state (returns a background task handle; the conclusion is posted back to this session)";

/** 轮询间隔（秒）：check-run 由外部 App 驱动，节拍比 Actions run 松一档；允许 5~300。 */
const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 300;

/** 盯守窗口（秒）：默认 1 小时，允许 1 分钟 ~ 6 小时。到点仍未终结就如实回报，不无限盯。 */
const DEFAULT_WATCH_SEC = 3600;
const MIN_WATCH_SEC = 60;
const MAX_WATCH_SEC = 21600;

/** 空集宽限期（秒）：head 上一条 check-run 都没有时等它出现多久，默认 180，允许 0~1800。 */
const DEFAULT_GRACE_SEC = 180;
const MIN_GRACE_SEC = 0;
const MAX_GRACE_SEC = 1800;

/**
 * 结算前的静默期（秒）：最后一条新检查出现后还要没有新成员多久才结算，默认 30，允许 0~600。
 *
 * 这条挡的是「刚看到集合就结算」：Actions 的 check-run 在 push 时立刻注册、往往先跑完，而
 * GitHub App 的检查可能几十秒后才注册。没有静默期，PR 上只有 CI 一条已完结时就会当场报
 * PASSED，把后面的审查机器人整个漏掉。取 0 关闭（想「现在有什么就算什么」的调用方用 checks）。
 */
const DEFAULT_SETTLE_SEC = 30;
const MIN_SETTLE_SEC = 0;
const MAX_SETTLE_SEC = 600;

/** 元数据里的 kind：恢复实现按它认领记录（见 tools/lib/tasks.js 的 resumePendingTasks）。 */
const TASK_KIND = "pr-checks-watch";

/** 算作「通过」的结论。neutral / skipped 不是失败，把它们算进失败会把「能不能合」判反。 */
const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  checkName: z
    .string()
    .optional()
    .describe(
      "Optional: only watch check-runs whose name contains this text (case-insensitive substring, e.g. \"CodeRabbit\"); when omitted every check-run on the head is watched",
    ),
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
    .describe(
      "Optional: watch window in seconds, default " + DEFAULT_WATCH_SEC + " (range " + MIN_WATCH_SEC + "–" + MAX_WATCH_SEC +
        "); if the checks have not reached a terminal state by then, this is reported as-is rather than watching forever",
    ),
  graceSec: z
    .number()
    .int()
    .min(MIN_GRACE_SEC)
    .max(MAX_GRACE_SEC)
    .optional()
    .describe(
      "Optional: how long to wait for check-runs to appear on the head when there are none yet, default " + DEFAULT_GRACE_SEC +
        " (range " + MIN_GRACE_SEC + "–" + MAX_GRACE_SEC + "); GitHub Apps register their check-runs asynchronously, so an empty list right after a push is normal",
    ),
  settleSec: z
    .number()
    .int()
    .min(MIN_SETTLE_SEC)
    .max(MAX_SETTLE_SEC)
    .optional()
    .describe(
      "Optional: quiet period in seconds before settling once every check-run has finished, default " + DEFAULT_SETTLE_SEC +
        " (range " + MIN_SETTLE_SEC + "–" + MAX_SETTLE_SEC + "); it guards against declaring PASSED before a slow GitHub App has registered its check-run, and 0 turns it off",
    ),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_pr",
  summary:
    "Start a host background task that watches a PR's check-runs (Actions checks and GitHub App checks alike) to their terminal state (does not change remote GitHub state): it reads the PR head and its check-runs on a timer and posts the conclusion back to this session; you can cancel it meanwhile from this session's background task item — confirm repo and PR number before running",
  ruleId: "github-toolkit-pr-watch",
};

/** 从入参取整数范围（schema 已闸过，这里只做缺省与兜底）。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 轮询链路里的异常文本（日志用，永不抛）。 */
function describeTaskErrorText(e) {
  return e && e.message ? String(e.message) : String(e || "unknown error");
}

/** 读 PR 本体（轮询每跳都要它：head sha 会变，PR 状态也会变）。 */
async function readPr(repo, repoLabel, prNumber, timeoutSec) {
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest([{ url: apiUrl(repo, "/pulls/" + encodeURIComponent(prNumber)), timeoutMs }], { timeoutSec });
  if (!r.ok) return { error: r.message };
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return { error: "PR #" + prNumber + " does not exist or is not visible (" + repoLabel + ").", gone: true };
    }
    return { error: describeFailure(res, repoLabel) };
  }
  return { pr: res.json && typeof res.json === "object" ? res.json : {} };
}

/** 读某个 commit 的 check-runs（一页 100 条，信封里的 total_count 用于如实报截断）。 */
async function readChecks(repo, repoLabel, sha, timeoutSec) {
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest(
    [{ url: apiUrl(repo, "/commits/" + encodeURIComponent(sha) + "/check-runs") + "?per_page=100", timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return { error: r.message };
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return { error: "the commit " + String(sha).slice(0, 7) + " or its check-runs are not visible (" + repoLabel + ")." };
    return { error: describeFailure(res, repoLabel) };
  }
  return { json: res.json && typeof res.json === "object" ? res.json : {} };
}

/** 按 checkName 过滤（子串、不区分大小写；空过滤返回全部）。 */
function selectChecks(runs, filter) {
  if (!filter) return runs;
  return runs.filter((run) => String((run && run.name) || "").toLowerCase().includes(filter));
}

/** 计数：未终结的算 pending，终结的按通过 / 未通过分两堆。 */
function countChecks(runs) {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of runs) {
    if (!checkRunIsTerminal(run)) {
      pending += 1;
      continue;
    }
    const conclusion = run && run.conclusion ? String(run.conclusion) : "";
    if (PASS_CONCLUSIONS.has(conclusion)) passed += 1;
    else failed += 1;
  }
  return { total: runs.length, passed, failed, pending };
}

/** 一行计数摘要（回执与结论共用同一份措辞）。 */
function countsLine(counts) {
  return "total " + counts.total + " (passed " + counts.passed + " · failed " + counts.failed + " · pending " + counts.pending + ")";
}

/** head 上那一行坐标（分支、sha 短号）。 */
function headLine(pr) {
  const headRef = pr && pr.head && pr.head.ref ? String(pr.head.ref) : "?";
  const baseRef = pr && pr.base && pr.base.ref ? String(pr.base.ref) : "?";
  const sha = pr && pr.head && pr.head.sha ? String(pr.head.sha) : "";
  return headRef + " → " + baseRef + (sha ? " (" + sha.slice(0, 7) + ")" : "");
}

/** 单条 check-run 的渲染：结论 / 名字 / 来源 App / 时长，附详情链接。 */
function renderCheckItem(run, indent) {
  const pad = indent || "  ";
  const name = run && run.name ? String(run.name) : "(unnamed)";
  const app = run && run.app && run.app.name ? String(run.app.name) : "";
  const dur = run && checkRunIsTerminal(run) ? fmtDuration(run.started_at, run.completed_at || run.started_at) : "";
  const head = "[" + checkConclusionText(run) + "] " + name + (app ? " · " + app : "") + (dur ? " · " + dur : "");
  const url = run && (run.details_url || run.html_url) ? String(run.details_url || run.html_url) : "";
  const out = [pad + head];
  if (url) out.push(pad + "    " + url);
  return out;
}

/** 排序：未通过 / 未完成的排前面（一眼看到要处理的那几条），其余保持原序。 */
function sortForReport(runs) {
  const bad = [];
  const good = [];
  for (const run of runs) {
    if (!checkRunIsTerminal(run)) bad.push(run);
    else if (PASS_CONCLUSIONS.has(String(run.conclusion || ""))) good.push(run);
    else bad.push(run);
  }
  return bad.concat(good);
}

/**
 * 终态结论的可读文本（回投给来源会话的那一份）。
 *
 * 先给判断（能不能合），再给逐条明细；truncated 与 head 变化都如实写在里面，不让调用方以为
 * 看到的是全量、或者以为盯的一直是最初那个提交。
 */
function conclusionTextFor({ prNumber, repoLabel, pr, headChanges, filter, runs, counts, pageSize, totalCount }) {
  const out = [];
  out.push("PR checks reached a terminal state: PR #" + prNumber + " · " + repoLabel + " · " + headLine(pr));
  out.push(
    counts.failed > 0
      ? "overall: NOT PASSING (" + counts.failed + " of " + counts.total + " did not pass)"
      : "overall: PASSED (every check-run passed, was neutral or was skipped)",
  );
  out.push("PR state: " + prStateText(pr) + " · checks: " + countsLine(counts));
  if (filter) out.push("filter: only check-runs whose name contains \"" + filter + "\"");
  if (headChanges > 0) out.push("note: the PR head moved " + headChanges + " time(s) during the watch; what is reported is the head as of the last poll");
  if (totalCount > pageSize) {
    out.push(
      "note: GitHub reports " + totalCount + " check-runs on this commit but one page holds " + pageSize +
        "; the counts above cover only the fetched page (use githana_api with paginate=true to dig further)",
    );
  }
  out.push("");
  for (const run of sortForReport(runs)) {
    for (const line of renderCheckItem(run)) out.push(line);
  }
  out.push("");
  out.push("note: these are check-runs (GitHub Actions and App checks); legacy commit statuses are not included.");
  return out.join("\n");
}

/**
 * 起一个轮询器：按 intervalSec 读 PR head 与它的 check-runs，全终结时结算宿主任务。
 *
 * 全程用 setTimeout 串行排下一跳（不 await 在调用链上），所以它不占任何回调；stop 由三处触发
 * ——到终态结算完成、盯守窗口到点、宿主任务已终态（用户取消）。
 */
function startWatchPoller({
  taskId,
  repo,
  repoLabel,
  prNumber,
  checkName,
  intervalSec,
  watchSec,
  graceSec,
  settleSec,
  timeoutSec,
  deadlineAt,
  headSha,
  baseMeta,
}) {
  const state = {
    stopped: false,
    timer: null,
    polls: 0,
    readErrors: 0,
    recordErrors: 0,
    lastPhase: "",
    headSha: headSha ? String(headSha) : "",
    headChanges: 0,
    // 宽限期起算点：这次盯守里「head 上没有（匹配的）check-run」从何时开始算。
    // head 变化时重置——新提交的检查是另一批，等它出现的时间要从头给。
    noChecksSince: Date.now(),
    // 已见过的 check-run（id → 无名时用名字）与最后一条新成员出现的时间：结算前的静默期靠它判。
    seenIds: new Set(),
    lastNewAt: Date.now(),
    lastRuns: [],
    lastPr: null,
  };
  const meta = baseMeta && typeof baseMeta === "object" ? baseMeta : {};

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

  const schedule = (delayMs) => {
    if (state.stopped) return;
    // 下一跳不越过盯守窗口：否则窗口末尾会被一个完整的 interval 拖过去，到点结算晚一整拍。
    const remainMs = deadlineAt - Date.now();
    const wanted = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : intervalSec * 1000;
    const delay = Math.max(0, Math.min(wanted, remainMs));
    state.timer = setTimeout(() => {
      tick().catch((e) => {
        taskLog("warn", "polling error (task=" + taskId + "): " + describeTaskErrorText(e));
      });
    }, delay);
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  };

  /** 只在**变化**时写一次宿主记录（每跳都写等于每跳打一次宿主往返，收益为零）。 */
  const writeState = async (phase) => {
    const changedPhase = phase !== state.lastPhase;
    const changedHead = meta.headSha !== state.headSha;
    if (!changedPhase && !changedHead) return;
    state.lastPhase = phase;
    meta.headSha = state.headSha;
    const u = await updateTask(taskId, {
      status: "running",
      progress: { phase, repo, prNumber, headSha: state.headSha, polls: state.polls },
      metadata: { githana: meta },
    });
    if (u.error) taskLog("warn", "progress write-back failed (task=" + taskId + "): " + u.error);
  };

  const tick = async () => {
    if (state.stopped) return;
    // 下一跳的延迟：默认一个间距，结算前的静默期里会缩到「只等剩下那点」。
    let nextDelayMs = intervalSec * 1000;

    // 纪律②：会话内取消 → 宿主把任务置为终态。先读记录，已是终态就收摊。
    // 读失败（宿主一跳抖动）不等于「没取消」：那一跳不结算也不停，下一跳再读；连续读不出
    // （任务面不可用 / 权限被撤）时不能无限盯——回投的落点已经没了。
    const rec = await readTaskRecord(taskId);
    if (state.stopped) return;
    if (rec.error) {
      state.recordErrors += 1;
      taskLog("warn", "failed to read the host task record (attempt " + state.recordErrors + ", task=" + taskId + "): " + rec.error);
      if (state.recordErrors >= 3) {
        await failTask(
          taskId,
          "watch interrupted: the host task record could not be read repeatedly (the delivery target is unavailable), so polling has stopped.\n" +
            "Last error: " + rec.error + "\n" +
            "For the state right now use githana_pr(action=\"checks\", prNumber=" + prNumber + ").",
        );
        taskLog("warn", "host task record unreadable repeatedly; stopping polling (task=" + taskId + ")");
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

    // 先读 PR：head sha 会随新推送而变，盯着旧提交的检查等于等一个不会再变的结果。
    const prRes = await readPr(repo, repoLabel, prNumber, timeoutSec);
    if (state.stopped) return;
    if (prRes.error) {
      state.readErrors += 1;
      taskLog("warn", "poll #" + state.polls + " failed to read PR #" + prNumber + ": " + prRes.error);
      if (prRes.gone) {
        await failTask(taskId, "watch interrupted: PR #" + prNumber + " no longer exists or is not visible on " + repoLabel + ".");
        stop();
        return;
      }
    } else {
      const pr = prRes.pr;
      const sha = pr.head && pr.head.sha ? String(pr.head.sha) : "";
      if (sha && sha !== state.headSha) {
        if (state.headSha) {
          state.headChanges += 1;
          taskLog("info", "PR #" + prNumber + " head moved from " + state.headSha.slice(0, 7) + " to " + sha.slice(0, 7) + "; following the new head");
        }
        state.headSha = sha;
        state.noChecksSince = Date.now();
        // 新 head 上的检查是另一批：已见集清空，静默期从这一刻重新起算。
        state.seenIds.clear();
        state.lastNewAt = Date.now();
      }
      state.lastPr = pr;

      const ckRes = await readChecks(repo, repoLabel, state.headSha, timeoutSec);
      if (state.stopped) return;
      if (ckRes.error) {
        state.readErrors += 1;
        taskLog("warn", "poll #" + state.polls + " failed to read check-runs of " + state.headSha.slice(0, 7) + ": " + ckRes.error);
      } else {
        const raw = ckRes.json && Array.isArray(ckRes.json.check_runs) ? ckRes.json.check_runs : [];
        const runs = selectChecks(raw, checkName);
        const counts = countChecks(runs);
        const summary = summarizeCheckRuns(ckRes.json);
        state.lastRuns = runs;

        // 先记账新成员：结算前的静默期就是靠「最后一条新检查什么时候出现」判的。
        // id 是 check-run 的稳定主键；极罕见地缺 id 时退回用名字（同名也算同一批）。
        let sawNew = false;
        for (const run of runs) {
          const key = run && run.id !== undefined && run.id !== null ? "id:" + String(run.id) : "name:" + String((run && run.name) || "");
          if (!state.seenIds.has(key)) {
            state.seenIds.add(key);
            sawNew = true;
          }
        }
        if (sawNew) state.lastNewAt = Date.now();

        // 空集：App 注册 check-run 是异步的，宽限期里继续等，过了才结算成「没有可等的东西」。
        if (counts.total === 0) {
          const waitedMs = Date.now() - state.noChecksSince;
          if (waitedMs < graceSec * 1000) {
            await writeState("waiting for check-runs to appear");
            if (state.stopped) return;
          } else {
            const text = [
              "nothing to watch: PR #" + prNumber + " · " + repoLabel + " · " + headLine(pr) +
                " has no check-run" + (checkName ? " whose name contains \"" + checkName + "\"" : "") +
                " (waited " + graceSec + " seconds for some to appear).",
              "This is not a failure: nothing is registered on this commit yet, so there is no CI state to wait for.",
              "If a check is expected (a GitHub App may register it later), call githana_pr(action=\"watch\", prNumber=" + prNumber + ") again; " +
                "for a list right now use githana_pr(action=\"checks\", prNumber=" + prNumber + ").",
            ].join("\n");
            const res = await completeTask(taskId, {
              githana: { action: "watch", repo, prNumber: Number(prNumber), headSha: state.headSha, total: 0, polled: state.polls, text },
            });
            if (res.error) taskLog("warn", "posting the result back failed (task=" + taskId + "): " + res.error);
            stop();
            return;
          }
        } else if (counts.pending > 0) {
          // 还有没跑完的：写进度，继续下一跳。
          await writeState(counts.passed + " passed · " + counts.failed + " failed · " + counts.pending + " pending");
          if (state.stopped) return;
        } else {
          // 全终结了，但还要等静默期：晚注册的检查（App 的 check-run 可能几十秒后才出现）不能漏。
          const quietMs = Date.now() - state.lastNewAt;
          const settleMs = settleSec * 1000;
          if (quietMs < settleMs) {
            await writeState("all check-runs finished; holding " + settleSec + "s for late-registered ones");
            if (state.stopped) return;
            // 下一跳卡在静默期结束时，不必白等一个完整间距。
            nextDelayMs = Math.max(1000, Math.min(intervalSec * 1000, settleMs - quietMs));
          } else {
            // 结算。这一跳的 await 期间可能已被 stop（dispose / 用户取消），不再写结算。
            const text = conclusionTextFor({
              prNumber,
              repoLabel,
              pr,
              headChanges: state.headChanges,
              filter: checkName,
              runs,
              counts,
              pageSize: raw.length,
              totalCount: summary.totalCount,
            });
            const res = await completeTask(taskId, {
              githana: {
                action: "watch",
                repo,
                prNumber: Number(prNumber),
                headSha: state.headSha,
                status: "completed",
                conclusion: counts.failed > 0 ? "failure" : "success",
                passed: counts.passed,
                failed: counts.failed,
                total: counts.total,
                polled: state.polls,
                text,
              },
            });
            if (res.error) taskLog("warn", "posting the conclusion back failed (task=" + taskId + "): " + res.error);
            else {
              taskLog(
                "info",
                "PR #" + prNumber + " checks settled (" + counts.passed + " passed / " + counts.failed + " failed / " + counts.total + " total, task=" + taskId + ")",
              );
            }
            stop();
            return;
          }
        }
      }
    }

    if (Date.now() >= deadlineAt) {
      if (state.stopped) return;
      // 先分清「真的没跑完」与「都跑完了、只差静默期没走完」：后者不能报成「窗口内没跑完」。
      const pendingRuns = Array.isArray(state.lastRuns) ? state.lastRuns.filter((run) => !checkRunIsTerminal(run)) : [];
      if (state.lastRuns.length > 0 && pendingRuns.length === 0) {
        const counts = countChecks(state.lastRuns);
        const text = [
          conclusionTextFor({
            prNumber,
            repoLabel,
            pr: state.lastPr || {},
            headChanges: state.headChanges,
            filter: checkName,
            runs: state.lastRuns,
            counts,
            pageSize: state.lastRuns.length,
            totalCount: state.lastRuns.length,
          }),
          "",
          "note: the watch window ended before the settle period finished (" + settleSec + " seconds without a newly registered check-run); " +
            "every check-run visible on the head already had a conclusion when the window ended.",
        ].join("\n");
        const settled = await completeTask(taskId, {
          githana: {
            action: "watch",
            repo,
            prNumber: Number(prNumber),
            headSha: state.headSha,
            status: "completed",
            conclusion: counts.failed > 0 ? "failure" : "success",
            passed: counts.passed,
            failed: counts.failed,
            total: counts.total,
            polled: state.polls,
            text,
          },
        });
        if (settled.error) taskLog("warn", "posting the conclusion back failed (task=" + taskId + "): " + settled.error);
        stop();
        return;
      }
      const note = state.readErrors
        ? " (" + state.readErrors + " polls failed to read during this watch, so whether they reach a terminal state by the end of the window is uncertain)"
        : "";
      const lines = [
        "watch window expired: PR #" + prNumber + " (" + repoLabel + ") still had check-runs that had not finished within " + watchSec + " seconds" + note + ".",
      ];
      if (pendingRuns.length) {
        lines.push("still not finished at the end of the window:");
        for (const run of pendingRuns) for (const line of renderCheckItem(run)) lines.push(line);
      }
      lines.push(
        "This is not a CI failure; it just means this verb's watch window ended. To keep watching, call githana_pr(action=\"watch\", prNumber=" + prNumber + ") again, " +
          "and for the state right now use githana_pr(action=\"checks\", prNumber=" + prNumber + ").",
      );
      await failTask(taskId, lines.join("\n"));
      taskLog("info", "watch window expired (task=" + taskId + ", PR #" + prNumber + ")");
      stop();
      return;
    }

    schedule(nextDelayMs);
  };

  // 第一跳立刻（0ms）：坐标已经定位好，此刻的状态马上就能取到，不必白等一个间隔。
  state.timer = setTimeout(() => {
    tick().catch((e) => {
      taskLog("warn", "polling error (task=" + taskId + "): " + describeTaskErrorText(e));
    });
  }, 0);
  if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  return stop;
}

/**
 * 恢复实现（纪律③）：App 换代后，宿主任务记录里未终结的 pr-checks-watch 记录交回这里继续盯。
 * 坐标不够（repo / prNumber 缺失）就把任务结算掉——不留下一个永远挂着却没人推进的任务。
 */
async function resumeWatchTask(record) {
  const taskId = record && record.taskId ? String(record.taskId) : "";
  if (!taskId) return { error: "record is missing taskId" };
  const meta = githanaMetaOf(record) || {};
  const repo = meta.repo ? String(meta.repo) : "";
  const prNumber = meta.prNumber !== undefined && meta.prNumber !== null ? String(meta.prNumber) : "";
  if (!repo || !prNumber) {
    await failTask(
      taskId,
      "the watch cannot be resumed: the task record is missing repo / prNumber (metadata.githana is incomplete). " +
        "Please call githana_pr(action=\"watch\") again; for the state right now use githana_pr(action=\"checks\").",
    );
    return { error: "metadata.githana is missing repo / prNumber" };
  }
  const intervalSec = clampInt(meta.intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  const watchSec = clampInt(meta.watchSec, DEFAULT_WATCH_SEC, MIN_WATCH_SEC, MAX_WATCH_SEC);
  const graceSec = clampInt(meta.graceSec, DEFAULT_GRACE_SEC, MIN_GRACE_SEC, MAX_GRACE_SEC);
  const settleSec = clampInt(meta.settleSec, DEFAULT_SETTLE_SEC, MIN_SETTLE_SEC, MAX_SETTLE_SEC);
  const stored = Number(meta.deadlineAt);
  const deadlineAt = Number.isFinite(stored) && stored > 0 ? stored : Date.now() + watchSec * 1000;
  startWatchPoller({
    taskId,
    repo,
    repoLabel: repo,
    prNumber,
    checkName: meta.checkName ? String(meta.checkName) : "",
    intervalSec,
    watchSec,
    graceSec,
    settleSec,
    timeoutSec: undefined,
    deadlineAt,
    headSha: meta.headSha ? String(meta.headSha) : "",
    baseMeta: { ...meta },
  });
  taskLog("info", "PR checks watch resumed (task=" + taskId + ", PR #" + prNumber + ", " + repo + ")");
  return { ok: true };
}

registerTaskResumer(TASK_KIND, resumeWatchTask);

export async function run(input, ctx, { label }) {
  // 两处前置检查放在最前面：它们是「这个动词能不能跑」的判据，比仓库上下文更根本。
  //
  // ① 能力未授予 → 可读错误，不空转。
  const capErr = taskCapabilityError(label);
  if (capErr) return capErr;

  // ② 来源会话是靠宿主注入的一次性调用令牌绑定的；没有它，「结论回投」这句承诺就是假的。
  const callToken = input && input.context && input.context.callToken ? String(input.context.callToken) : "";
  if (!callToken) {
    return (
      label + " cannot create a background task: this call did not carry the host-injected callToken (which binds the task to the source session).\n" +
      "This verb is only meaningful on the \"model tool call\" path — starting it from elsewhere (such as a page route) has no session to post back to.\n" +
      "What to do now: use githana_pr(action=\"checks\") to see the check state right now."
    );
  }

  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const prNumber = numRes.prNumber;

  const rawFilter = input && input.checkName !== undefined && input.checkName !== null ? String(input.checkName).trim() : "";
  const checkName = rawFilter ? rawFilter.toLowerCase() : "";

  const intervalSec = clampInt(input?.intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  const watchSec = clampInt(input?.watchSec, DEFAULT_WATCH_SEC, MIN_WATCH_SEC, MAX_WATCH_SEC);
  const graceSec = clampInt(input?.graceSec, DEFAULT_GRACE_SEC, MIN_GRACE_SEC, MAX_GRACE_SEC);
  const settleSec = clampInt(input?.settleSec, DEFAULT_SETTLE_SEC, MIN_SETTLE_SEC, MAX_SETTLE_SEC);

  // 建任务之前先取一次现状：一是让步数推断可核对，二是不存在的 PR / 取不到 head 当场报错
  // （建了任务再发现盯不了，只会留一条空转的宿主记录）。
  const first = await readPr(repo, repoLabel, prNumber, timeoutSec);
  if (first.error) return label + " execution failed: " + first.error;
  const pr = first.pr;
  const headSha = pr.head && pr.head.sha ? String(pr.head.sha) : "";
  if (!headSha) {
    return label + ": the response for PR #" + prNumber + " has no head.sha, so its checks cannot be watched (" + repoLabel + ").";
  }
  const firstChecks = await readChecks(repo, repoLabel, headSha, timeoutSec);
  if (firstChecks.error) return label + " execution failed: " + firstChecks.error;
  const firstRuns = selectChecks(
    firstChecks.json && Array.isArray(firstChecks.json.check_runs) ? firstChecks.json.check_runs : [],
    checkName,
  );
  const firstCounts = countChecks(firstRuns);

  const deadlineAt = Date.now() + watchSec * 1000;

  // 宿主任务记录里的盯守坐标：App 换代后由 resumePendingTasks 读它接回去（纪律③）。
  // 值只用字符串 / 数字 / null：这份 metadata 要过宿主 RPC 与持久化，不放 undefined。
  const githanaMeta = {
    kind: TASK_KIND,
    repo,
    prNumber: Number(prNumber),
    headSha,
    checkName: checkName || null,
    intervalSec,
    watchSec,
    graceSec,
    settleSec,
    deadlineAt,
    startedAt: Date.now(),
    url: pr.html_url ? String(pr.html_url) : null,
  };
  const created = await createSessionTask({
    taskLabel: "watch PR #" + prNumber + " checks" + (rawFilter ? " (" + rawFilter.slice(0, 24) + ")" : ""),
    callToken,
    metadata: { githana: githanaMeta },
  });
  if (created.error) return label + " execution failed: " + created.error;

  // 起轮询：本函数**不**等它（纪律①）。
  startWatchPoller({
    taskId: created.taskId,
    repo,
    repoLabel,
    prNumber,
    checkName,
    intervalSec,
    watchSec,
    graceSec,
    settleSec,
    timeoutSec,
    deadlineAt,
    headSha,
    baseMeta: githanaMeta,
  });

  const out = [
    label + " watch started (" + repoLabel + " · PR #" + prNumber + ") — **it does not wait for the conclusion**; this call ends here:",
    "handle: taskId " + created.taskId + " (host background task; delivery=" + String(created.record && created.record.delivery ? created.record.delivery : "next-step") + ")",
    "state right now: " + prStateText(pr) + " · " + headLine(pr),
    "checks right now: " + (firstCounts.total === 0 ? "none on this head yet" : countsLine(firstCounts)),
    checkName
      ? "filter: only check-runs whose name contains \"" + rawFilter + "\""
      : "scope: every check-run on the head (GitHub Actions checks and GitHub App checks alike)",
    "polling: reads the PR head and its check-runs every " + intervalSec + " seconds; watch window " + watchSec + " seconds" +
      (graceSec > 0 ? "; if the head has no check-runs yet it waits up to " + graceSec + " seconds for some to appear" : "") +
      (settleSec > 0 ? "; once every check-run has finished it holds " + settleSec + " seconds more so a slow GitHub App's check-run is not missed" : ""),
    "where the conclusion goes: when every check-run reaches a terminal state, the host posts the conclusion back to **this session**'s next input point (the next-step tier); you do not have to hold the turn open waiting for it.",
    "to stop it midway: cancel it from this session's background task item — the poller sees the task is terminal and stops (it will fetch no more data and post back nothing more).",
    "for the state right now without waiting: githana_pr(action=\"checks\", prNumber=" + prNumber + ").",
  ];
  if (firstCounts.total > 0 && firstCounts.pending === 0) {
    out.push("note: every check-run on this head already has a conclusion, so the poller will settle as soon as it runs its first tick.");
  }
  return out.join("\n");
}
