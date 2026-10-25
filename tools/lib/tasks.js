// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/tasks.js — 宿主后台任务面（`ctx.tasks`）在 App 侧的登记与收口。
 *
 * 需要后台任务的动词（`githana_run(action="watch")`）走这里，而不是各自去摸宿主 ctx：
 * 宿主在 apply(ctx) 里把任务面交进来一次（app.js 调 primeTaskSurface），工具调用时从本单例
 * 同步取用——与 tools/lib/context.js 对 dataDir / 令牌缓存的处理同一形态。
 *
 * ## 宿主任务记录是恢复的唯一事实源
 *
 * 「App 重载后恢复句柄」（spec gh-cli-parity AC10 第三条）靠的就是**宿主自己的任务记录**：
 * 恢复坐标（盯哪个仓库的哪个 run、间隔、截止时刻）写在 `metadata.githana` 里，App 换代后
 * 在 apply 阶段用 `ctx.tasks.list()` 读回来，把未终结的记录逐个交还给注册过的恢复函数
 * （registerTaskResumer / resumePendingTasks）。所以本 App 不落任何私有映射文件——那份文件
 * 会与宿主记录漂移，而宿主记录本身就是权威。
 *
 * `metadata.githana` 是**整块替换**：写入方一律给全量的 githana 对象，不去猜
 * `tasks.update` 的 metadata 是整体替换还是浅合并（宿主契约没写死这一点）。
 *
 * ## 能力未授予时报可读错误，不空转
 *
 * session 范围的后台任务要两项能力：`app/tasks.manage`（建、结算、调度）与
 * `app/session.start-turn`（把结果送进会话、起回合）。前者不授予时 `ctx.tasks` 根本不可用；
 * 后者不授予时**建任务这一跳就会被拒**（错误文本里带 `session.start-turn`）。两种情况都在
 * taskCapabilityError / describeTaskError 里给出「缺什么 + 现在怎么做 + 怎么恢复」，
 * 而不是让调用方以为盯上了却永远收不到结论。
 *
 * 声明与授予是两件事：权限在安装时授予，改清单不就地生效，装完要重启 App。
 *
 * ## 轮询器登记表
 *
 * 进程内的轮询器（定时器）登记在这里，好让 App 卸载 / 重载时一次性停掉（stopAllPollers）——
 * 停掉不等于放弃：宿主任务记录还在，下一个实例会从 list() 里把它接回去继续盯。
 */
/** 元数据命名空间：本 App 写进宿主任务记录的键。 */
export const TASK_META_KEY = "githana";

/** 宿主任务终态（宿主 AppTaskStatus 的四个终结值；其余状态都还能继续）。 */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "canceled", "aborted"];

/** 宿主记录是否已终结。 */
export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(String(status === undefined || status === null ? "" : status));
}

/** 宿主任务面（ctx.tasks）与日志出口；由 app.js 在 apply 里登记。 */
let surface = null;
let logSink = null;

/** 恢复函数表：`metadata.githana.kind` → 恢复实现（由各动词模块在导入时注册）。 */
const resumers = new Map();

/** 进程内轮询器表：taskId → 停止函数（stopAllPollers 用）。 */
const pollers = new Map();

/**
 * 恢复前的准备回调（app.js 登记，指向 tools/lib/context.js 的 initToolContext）。
 *
 * 为什么需要它：恢复发生在 apply 阶段，那时**还没有任何工具调用**，而 GitHub 令牌是
 * initToolContext 首次调用时才解进进程缓存的（DPAPI 解密是异步的）。不先跑这一步，
 * 恢复出来的轮询器第一跳就是「无令牌 → 401」。
 */
let preparer = null;

/** 登记恢复前的准备回调（app.js 在 apply 里调一次）。 */
export function setTaskPreparer(fn) {
  preparer = typeof fn === "function" ? fn : null;
}

/** 登记宿主任务面（app.js 在 apply 里调一次；任务面缺失就登记 null）。 */
export function primeTaskSurface(tasks, log) {
  surface = tasks && typeof tasks === "object" ? tasks : null;
  logSink = typeof log === "function" ? log : null;
}

/**
 * 记一行日志（日志出口由 app.js 给；没有就静默）。
 * 后台链路的失败不该影响工具调用，所以这里永不抛。
 */
export function taskLog(level, message) {
  try {
    if (logSink) logSink(level, "[githana-task] " + String(message));
  } catch {
    /* 日志失败无所谓 */
  }
}

/** 宿主错误文本 → 可读；看起来是能力/权限问题时补一句怎么恢复。 */
function describeTaskError(e) {
  const raw = e && e.message ? String(e.message) : String(e || "unknown error");
  if (/session\.start-turn|start-turn/i.test(raw)) {
    return (
      raw +
      "\n(this is the host saying the \"wake the session\" tier was not granted. Per APPS.md, a session-scope task that delivers its result back needs both" +
      " app/tasks.manage and app/session.start-turn; a delivery tier only decides how the result travels, it does not stand in for the grant." +
      " This manifest declares both — if you are seeing this, the installed copy predates that, so reinstall / restart the App so the capability is granted at install time.)"
    );
  }
  if (/permission|not granted|denie|forbidden|capabilit|EPERM|EACCES/i.test(raw)) {
    return (
      raw +
      "\n(if this is a capability that was not granted: this App needs the manifest capability app/tasks.manage; after changing the manifest you must approve it in the host and reinstall / restart this App.)"
    );
  }
  return raw;
}

