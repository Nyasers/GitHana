// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2023 Nyasers

/**
 * tools/lib/transfer-task.js — 把「下载到本地盘」跑成宿主后台任务。
 *
 * ## 为什么要后台任务而不是在回调里等
 *
 * 宿主工具回调有 30 秒硬上限（`RPC callback.tools.execute timed out after 30000ms`）。
 * 下载的耗时与文件大小成正比，与网络质量成反比，任何固定的「一次 RPC 写完再返回」在
 * 大资产上都会撞线——而撞线的后果不是「慢」，是**调用方拿不到回执**：字节可能已经落盘
 * （worker 是流式写的），可是「成了还是败了」这句话永远说不出口。实测从 CI 拉一版
 * 31.5 MB 的发布包就是这样：文件完整躺在那里，回执超时，调用方只能靠自己去盘上看。
 *
 * 所以下载与 `githana_run(action="watch")` 同形：建一个宿主后台任务，把下载丢到后台，
 * 立刻返回句柄；下载结束（无论成败）用 `complete` / `fail` 结算，宿主按 `next-step`
 * 档位把结论贴回来源会话。
 *
 * ## 与 watch 的差别：不需轮询，但同样要能被取消与恢复
 *
 * watch 盯的是远端状态，所以要定时读；下载是一次性的长 RPC，没有「中间态」可查——
 * 进度只能来自 worker，而 `callRest` 的 `toFile` 通道目前不回报中间进度。因此这里
 * 只在**开始**与**每个文件完成**时写一次 progress，让任务 chip 上能看到「在跑、第几个」，
 * 不去伪造百分比。
 *
 * ## 取消
 *
 * 每一跳之前读一次宿主任务记录：用户从会话底部的任务项取消后，记录转终态，本进程
 * 不再发下一个请求。**已经在飞的那一个 RPC 停不下来**（worker 是独立子进程，且没有
 * 中间切流的口子），取消的语义是「不再继续剩下的」，已开始的那个会跑完——这一点如实
 * 写进取消后的结论文案，不假装它被立刻掐断。
 *
 * ## 恢复
 *
 * App 重载会丢掉进程内的下载。宿主任务记录里留了坐标（`metadata.githana`：仓库、
 * 目标列表、路径、overwrite），`resumeTask` 把它们交给本模块重新跑一遍——下载是幂等的
 * （同一资产同一路径，overwrite 语义照旧），重跑不会产生半份文件之外的新副作用。
 */
import path from "node:path";
import {
  createSessionTask,
  readTaskRecord,
  updateTask,
  completeTask,
  failTask,
  isTerminalTaskStatus,
  taskLog,
  githanaMetaOf,
  registerTaskResumer,
} from "./tasks.js";
import { removeTree } from "./exec.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";
import { transferFailureText, normalizeAbsolutePath, safeFileName } from "./transfer.js";

/** 元数据里的 kind：传输入类的后台任务（下载 / 上传）。 */
export const TRANSFER_TASK_KIND = "transfer-download";

/** 元数据里的 kind：命令类后台任务（clone 这类走外部进程的）。 */
export const COMMAND_TASK_KIND = "transfer-command";

/**
 * 后台跑一个外部命令（clone 这类）。
 *
 * 与 REST 传输不同，它只有一步，但它能**真被取消**——`runCli` 接 `signal`，取消时杀掉
 * 子进程树（clone 会 fork 出 index-pack 与 remote helper，只杀主进程会让 close 永不到来），
 * 而不是像 REST 传输那样只能“不再发下一个”。
 *
 * 取消后不留半成品：`cleanup` 给了就在中止后调它。这对 clone 是必须的——半个目录
 * 会阻止下次重试（“target directory already exists”）。
 */
