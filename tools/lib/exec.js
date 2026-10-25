// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/exec.js — 本地 CLI 子进程执行统一封装（git 唯一执行入口）。
 *
 * 设计（对齐 spec「Constraints」与「Design Decisions」）：
 * - spawn 异步执行：参数数组、无 shell（Windows/POSIX 一致，免转义免注入）；
 * - stdout / stderr 分通道捕获，各自截断到 MAX_OUTPUT_BYTES（200KB）防内存膨胀，
 *   截断时置 truncated 标记，展示层提示「输出过大已截断」；
 * - Windows CRLF 统一归一为 LF（各通道输出后续再处理）；
 * - 超时 kill：缺省 DEFAULT_TIMEOUT_SEC（120s），超时终止子进程返回可读错误（不挂起）；
 * - 退出码归一：返回 { ok: exitCode===0, exitCode, stdout, stderr, ... }；
 *   非零退出保留原始输出（stdout/stderr 原样返回），message 给可读诊断头；
 *   cwd 不存在/非目录、可执行文件不在 PATH（ENOENT）、启动失败等基础设施错误返回
 *   { ok:false, message }（中文可读，不抛裸异常——工具调用方直接展示 message 即可）。
 * - stdin 可选（input 字符串）：不传也立即关闭 stdin（EOF），非交互命令不挂起；
 *   一律注入 GIT_TERMINAL_PROMPT=0，杜绝 git/gh 子进程弹交互式凭据/确认。
 *
 * Windows 实现说明：git/gh 均为 PATH 中 .exe（spawn 经 PATH+PATHEXT 解析），
 * windowsHide 防弹窗；超时 kill 用 child.kill()（TerminateProcess 单进程），外部中止
 * 走 terminateTree()（见下）——clone 这类命令会 fork 出 index-pack / remote helper，
 * 只杀主进程会留下持有管道的孤儿，close 永远不来。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveBinExec, buildBinEnv } from "./bin.js";

export const DEFAULT_TIMEOUT_SEC = 120;
/** 各输出通道截断上限（字节）：200KB */
export const MAX_OUTPUT_BYTES = 200 * 1024;

const CRLF = /\r\n?/g;

/** CRLF 归一 LF（同时兼容孤立 CR） */
export function normalizeNewlines(text) {
  return String(text ?? "").replace(CRLF, "\n");
}

/**
 * 杀掉一个子进程**及其子孙**。
 *
 * 单 `child.kill()` 在 Windows 上只是 TerminateProcess 那一个进程：clone 会同时跑
 * `index-pack` 与 `git-remote-*` helper，它们继承 stdout/stderr 管道；主进程死了、孙进
 * 程还活着，`close` 事件就不会来（管道未关），等待方永远返回不了。
 *
 * POSIX 侧 git 被 SIGTERM 后会自己收尾；这里只做 Windows 的树杀（taskkill /T），
 * 失败时退回 child.kill()——宁可少杀也不抛。
 */
function terminateTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {
        try { child.kill(); } catch { /* 已退出 */ }
      });
      return;
    } catch {
      /* 落到下面的单进程 kill */
    }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

/**
 * cwd 预校验：必须存在且为目录。cwd 为空/未传时返回 null（不强制——是否必填由各工具契约决定）；
 * 非法返回中文可读错误消息。
 * @param {unknown} cwd
 * @returns {string | null}
 */
export function checkCwd(cwd) {
  if (cwd === undefined || cwd === null) return null;
  const s = String(cwd).trim();
  if (!s) {
    return "cwd must not be empty: pass the absolute path of the repository (e.g. E:\\workspace\\my-repo).";
  }
  let st;
  try {
    st = fs.statSync(s);
  } catch (err) {
    // App v2 隔离进程开了 Node Permission Model：许可根之外（installDir / dataDir）的 fs
    // 读取被运行时拒绝（ERR_ACCESS_DENIED）。这不是「目录不存在」，而是宿主进程无权预检。
    // 直接放行，把 cwd 交给 git/gh 子进程判断（外部命令不继承该模型，能自由访问仓库）。
    if (err && (err.code === "ERR_ACCESS_DENIED" || err.code === "EPERM")) return null;
    return "cwd does not exist: " + s + ". Check that the absolute path is correct (was the directory moved or deleted?).";
  }
  if (!st.isDirectory()) {
    return "cwd is not a directory: " + s + ". git/gh commands must run inside a directory, so pass the absolute path of a directory.";
  }
  return null;
}

/**
 * 超时归一（秒）：非法/缺省回落 DEFAULT_TIMEOUT_SEC，下限 1 秒。
 * @returns {number}
 */