/**
 * 宿主未授予后台任务能力时的可读错误（可用的返回 null）。
 * 判据是「任务面上有没有 create」——那是建句柄唯一要走的方法。
 */
export function taskCapabilityError(label) {
  if (surface && typeof surface.create === "function") return null;
  return (
    label + " cannot create a background task: the host has not granted the app/tasks.manage capability (ctx.tasks is unavailable), so this verb does not spin idle.\n" +
    "why it needs that: this verb's shape is \"return a task handle + poll in the background + deliver the terminal state back to the originating session\", and that handle can only be a host background task.\n" +
    "what to do now: use githana_run(action=\"view\", runId=…) to look every so often — that shows the state \"right now\", it does not \"wait for it to finish\".\n" +
    "to restore this verb: make sure the App manifest declares app/tasks.manage, approve that capability in the host, then reinstall / restart this App (capabilities are granted at install time; editing the manifest does not take effect in place)."
  );
}

/** 读一条宿主任务记录里的 `metadata.githana` 对象；没有 / 不是对象返回 null。 */
export function githanaMetaOf(record) {
  const meta = record && typeof record === "object" ? record.metadata : null;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const own = meta[TASK_META_KEY];
  return own && typeof own === "object" && !Array.isArray(own) ? own : null;
}

/**
 * 建一个**会话级**宿主后台任务。
 *
 * 三档显式写出来（不吃隐式默认，宿主改默认值不会悄悄改变本 App 的形状）：
 *   · `scope: "session"`——归属发起它的那个会话；
 *   · `delivery: "next-step"`——结果贴回下一个输入点；
 *   · `chipVisibility: "show"`——对话底部留一个可见的后台任务项（用户的取消入口）。
 *
 * **`callToken` 是必须的**，这里缺它就当场拒：宿主契约里「没有令牌 ⇒ 默认 `scope: "app"`、
 * `delivery` 必为 `"none"`」，而 app 范围的任务**不进任何对话、也不会回投**。那样建出来的任务
 * 永远不会把结论交回来，等于一条静默失败的路径——所以宁可在这里明确报错。
 *
 * @returns {Promise<{ taskId: string, record: object } | { error: string }>}
 */
export async function createSessionTask({ taskLabel, callToken, metadata }) {
  if (!surface || typeof surface.create !== "function") {
    return { error: "host task surface unavailable (app/tasks.manage not granted)." };
  }
  const token = callToken !== undefined && callToken !== null ? String(callToken).trim() : "";
  if (!token) {
    return {
      error:
        "the callToken injected by the host is missing: without it, the created task is app-scoped (delivery=\"none\")," +
        " so it neither enters a conversation nor delivers its result. This verb is only meaningful on the \"model tool call\" path.",
    };
  }
  const input = {
    label: String(taskLabel || "GitHana background task"),
    scope: "session",
    delivery: "next-step",
    chipVisibility: "show",
    callToken: token,
  };
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) input.metadata = metadata;
  try {
    const record = await surface.create(input);
    const taskId = record && record.taskId ? String(record.taskId) : "";
    if (!taskId) {
      return {
        error:
          "host ctx.tasks.create did not return a taskId (contract violation): without a handle, polling will not continue.",
      };
    }
    return { taskId, record };
  } catch (e) {
    return { error: describeTaskError(e) };
  }
}

/**
 * 读一条宿主任务记录（轮询器每轮用它判「用户是否已经取消」）。
 * @returns {Promise<{ record: object|null } | { error: string }>}
 */
export async function readTaskRecord(taskId) {
  if (!surface || typeof surface.get !== "function") {
    return { error: "host task surface unavailable (tasks.get missing)." };
  }
  try {
    const record = await surface.get(String(taskId));
    return { record: record && typeof record === "object" ? record : null };
  } catch (e) {
    return { error: describeTaskError(e) };
  }
}

/**
 * 把任务标成运行中并更新进度（宿主从任务记录派生「后台进程」里的状态与进度）。
 *
 * `update` 只接受非终态值（宿主 AppTaskUpdateInputV2 的 `status` 排除了四个终态），
 * 所以这里只用来报「活着」。它**不**会唤醒模型（APPS.md：「update 的进度只更新任务，
 * 不自动进模型」），也不会改投递档位（那是创建时固定的宿主字段）。
 *
 * @returns {Promise<{ ok: true } | { error: string }>}
 */
export async function updateTask(taskId, patch) {
  if (!surface || typeof surface.update !== "function") {
    return { error: "host task surface unavailable (tasks.update missing)." };
  }
  try {
    await surface.update(String(taskId), patch && typeof patch === "object" ? patch : {});
    return { ok: true };
  } catch (e) {
    return { error: describeTaskError(e) };
  }
}