export async function runCommandTask({ taskId, label, command, run, cleanup }) {
  const rec = await readTaskRecord(taskId);
  if (!rec.error && rec.record && isTerminalTaskStatus(rec.record.status)) {
    taskLog("info", "task " + taskId + " is already terminal (" + rec.record.status + "): not starting the command");
    return { ok: false, cancelled: true, text: label + " was cancelled before it started; nothing was run." };
  }

  await updateTask(taskId, { status: "running", progress: { phase: "running", command } });

  // 取消信号：由轮询宿主任务记录派生（宿主没有把取消事件推给 App，只能自己看）。
  // 轮询的 2 秒间隔意味着 abort 可能比命令自己的结束晚到，所以**不以这个标志为最终
  // 判据**：run 返回后回读一次记录，以宿主那份为准（下面 cancelled 的复核）。
  const ac = new AbortController();
  let cancelled = false;
  const watcher = setInterval(async () => {
    const r = await readTaskRecord(taskId);
    if (r.error || !r.record) return;
    if (isTerminalTaskStatus(r.record.status) && !cancelled) {
      cancelled = true;
      ac.abort();
    }
  }, 2000);
  watcher.unref?.();

  let result;
  try {
    result = await run({ signal: ac.signal });
  } catch (e) {
    // run 抛了（不是「返回 ok:false」）：必须结算成失败，否则任务记录会永远停在 running。
    const text = label + " failed: " + (e && e.message ? e.message : String(e));
    await failTask(taskId, text);
    return { ok: false, cancelled: false, text };
  } finally {
    clearInterval(watcher);
  }

  // 以宿主记录为准复核一次：轮询还没跳到、但用户已取消的情形也算取消。
  // 例外是「命令其实已经跑完」——那以结果为准，不把一个完整的产物当半成品清掉。
  if (!cancelled) {
    const after = await readTaskRecord(taskId);
    if (!after.error && after.record && isTerminalTaskStatus(after.record.status)) cancelled = true;
  }

  if (cancelled && !(result && result.ok)) {
    let cleanupNote = "";
    if (typeof cleanup === "function") {
      try {
        cleanupNote = await cleanup();
      } catch (e) {
        cleanupNote = "cleanup failed: " + (e && e.message ? e.message : String(e));
      }
    }
    const text = label + " was cancelled: the process tree was terminated." + (cleanupNote ? "\n" + cleanupNote : "");
    // 不调 completeTask：用户取消已经把记录推成终态（aborted），宿主不允许再替换终态结果。
    // 取消是用户意图，“结论”就是他自己的动作，再回投一句话反而像在闯他。
    taskLog("info", "task " + taskId + " cancelled in-session: " + text.replace(/\n/g, " "));
    return { ok: false, cancelled: true, text };
  }

  const text = String(result.text ?? "");
  if (result.ok) {
    await completeTask(taskId, { githana: { action: "command", cancelled: false, text } });
    return { ok: true, cancelled: false, text };
  }
  await failTask(taskId, text);
  return { ok: false, cancelled: false, text };
}

/**
 * 建任务并把外部命令丢到后台；**立刻**返回句柄。
 */
export async function startCommandTask(input, { label, callToken, repo, meta, command, run, cleanup }) {
  const created = await createSessionTask({
    taskLabel: label,
    callToken,
    metadata: {
      githana: {
        kind: COMMAND_TASK_KIND,
        repo,
        ...meta,
        command,
        startedAt: Date.now(),
      },
    },
  });
  if (created.error) return { error: created.error };

  void runCommandTask({ taskId: created.taskId, label, command, run, cleanup }).catch((e) => {
    taskLog("warn", "command task " + created.taskId + " threw: " + (e && e.message ? e.message : String(e)));
  });

  return { taskId: created.taskId, record: created.record };
}

/**
 * App 换代后，把未完成的命令类任务（clone）收尾。
 *
 * 为什么是「收尾」而不是「接回去继续跑」：App 重载会把进程内的 git 子进程一起带走
 * （它是本进程的子进程），而且 metadata 里存的是 dest 与参数，没有可重建的完整调用上下文。
 * 真要紧的是**不能留假活**：宿主记录若停在 running，任务 chip 会永远转圈，看起来像
 * 有东西在跑，实际什么都不在了。所以这里一律结算成失败，并删掉半个目录（否则下次
 * 重试撞 target directory already exists）。
 */