function normalizeTimeoutSec(timeoutSec) {
  if (timeoutSec === undefined || timeoutSec === null || timeoutSec === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const n = Number(timeoutSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.max(1, Math.floor(n));
}

/** 可执行文件启动失败（ENOENT/EACCES/…）→ 中文可读 */
function spawnErrorMessage(bin, code, resolved) {
  if (code === "ENOENT") {
    const bundledHint =
      resolved && resolved.bundledMissing
        ? " (the vendored copy bundled with the plugin is missing, so it fell back to the system PATH; run scripts/fetch-vendor.mjs to download the bundled " + bin + ")"
        : "";
    return (
      "executable \"" + bin + "\" not found" + bundledHint + ": make sure " + bin +
      " is installed and its directory is on the system PATH (on Windows it must resolve to " + bin + ".exe, " +
      "e.g. C:\\Program Files\\Git\\cmd\\git.exe / " + bin + ".exe)."
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return "insufficient permission to execute \"" + bin + "\" (" + code + "): check the permissions of the executable and of its directory.";
  }
  if (code === "ENOTDIR") {
    return "wrong path while launching \"" + bin + "\" (ENOTDIR): a non-directory component appears in the executable path; check the PATH configuration.";
  }
  return "failed to launch the process (" + bin + ")" + (code ? ": " + code : "") + "; retry, or contact the plugin maintainer.";
}

/** 非零退出的可读诊断头（取 stderr/stdout 尾部几行，完整原文在 stdout/stderr 字段里） */
function buildExitDiagnosis(bin, code, stdout, stderr) {
  const raw = (stderr && stderr.trim()) || (stdout && stdout.trim()) || "";
  const lines = [bin + " command failed (exit code " + code + ")."];
  if (raw) {
    const tail = raw.split("\n").filter((l) => l.trim() !== "").slice(-6);
    if (tail.length) lines.push("diagnostics: " + tail.join("\n"));
  } else {
    lines.push("the command produced no output.");
  }
  return lines.join("\n");
}

/**
 * runCli：spawn 异步执行单个 CLI（git/gh/…），返回归一化结果。
 *
 * @param {string} bin 可执行文件名（经 PATH 解析，如 "git" / "gh"）
 * @param {string[]} args 参数数组（无 shell 拼接）
 * @param {{ cwd?: string, timeoutSec?: number, input?: string, signal?: AbortSignal }} [options]
 *   cwd 工作目录（绝对路径，可选但 git 工具必填）；timeoutSec 超时秒数（缺省 120）；
 *   input stdin 内容（多行/中文无损，git commit -F - 用）；
 *   signal 外部中止信号（后台任务的取消用它）——它 kill 子进程并返回可读的中止文案。
 * @returns {Promise<{
 *   ok: boolean, exitCode: number | null,
 *   stdout: string, stderr: string,
 *   stdoutTruncated: boolean, stderrTruncated: boolean,
 *   timedOut: boolean, message: string | null
 * }>} ok=false 时 message 为中文可读错误；非零退出时 stdout/stderr 保留原始输出。
 */
/**
 * 本进程起过的、还没结束的子进程。
 *
 * 为什么需要登记：Windows 没有“父进程死了子进程一起死”这回事。App 被卸载 / 重载时，
 * 旧实例的 git 子进程会变成**孤儿继续跑**——它仍然占着磁盘在写，而宿主已经把任务记录
 * 推成终态，于是“任务已终止、活儿还在后台”这种最坏形态就出现了（实测重现过：clone
 * 的 index-pack 在 App 换代后仍在写）。dispose 时靠这份表把它们收掉。
 */
const liveChildren = new Set();

/**
 * 杀掉本进程起过的所有子进程（App 卸载 / 重载时调）。
 *
 * 同步树杀：这个方法会从 dispose 与 exit 钩子两处调，后者只能做同步事（事件循环已停），
 * 异步 spawn 在那里永远不会被调度。
 *
 * 两道收：先 child.kill()（同步、立刻、不等任何外部命令），再 taskkill /T 补子孙。
 * 只做 taskkill 不够可靠——它要 fork 一个进程，在 exit 钩子的最后几毫秒里未必跑得完，
 * 主进程一死孙进程就成孤儿（实测：单 taskkill 时 git 主进程死了、index-pack 还活着写）。
 * 反过来只做 child.kill() 又够不着孙进程，所以才要两道。
 */
export function killLiveChildren() {
  const n = liveChildren.size;
  const kids = [...liveChildren];
  liveChildren.clear();
  for (const child of kids) {
    if (!child || child.exitCode !== null) continue;
    // ① 立刻杀主进程：同步，不依赖外部命令。
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    // ② 补子孙：taskkill /T 把整棵树收完。
    if (process.platform === "win32" && child.pid) {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 5000,
        });
      } catch { /* 尽力而为 */ }
    }
  }
  return n;
}