/**
 * 把任务结算成成功。`result` 由宿主按 delivery 档位交给来源会话（不受本 App 控制）。
 * @returns {Promise<{ ok: true } | { error: string }>}
 */
export async function completeTask(taskId, result) {
  if (!surface || typeof surface.complete !== "function") {
    return { error: "host task surface unavailable (tasks.complete missing)." };
  }
  try {
    await surface.complete(String(taskId), result);
    return { ok: true };
  } catch (e) {
    return { error: describeTaskError(e) };
  }
}

/**
 * 把任务结算成失败（错误文本同样按 delivery 档位回投）。
 * @returns {Promise<{ ok: true } | { error: string }>}
 */
export async function failTask(taskId, error) {
  if (!surface || typeof surface.fail !== "function") {
    return { error: "host task surface unavailable (tasks.fail missing)." };
  }
  try {
    await surface.fail(String(taskId), String(error === undefined || error === null ? "" : error).slice(0, 3000));
    return { ok: true };
  } catch (e) {
    return { error: describeTaskError(e) };
  }
}

/**
 * 登记一个恢复实现：App 换代后，`metadata.githana.kind` 等于它的未终结记录交给它。
 * 同名 kind 覆盖前一个（一个动词只该有一个实现）。
 */
export function registerTaskResumer(kind, fn) {
  const key = String(kind || "");
  if (!key || typeof fn !== "function") return;
  resumers.set(key, fn);
}

/**
 * App 重载后恢复：把宿主任务记录里**未终结且认得**的那些交还给各自的恢复实现。
 *
 * 认得的判据是 `metadata.githana.kind` 在恢复函数表里。不认得的记录（别的 App 不会出现在
 * 自己的 list 里；本 App 的旧记录 / 被人改过 metadata 的）跳过——但记录缺恢复坐标时，
 * 恢复实现自己会把它结算掉，免得宿主任务永远挂着。
 *
 * 只读 scope 缺省（own）的那份 list：`scope: "all"` 要另一项能力，本 App 不申请。
 *
 * @returns {Promise<{ resumed: number }>}
 */
export async function resumePendingTasks() {
  if (!surface || typeof surface.list !== "function") {
    taskLog("info", "host task surface unavailable (app/tasks.manage not granted): skipping recovery of unfinished background tasks");
    return { resumed: 0 };
  }
  // 先把凭据解进进程缓存（首次会跑 DPAPI 解密）：恢复出来的轮询器第一跳就要发请求。
  // 失败不拦——真无凭据时各跳会照常报未授权，任务会走到窗口末尾结算（如实回报，不静默）。
  if (preparer) {
    try {
      await preparer();
    } catch (e) {
      taskLog("warn", "context preparation before recovery failed (continuing): " + describeTaskError(e));
    }
  }
  let rows = null;
  try {
    rows = await surface.list();
  } catch (e) {
    taskLog("warn", "failed to recover background tasks (tasks.list): " + describeTaskError(e));
    return { resumed: 0 };
  }
  if (!Array.isArray(rows)) {
    taskLog("warn", "tasks.list did not return an array: skipping recovery of unfinished background tasks");
    return { resumed: 0 };
  }
  let resumed = 0;
  for (const record of rows) {
    if (!record || typeof record !== "object") continue;
    if (isTerminalTaskStatus(record.status)) continue;
    const meta = githanaMetaOf(record);
    const kind = meta && typeof meta.kind === "string" ? meta.kind : "";
    const resume = resumers.get(kind);
    if (!resume) continue;
    try {
      const res = await resume(record);
      if (res && res.error) taskLog("warn", "recovering task " + String(record.taskId || "?") + " did not complete: " + res.error);
      else resumed += 1;
    } catch (e) {
      taskLog("warn", "recovering task " + String(record.taskId || "?") + " threw: " + describeTaskError(e));
    }
  }
  if (resumed) taskLog("info", "recovered " + resumed + " unfinished background task(s) from the host task records");
  return { resumed };
}

/** 登记一个进程内轮询器的停止函数（同 taskId 覆盖前一个）。 */
export function registerPoller(taskId, stop) {
  const key = String(taskId || "");
  if (!key || typeof stop !== "function") return;
  pollers.set(key, stop);
}

/** 把某条轮询器从登记表里去掉（停止函数自己在停掉时调）。 */
export function releasePoller(taskId) {
  pollers.delete(String(taskId || ""));
}

/**
 * 停掉全部进程内轮询器（App 卸载 / 重载时调）。
 *
 * 只停定时器与在途结算，**不动宿主任务记录**：记录是恢复的事实源，下一个实例会接回去继续盯。
 */
export function stopAllPollers() {
  const entries = [...pollers];
  pollers.clear();
  for (const [, stop] of entries) {
    try {
      stop();
    } catch {
      /* 停止失败无所谓：定时器随进程消亡 */
    }
  }
}