async function resumeCommandTask(record) {
  const taskId = record && record.taskId ? String(record.taskId) : "";
  if (!taskId) return { error: "record is missing taskId" };
  const meta = githanaMetaOf(record) || {};
  const dest = meta.dest ? String(meta.dest) : "";
  const repo = meta.repo ? String(meta.repo) : "?";

  // 只收未终结记录（宿主自己推成终态的不管：那时用户已经看到那个任务结束了，
  // 再动它的副作用属于越界——实测过，一旦把终态也纳入，上一批历史记录会被反复扫到，
  // 31 条旧任务每条都去删同一个路径，把本代正在跑的 clone 目录也删了）。
  //
  // 能走到这里的，是“上一代没来得及结算”的那种：记录还挂在 running，而进程已经没了。
  let cleanupNote = "";
  if (dest) {
    const r = await removeTree(dest);
    cleanupNote = r.ok
      ? "the partial directory was removed: " + dest
      : r.message + " — delete it yourself before retrying.";
  }

  const text = [
    "the clone of " + repo + " was interrupted by an App reload:",
    "the git process belonged to the previous App instance, so it is gone; this task was settled as failed rather than left looking alive.",
    cleanupNote,
    "retry with the same githana_repo(action=\"clone\") call.",
  ].filter(Boolean).join("\n");
  await failTask(taskId, text);
  taskLog("info", "command task " + taskId + " settled after App reload (interrupted clone of " + repo + ")");
  return { ok: true };
}

/**
 * App 换代后，把未完成的传输任务收尾。
 *
 * 与命令类同理：REST worker 是独立子进程，App 重载会把它一起收掉（或留下一个已经写完
 * 但没人结算的孤儿），而 metadata 里没有可重建请求的 url，无法在这里自动重跑。
 * 关键是如实告知并给出去重指引：目标文件可能已经完整落地，也可能只有一半，不能猜。
 */
async function resumeTransferTask(record) {
  const taskId = record && record.taskId ? String(record.taskId) : "";
  if (!taskId) return { error: "record is missing taskId" };
  const meta = githanaMetaOf(record) || {};
  const repo = meta.repo ? String(meta.repo) : "?";
  const items = Array.isArray(meta.items) ? meta.items : [];
  const targets = items.map((it) => (it && it.target ? String(it.target) : "?")).filter(Boolean);

  const text = [
    "the transfer from " + repo + " was interrupted by an App reload:",
    "the REST worker belonged to the previous App instance, so nothing is writing any more; this task was settled as failed rather than left looking alive.",
    targets.length
      ? "targets that may be complete or partial — check them before retrying:\n" + targets.map((t) => "  · " + t).join("\n")
      : "the task record carries no target paths.",
    "retry the same download / upload call; pass overwrite=true if a partial file is in the way.",
  ].join("\n");
  await failTask(taskId, text);
  taskLog("info", "transfer task " + taskId + " settled after App reload (interrupted transfer from " + repo + ")");
  return { ok: true };
}

registerTaskResumer(COMMAND_TASK_KIND, resumeCommandTask);
registerTaskResumer(TRANSFER_TASK_KIND, resumeTransferTask);

/**
 * 一个下载项的描述。`fetch` 是真正发请求的函数，由各动词自己给（release 与 run 的
 * 端点不同），本模块只管「串行跑完、逐项结算、汇总成一段话」。
 *
 * @typedef {{
 *   name: string,
 *   target: string,
 *   run: (opts: { timeoutMs: number }) => Promise<{ ok: boolean, message?: string, bytes?: number|null, res?: object }>
 * }} TransferItem
 */

/**
 * 把一批下载项的汇总结果拼成回投文本。
 *
 * `describeResult` 给了就完全由它拼（上传要的不是「写了几字节」，而是与远端摘要的对照、
 * 以及 422 这种要人看着办的错）；没给就走默认的逐文件汇总（下载）。
 */