/**
 * 在进程退出前收掉子进程。
 *
 * 为什么必须靠这个钩子而不是 apply 返回的 teardown：宿主卸载 App 时走的是
 * `handle.kill()` 发 SIGTERM 消息，而实测那条路只花几十毫秒就宣告“stop process”成功——
 * 直接硬杀，apply 返回的函数与本进程的 exit 钩子**都没有机会跑**（在钩子里写标示文件
 * 验证过：文件从未出现）。所以这些钩子不能当作真正的保障，只能当机会主义的一道。
 *
 * 真正的兼底在 resumeCommandTask 那一侧：新实例装载时扫到旧任务记录，把上一个实例
 * 死于硬杀时留下的半成品目录收掉。
 *
 * 钩子里只能做**同步**事：事件循环已停，异步 spawn 永远不会被调度。所以用 spawnSync。
 */
function installExitHook() {
  if (installExitHook.installed) return;
  installExitHook.installed = true;
  const flush = () => {
    try { killLiveChildren(); } catch { /* 尽力而为 */ }
  };
  process.on("exit", flush);
  process.once("disconnect", flush);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try {
      process.on(sig, () => { flush(); process.exit(0); });
    } catch { /* 平台不支持该信号 */ }
  }
}

/**
 * 登记一个外来子进程（REST worker 这类不走 runCli 的），让它也能被 dispose 收掉。
 * @returns {() => void} 注销函数（子进程结束时调）
 */
export function trackChildProcess(child) {
  if (!child) return () => {};
  installExitHook();
  liveChildren.add(child);
  return () => { liveChildren.delete(child); };
}

