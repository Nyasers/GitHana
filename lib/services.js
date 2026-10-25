// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/services.js — 给别的 App 用的服务面（App v2 的 `app:<appId>/<name>` bus 服务）。
 *
 * 为什么要有这一层：GitHana 的提交带**隔离 gitconfig + 随包 gpg 签名 shim + Co-authored-by**，
 * 那套东西只在本 App 的进程里成立（见 tools/lib/bin.js 的 buildBinEnv）。别的 App 想“写一条
 * 带签名的提交”，只有两条路：让模型自己调 githana_git（多一次模型往返、多一次审批、且要求那个
 * 会话的工具面里有它），或者由本 App 直接代做。后者就是这里。
 *
 * 协议（宿主契约，见 SDK `app-contract/app-services.d.ts`）：
 *   · 提供方 `ctx.bus.handle("<name>", handler, { allowCrossApp: true })`，宿主把完整 verb 定为
 *     `app:githana/<name>`；需要能力 `app/services.provide`；
 *   · 调用方 `ctx.bus.request("app:githana/<name>", payload)`；需要能力 `app/services.call`。
 *     宿主自己判定 callerAppId 并写进 handler 的 context，payload 里伪造无效。
 *
 * 边界：只做**本地 git 提交**这一件事。不推送、不合并、不碰 GitHub——那些仍是工具面的事，
 * 因为它们的参数与副作用需要模型显式表达。这里承接的是一条已经决定好的写历史动作。
 */

/** 服务名（完整 verb = `app:githana/<name>`）。改名 = 破坏对端，别改。 */
export const COMMIT_SERVICE = "commit";

/** 服务名（完整 verb = `app:githana/<name>`）。 */
export const GIT_STATUS_SERVICE = "git-status";

/**
 * 读一个目录所在仓库的现场（只读）：分支、HEAD、是否有未提交改动。
 *
 * 走本 App 的 runCli（隔离 gitconfig、不弹交互），不直接 spawn。什么都交回给调用方判断，
 * 本函数不拦“脏”也不拦“不是仓库”——那是调用方的事。
 */
export async function readStatus(runCli, cwd) {
  const inside = await runCli("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { repository: false, branch: "", head: "", changed: 0 };
  }
  const branch = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const head = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd });
  const dirty = await runCli("git", ["status", "--porcelain"], { cwd });
  return {
    repository: true,
    branch: branch.ok ? branch.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    changed: dirty.ok ? dirty.stdout.split("\n").filter((l) => l.trim()).length : 0,
  };
}

/**
 * 提交请求的载荷。
 * @typedef {object} CommitPayload
 * @property {string} cwd 仓库内任一目录的绝对路径（工作树也行——git 配置是整个仓库共享的）
 * @property {string} [message] 提交说明；缺省用本服务的默认文案
 * @property {string[]} [paths] 可选：相对 cwd 的路径列表；缺省提交全部已暂存内容
 * @property {boolean} [allowEmpty] 允许空提交
 */

/**
 * 归一化载荷：只认已知键，缺的给默认，类型不对直接拒（跨进程边界不做隐式转换）。
 * @returns {{ ok: true, value: {cwd: string, message: string, paths: string[]?, allowEmpty: boolean} } | { ok: false, error: string }}
 */
export function normalizeCommitPayload(payload) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return { ok: false, error: "commit service: payload must be an object" };
  const cwd = typeof p.cwd === "string" ? p.cwd.trim() : "";
  if (!cwd) return { ok: false, error: "commit service: cwd is required (absolute path of a directory inside the repository)" };
  const message = typeof p.message === "string" ? p.message : "";
  let paths;
  if (p.paths !== undefined && p.paths !== null) {
    if (!Array.isArray(p.paths)) return { ok: false, error: "commit service: paths must be an array of relative paths" };
    paths = p.paths;
  }
  return { ok: true, value: { cwd, message, ...(paths ? { paths } : {}), allowEmpty: p.allowEmpty === true } };
}

/**
 * 工具回执 → 服务面结果。
 *
 * 工具实现返回的是 v2 形状 `{ content, details }`，**结构化事实已经在 `details` 里**
 * （`ok` / `hash` / `files`…，见 tools/actions/git/commit.js 尾部）。所以优先读 `details`——
 * 去解析给人看的那段文本是把同一件事再猜一遍，文本一改就错。只有拿不到 `details` 时
 * （老回执 / 纯字符串通道）才退到文本解析。
 *
 * @param {unknown} value commit 动作的回执（`{content, details}` 或纯字符串）
 */