function summarize(label, repoLabel, scenario, items, results, overwrite, describeResult) {
  if (typeof describeResult === "function" && items.length === 1) {
    return String(describeResult(results[0]) ?? "");
  }
  const lines = [label + " (" + repoLabel + " · " + scenario + "):"];
  lines.push(
    "target files: " + items.length + (overwrite ? " (overwriting same-named files is allowed)" : " (existing targets are not overwritten)"),
  );
  let done = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const r = results[i];
    lines.push("");
    if (!r) {
      lines.push("  · " + it.name + ": not attempted (cancelled before this one started)");
      failed += 1;
      continue;
    }
    if (r.ok) {
      lines.push("  ✓ " + it.name + " → " + it.target);
      if (r.bytes !== null && r.bytes !== undefined) lines.push("     wrote " + r.bytes + " bytes");
      done += 1;
    } else {
      lines.push("  ! " + it.name + ": " + r.message);
      failed += 1;
    }
  }
  lines.push("");
  lines.push(
    done === items.length && failed === 0
      ? "done: " + done + " file(s) written to disk."
      : "done " + done + " / failed " + failed + " (see each line above).",
  );
  if (done > 0 && !overwrite) {
    lines.push("note: this run did not overwrite any existing file (overwrite defaults to false).");
  }
  return lines.join("\n");
}

/**
 * 在后台串行跑完这批下载并结算宿主任务。
 *
 * @returns {Promise<{ ok: boolean, done: number, failed: number, cancelled: boolean, text: string }>}
 */
export async function runTransferTask({ taskId, label, repoLabel, scenario, items, overwrite, timeoutSec, describeResult }) {
  const results = [];
  let cancelled = false;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];

    // 每一跳前读一次记录：用户取消后记录转终态，不再发下一个请求。
    const rec = await readTaskRecord(taskId);
    if (!rec.error && rec.record && isTerminalTaskStatus(rec.record.status)) {
      cancelled = true;
      taskLog("info", "task " + taskId + " is already terminal (" + rec.record.status + "): stopping after " + i + " file(s)");
      break;
    }

    // 只在开始一个文件时写一次 phase：`toFile` 通道不回报中间进度，不伪造百分比。
    await updateTask(taskId, {
      status: "running",
      progress: { phase: "downloading", file: it.name, index: i + 1, total: items.length },
    });

    let r;
    try {
      r = await it.run({ timeoutMs });
    } catch (e) {
      r = { ok: false, message: e && e.message ? String(e.message) : String(e || "unknown error") };
    }
    results.push(r);
  }

  const text = summarize(label, repoLabel, scenario, items, results, overwrite, describeResult);
  const done = results.filter((r) => r && r.ok).length;
  const failed = results.length - done;

  // 取消：已完成的照实说，未开始的说没跑。不谎称「全都停下了」。
  // 不调 completeTask：取消已经把记录推成终态（aborted），宿主不允许再替换。
  if (cancelled) {
    const tail = "transfer cancelled from this session: " + done + " file(s) already written, " +
      (items.length - results.length) + " not started.\n" +
      "note: a transfer already in flight when you cancelled keeps running to completion (the REST worker is a separate process and there is no mid-stream abort); only the remaining items are skipped.";
    taskLog("info", "task " + taskId + " cancelled in-session: " + done + " written, " + (items.length - results.length) + " not started");
    return { ok: failed === 0, done, failed, cancelled: true, text: text + "\n\n" + tail };
  }

  if (failed > 0) {
    await failTask(taskId, text);
    return { ok: false, done, failed, cancelled: false, text };
  }
  await completeTask(taskId, { githana: { action: "download", cancelled: false, done, failed, text } });
  return { ok: true, done, failed, cancelled: false, text };
}

/**
 * 建任务并把下载丢到后台；**立刻**返回句柄（不在回调里等）。
 *
 * 返回值里有 `taskId` 时，调用方应当把它拼进回执文本并返回，不再 await 任何东西。
 */
export async function startTransferTask(input, { label, callToken, repo, repoLabel, scenario, items, overwrite, timeoutSec, meta, describeResult }) {
  const created = await createSessionTask({
    taskLabel: label,
    callToken,
    metadata: {
      githana: {
        kind: TRANSFER_TASK_KIND,
        repo,
        ...meta,
        // 恢复坐标：够重新跑一遍即可（路径与 overwrite 语义都在这里）。
        items: items.map((it) => ({ name: it.name, target: it.target })),
        overwrite: overwrite === true,
        startedAt: Date.now(),
      },
    },
  });
  if (created.error) return { error: created.error };

  // 丢到后台：这里**不** await（纪律同 watch：工具回调只做「建任务 + 起活」）。
  void runTransferTask({ taskId: created.taskId, label, repoLabel, scenario, items, overwrite, timeoutSec, describeResult }).catch((e) => {
    taskLog("warn", "transfer task " + created.taskId + " threw: " + (e && e.message ? e.message : String(e)));
  });

  return { taskId: created.taskId, record: created.record };
}