export async function runCli(bin, args, { cwd, timeoutSec, input, signal } = {}) {
  const cwdErr = checkCwd(cwd);
  if (cwdErr) {
    return {
      ok: false, exitCode: null, stdout: "", stderr: "",
      stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, message: cwdErr,
    };
  }
  // 可执行文件解析：宿主内嵌（spawn 探活）→ 随包 vendor → 系统 PATH。
  // 用异步版：宿主 resources 在 AppHost 许可根外，fs 会被 Permission Model 拒，
  // 但外部命令不继承该模型，所以用 spawn 探活判断存在性。
  const resolved = await resolveBinExec(bin);
  const argList = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const sec = normalizeTimeoutSec(timeoutSec);

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOutTriggered = false; // 超时 kill 已触发（区分信号终止与超时终止的文案）
    let abortedTriggered = false; // 外部中止已触发（后台任务取消）
    const stdoutCol = makeCollector(MAX_OUTPUT_BYTES);
    const stderrCol = makeCollector(MAX_OUTPUT_BYTES);
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // 结果统一附带 bin 解析信息（可观察性：bundled 还是 system）
      resolve({
        ...value,
        binSource: resolved.source,
        binLabel: resolved.binLabel || null,
      });
    };

    try {
      child = spawn(resolved.cmd, argList, {
        cwd: cwd !== undefined && cwd !== null && String(cwd).trim() !== "" ? String(cwd).trim() : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: buildBinEnv(process.env, resolved, { bin, args: argList }),
      });
      liveChildren.add(child);
      installExitHook();
      child.on("close", () => { liveChildren.delete(child); });
    } catch (err) {
      finish({
        ok: false, exitCode: null, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false,
        timedOut: false,
        message: spawnErrorMessage(bin, err && err.code, resolved),
      });
      return;
    }

    child.stdout.on("data", (d) => stdoutCol.push(d));
    child.stderr.on("data", (d) => stderrCol.push(d));

    child.on("error", (err) => {
      finish({
        ok: false, exitCode: null, stdout: normalizeNewlines(stdoutCol.text()),
        stderr: normalizeNewlines(stderrCol.text()),
        stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
        timedOut: false,
        message: spawnErrorMessage(bin, err && err.code, resolved),
      });
    });

    child.on("close", (code, signal) => {
      const stdout = normalizeNewlines(stdoutCol.text());
      const stderr = normalizeNewlines(stderrCol.text());
      // 被信号终止（超时 kill 或外部终止）
      if (code === null) {
        finish({
          ok: false, exitCode: null, stdout, stderr,
          stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
          timedOut: timedOutTriggered,
          message: timedOutTriggered
            ? bin + " command timed out (" + sec + "s): the process was terminated. If this is a legitimately long task, raise timeoutSec (the git/gh tools cap it at 600 seconds) and retry."
            : abortedTriggered
              ? bin + " command was aborted (the background task was cancelled): the process was terminated."
              : bin + " command was terminated externally (signal" + (signal ? " " + signal : "") + "); execution stopped.",
        });
        return;
      }
      const ok = code === 0;
      finish({
        ok,
        exitCode: code,
        stdout,
        stderr,
        stdoutTruncated: stdoutCol.truncated(),
        stderrTruncated: stderrCol.truncated(),
        timedOut: false,
        message: ok ? null : buildExitDiagnosis(bin, code, stdout, stderr),
      });
    });

    // 外部中止（后台任务取消）：与超时同一套收尾，只是文案不同——取消是用户意图，
    // 不是“任务太长了”。必须树杀：留下持管道的孙进程，close 就永远不来，
    // 而 cleanup（删半个克隆目录）也就永远没机会跑。已 settled 就不再动进程。
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => {
        if (settled || !child) return;
        abortedTriggered = true;
        terminateTree(child);
        // 与超时同一套兜底：树杀后 close 仍不来（句柄被别处继承），3 秒后自行结算。
        const guard = setTimeout(() => {
          finish({
            ok: false, exitCode: null,
            stdout: normalizeNewlines(stdoutCol.text()),
            stderr: normalizeNewlines(stderrCol.text()),
            stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
            timedOut: false,
            message: bin + " command was aborted (the background task was cancelled): the process tree was terminated.",
          });
        }, 3000);
        guard.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // 超时 kill：先置标志，终止后由 close 事件收尾（code null → 可读超时消息）
    timer = setTimeout(() => {
      if (settled || !child) return;
      timedOutTriggered = true;
      try { child.kill(); } catch { /* 进程已退出 */ }
      // 若 kill 后 close 迟迟不来（极端），3 秒兜底直接结算超时错误
      const guard = setTimeout(() => {
        finish({
          ok: false, exitCode: null,
          stdout: normalizeNewlines(stdoutCol.text()),
          stderr: normalizeNewlines(stderrCol.text()),
          stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
          timedOut: true,
          message:
            bin + " command timed out (" + sec + "s): the process was terminated. If this is a legitimately long task, " +
            "raise timeoutSec (the git/gh tools cap it at 600 seconds) and retry.",
        });
      }, 3000);
      guard.unref?.();
    }, sec * 1000);
    timer.unref?.();

    // stdin：input 有值则写入后关闭，否则立即关闭（EOF）——非交互不挂起
    try {
      if (input !== undefined && input !== null) {
        child.stdin.end(String(input));
      } else {
        child.stdin.end();
      }
    } catch {
      /* stdin 已关闭（进程快速退出），忽略 */
    }
  });
}

/**
 * 分通道有界收集器：超限即截断（保留开头，防单次巨块撑爆内存），内存上界 ≈ limit。
 */
function makeCollector(limit) {
  const parts = [];
  let size = 0;
  let truncated = false;
  return {
    truncated: () => truncated,
    push(buf) {
      if (truncated || size >= limit) return;
      const remaining = limit - size;
      if (buf.length > remaining) {
        parts.push(buf.subarray(0, remaining));
        size += remaining;
        truncated = true;
        return;
      }
      parts.push(buf);
      size += buf.length;
    },
    text() {
      return Buffer.concat(parts).toString("utf8");
    },
  };
}

/** 截断提示附注（渲染时用） */
function truncateNote(truncated, channel) {
  return truncated
    ? " (" + channel + " output was too large; it was truncated keeping the beginning, limit " + Math.round(MAX_OUTPUT_BYTES / 1024) + "KB)"
    : "";
}

/**
 * 通用结果渲染：把 runCli 结果格式化为可读文本（githana 的 status / log / commit / push / exec 等共用）。
 * - 成功：命令 + exit 0 + stdout/stderr（非空时）；
 * - 基础设施失败（message 且 exitCode null，如 cwd/bin/超时）：直接返回 message（附部分输出）；
 * - 非零退出：exit code + 命令 + stderr/stdout 原始输出（保留原文，附截断提示）。
 * @param {string} bin 展示名（git/gh）
 * @param {string[]} args
 * @param {*} result runCli 返回值
 * @returns {string}
 */