export function commitOutcome(value) {
  // ① 结构化回执（现行实现）：字段直接用，不做二次推断。
  if (value && typeof value === "object" && !Array.isArray(value) && value.details) {
    const d = value.details;
    if (d.ok === true) {
      return { ok: true, commit: String(d.hash || ""), files: Number(d.files || 0) || 0, text: textOf(value) };
    }
    return { ok: false, error: textOf(value) || "commit failed" };
  }
  // ② 纯文本回执（老形态 / 兜底）：只认开头那行，不猜中间内容。
  const raw = typeof value === "string" ? value : textOf(value);
  const m = /^commit created:\s*([0-9a-f]{4,40})\b/i.exec(raw.trim());
  if (m) return { ok: true, commit: m[1], text: raw };
  const a = /^commit amended:\s*([0-9a-f]{4,40})\b/i.exec(raw.trim());
  if (a) return { ok: true, commit: a[1], amended: true, text: raw };
  return { ok: false, error: raw.trim() || "commit failed (no output)" };
}

/** 取回执里的可读文本（content 数组的第一段 text；没有就空串）。 */
function textOf(value) {
  if (typeof value === "string") return value;
  const content = value && Array.isArray(value.content) ? value.content : null;
  const first = content && content.length > 0 ? content[0] : null;
  return first && typeof first.text === "string" ? first.text : "";
}

/**
 * 注册本 App 的服务面。返回 disposers（卸载时逐个调用）。
 *
 * 没有 `ctx.bus` 或没有 `app/services.provide` 时不注册，只记一行日志：能力没授予是本 App
 * 的降级态，不该让它连工具面一起起不来。调用方那边会收到“没有 handler”，然后走自己的退路。
 *
 * @param {object} ctx 宿主 ctx
 * @param {object} deps 依赖注入：{ commit, log }
 * @returns {Array<() => void>}
 */
export function registerServices(ctx, { commit, readStatus, log }) {
  const bus = ctx && ctx.bus;
  if (!bus || typeof bus.handle !== "function") {
    log("warn", "bus 服务面不可用（ctx.bus.handle 缺失），跳过服务注册");
    return [];
  }
  const disposers = [];

  // app:githana/commit —— 在指定仓库里做一次带签名与 Co-authored-by 的提交
  disposers.push(
    bus.handle(
      COMMIT_SERVICE,
      async (payload, context) => {
        const caller = context && context.callerAppId ? String(context.callerAppId) : "?";
        const norm = normalizeCommitPayload(payload);
        if (!norm.ok) {
          log("warn", `服务 commit（来自 ${caller}）载荷非法：${norm.error}`);
          return { ok: false, error: norm.error };
        }
        try {
          // 回执原样交给 commitOutcome：它优先读 `details`（结构化事实），不靠猜文本。
          const reply = await commit(norm.value);
          const outcome = commitOutcome(reply);
          if (outcome.ok) log("info", `服务 commit（来自 ${caller}）：${norm.value.cwd} → ${outcome.commit}`);
          else log("warn", `服务 commit（来自 ${caller}）失败：${outcome.error.slice(0, 200)}`);
          return outcome;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          log("error", `服务 commit（来自 ${caller}）异常：${msg}`);
          return { ok: false, error: msg };
        }
      },
      // allowCrossApp：别的 App（DSHana）拿着 app/services.call 就能调。不给这个选项，服务只对
      // 本 App 自己可见——那就没有存在的意义了。
      { allowCrossApp: true },
    ),
  );

  // app:githana/git-status —— 只读：问一个目录是不是仓库、在哪个分支、有没有未提交改动。
  // 存在的理由：调用方常常需要在“动手之前”确认这是不是仓库、干不干净，而它自己只能 spawn
  // 裸 git（没有本 App 的隔离配置与凭据）。只读、不改任何状态。
  disposers.push(
    bus.handle(
      GIT_STATUS_SERVICE,
      async (payload, context) => {
        const caller = context && context.callerAppId ? String(context.callerAppId) : "?";
        const cwd = payload && typeof payload.cwd === "string" ? payload.cwd.trim() : "";
        if (!cwd) return { ok: false, error: "git-status service: cwd is required" };
        try {
          const status = await readStatus(cwd);
          log("info", `服务 git-status（来自 ${caller}）：${cwd} → ${status.branch || "?"}`);
          return { ok: true, ...status };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      },
      { allowCrossApp: true },
    ),
  );

  log("info", `服务面已注册（app:githana/${COMMIT_SERVICE}、app:githana/${GIT_STATUS_SERVICE}）`);
  return disposers;
}