/** 目标路径：path 优先；否则 dir + 文件名；都没有就落到本进程 cwd。 */
export function resolveTargetPath(input, fileName) {
  const p = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (p) {
    const norm = normalizeAbsolutePath(p, "path");
    return norm.error ? { error: norm.error } : { path: norm.path, fromPath: true };
  }
  const safe = safeFileName(fileName, "asset.bin");
  const d = input?.dir !== undefined && input?.dir !== null ? String(input.dir).trim() : "";
  if (d) {
    const norm = normalizeAbsolutePath(d, "dir");
    if (norm.error) return { error: norm.error };
    return { path: path.join(norm.path, safe), fromPath: false };
  }
  return { path: path.resolve(process.cwd(), safe), fromPath: false };
}

/** 单个资产的下载项（release 与 run 共用的那一段）。 */
export function makeRestTransfer({ id, url, target, overwrite, timeoutSec }) {
  return async ({ timeoutMs }) => {
    const r = await callRest([{ id, headers: id.startsWith("asset-") ? { Accept: "application/octet-stream" } : undefined, url, toFile: target, overwrite, timeoutMs }], { timeoutSec });
    if (!r.ok) return { ok: false, message: "execution failed: " + r.message };
    const res = r.results[0];
    const byCode = transferFailureText(res);
    if (byCode) return { ok: false, message: "write to disk failed — " + target + "\n    " + byCode };
    // 没有状态码说明请求没走到拿响应那一步（白名单拒、连接断）：worker 的原话才是唯一的线索，
    // 不能只报“HTTP null”——那等于把根因丢了。
    if (!res) return { ok: false, message: "execution failed: the REST worker returned no result." };
    if (!res.ok) {
      const status = res.status === undefined || res.status === null ? null : res.status;
      const detail = res.error ? String(res.error) : "";
      return {
        ok: false,
        message: status === null
          ? "the request did not produce an HTTP response" + (detail ? ": " + detail : ".")
          : "GitHub returned HTTP " + status + (detail ? " — " + detail : ""),
      };
    }
    return { ok: true, bytes: res.bytes ?? null, res };
  };
}

/**
 * 单个资产的上传项。
 *
 * 与下载同形（一个 `run` 闭包装一次 RPC），差别在字段：`file` 是 worker 去**读**的本地路径，
 * `hashFile` 让 worker 顺带算 sha256（App 进程常读不到许可根外的文件），`maxFileBytes` 在发请求
 * 前就拦住超过 GitHub 硬限的文件。
 *
 * 失败时把 HTTP 状态带回去：422 在 upload 那里有专门的文案（同名资产已存在），不能挤成一句话。
 */
export function makeRestUpload({ id, url, file, contentType, maxFileBytes, timeoutSec }) {
  return async ({ timeoutMs }) => {
    const r = await callRest(
      [{ id, method: "POST", url, file, hashFile: true, contentType, maxFileBytes, timeoutMs }],
      { timeoutSec },
    );
    if (!r.ok) return { ok: false, message: "execution failed: " + r.message };
    const res = r.results[0];
    if (!res) return { ok: false, message: "execution failed: the REST worker returned no result." };
    const byCode = transferFailureText(res);
    if (byCode) return { ok: false, message: byCode };
    if (!res.ok) {
      const status = res.status === undefined || res.status === null ? null : res.status;
      const detail = res.error ? String(res.error) : "";
      return {
        ok: false,
        status,
        json: res.json ?? null,
        message: status === null
          ? "the request did not produce an HTTP response" + (detail ? ": " + detail : ".")
          : "HTTP " + status + (detail ? " — " + detail : ""),
      };
    }
    return { ok: true, bytes: res.size ?? null, res, json: res.json ?? null };
  };
}

export { apiUrl };