export function formatCliResult(bin, args, result) {
  const cmdLine = bin + (args.length ? " " + args.join(" ") : "");
  // 基础设施错误（cwd 不存在 / bin 未找到 / 超时等）：message 已可读
  if (!result.ok && result.exitCode === null && result.message) {
    let s = result.message;
    if (result.timedOut && (result.stdout || result.stderr)) {
      s += "\n—— partial output captured before the timeout ——\n" +
        blockIfAny("stdout", result.stdout) + blockIfAny("stderr", result.stderr);
    }
    return s;
  }

  const lines = [];
  if (result.ok) {
    lines.push(
      bin + " command succeeded (exit 0)" +
      (result.binLabel ? " (" + result.binLabel + ")" : "")
    );
  } else {
    lines.push(bin + " command failed (exit code " + result.exitCode + ")");
  }
  lines.push("command: " + cmdLine);
  const outBlock = blockIfAny("stdout", result.stdout);
  if (outBlock) lines.push(outBlock + truncateNote(result.stdoutTruncated, "stdout"));
  const errBlock = blockIfAny("stderr", result.stderr);
  if (errBlock) lines.push(errBlock + truncateNote(result.stderrTruncated, "stderr"));
  if (!outBlock && !errBlock) lines.push("(no output)");
  return lines.join("\n");
}

/** 非空通道 → 带标题块；空 → "" */
function blockIfAny(title, text) {
  if (!text) return "";
  return "—— " + title + " ——\n" + text;
}

/**
 * 删掉一棵目录树，**绕开本进程的 fs 许可边界**。
 *
 * App 进程开着 Node Permission Model（只能写 installDir / dataDir），但 clone / download 的
 * 落点是用户指定的任意盘位——那些字节是外部命令（不受该模型约束）写的，回收也必须由外部
 * 命令来做。`fs.rmSync` 在许可根外会抛 ERR_ACCESS_DENIED，那会把“中止后清理”变成空话。
 *
 * 优先用 git 自带的干净收尾路径（clone 出来的目录本来就是个 git 仓库，`clean -xdff`
 * 能一次抹掉工作区与 .git），不行再退回系统命令。目标不存在算成功（清已是幂等语义）。
 *
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function removeTree(dir) {
  const target = String(dir ?? "").trim();
  if (!target) return { ok: false, message: "removeTree: an absolute path is required." };
  if (!path.isAbsolute(target)) return { ok: false, message: "removeTree: " + target + " is not an absolute path." };

  let exists = true;
  try {
    fs.statSync(target);
  } catch (e) {
    if (e && (e.code === "ERR_ACCESS_DENIED" || e.code === "EPERM")) {
      exists = true; // 权限模型挡住了 stat，不代表不存在——交给外部命令去碰
    } else {
      exists = false;
    }
  }
  if (!exists) return { ok: true, message: "nothing to remove: " + target + " does not exist." };

  // ① git clean：只对真仓库生效（没有 .git 时 git 会报 not a git repository，自然落到 ②）
  const cleaned = await runCli("git", ["-C", target, "clean", "-xdff"], { timeoutSec: 30 });
  if (cleaned.ok) {
    const gone = await removeDirEntry(target);
    if (gone.ok) return { ok: true, message: "removed " + target };
  }
  // ② 直接删条目本身（整个目录）
  return removeDirEntry(target);
}

/** 删掉路径本身：POSIX 用 rm -rf，Windows 用 rmdir /s /q。 */
async function removeDirEntry(target) {
  const win = process.platform === "win32";
  const r = win
    ? await runCli("cmd", ["/d", "/s", "/c", "rmdir", "/s", "/q", target], { timeoutSec: 60 })
    : await runCli("rm", ["-rf", "--", target], { timeoutSec: 60 });

  // 不以退出码为准，以**目录真没了**为准。两个理由：
  //   1) `rmdir` 对“路径不存在”返回非零，而那恰好是想要的结果（幂等）；
  //   2) Windows 下 cmd/rmdir 的错误输出是 GBK，塞进 stderr 会变成乱码，
  //      拼进用户看的文案等于没有信息（"ϵͳ�Ҳ���ָ�����ļ���" 就是这样来的）。
  let gone = false;
  try {
    if (!fs.existsSync(target)) gone = true;
  } catch {
    // 许可模型挡住 existsSync 时不能断言还在——退回看退出码
    gone = r.ok;
  }
  if (gone) return { ok: true, message: "removed " + target };

  // 真没删掉才需要一句可读的原因；不用子进程的原话（可能是 GBK 乱码）。
  return {
    ok: false,
    message:
      "could not remove " + target +
      " (it still exists after the attempt; something may hold a handle on it, or the path needs different permissions)",
  };
}
