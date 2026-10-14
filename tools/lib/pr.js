// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/pr.js — githana_pr 各动词共用的 REST 调用与仓库解析。
 *
 * 只放**真正共用**的部分：仓库上下文解析、PR 编号解析、单 PR 读取、默认分支查询、失败说明、
 * 时间与状态渲染。每个动词自己那份请求编排与输出格式留在 tools/actions/pr/<verb>.js。
 *
 * ## 仓库上下文
 *
 * repo（owner/repo）显式优先；cwd 可选（从 git remote 推断仓库兜底，create 另用它取当前分支）。
 * 两者都没有 → 报错并给引导，不猜。
 *
 * ## 与 gh CLI 的两处真实行为差异（不藏）
 *
 * 1. **不做「自动推分支」**：`gh pr create` 在分支未推送时会先帮你推上去；REST 不会。
 *    本实现因此**显式报错并引导先 push**，而不是静默失败或悄悄退回去。
 * 2. **reviewDecision 是推导的**：那是 GraphQL 专有字段，REST 没有等价单值。这里由
 *    `GET /pulls/{n}/reviews` 的评审记录聚合出「审查状态」，并注明它是推导值。
 */
import { runCli, checkCwd } from "./exec.js";
import { getToolSecretToken, getToolOAuthMeta } from "./context.js";
import { resolveRepo } from "./github.js";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";

/** 缺仓库上下文时的引导（各 action 拼在自己的错误文案后面）。 */
export const CONTEXT_GUIDANCE =
  "需要 GitHub 仓库上下文：请显式传 repo（格式 owner/repo）或在 git 仓库 cwd 内执行。";

/** 无凭据时的统一引导（只有 OAuth 一条路，没有 keyring 兜底）。 */
export const AUTH_GUIDANCE =
  "尚未完成 GitHub App 授权（进程内没有 OAuth 令牌）：请到 GitHana 设置页点「用 GitHub 登录」后重试。";

/** repo 解析：显式提供则必须合法；空/缺省 → null（走 cwd 推断）。 */
export function parseRepo(repoParam) {
  const raw = repoParam !== undefined && repoParam !== null ? String(repoParam).trim() : "";
  if (!raw) return null;
  const res = resolveRepo(raw);
  if (res.error) return { error: res.error };
  return res;
}

/**
 * 从 cwd 的某个 git remote 推断 owner/repo（github.com 的 https 或 ssh 形态）。
 * remote 缺省 origin：仓库上下文推断用缺省的即可，而 `pr checkout` 要核对**指定的那个远端**
 * 是否指向目标仓库（refs/pull/<n>/head 是每个仓库各自的引用），所以它显式传 remote。
 */
export async function repoFromCwd(cwd, remote = "origin") {
  const r = await runCli("git", ["remote", "get-url", String(remote)], { cwd, timeoutSec: 30 });
  if (!r.ok) return null;
  const url = String(r.stdout || "").trim();
  if (!url) return null;
  const m =
    /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url) ||
    /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** 从 cwd 取当前分支名。 */
export async function currentBranch(cwd) {
  const r = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutSec: 30 });
  if (!r.ok) return { error: (r.message || "读取当前分支失败").split("\n")[0] };
  const name = String(r.stdout || "").trim();
  if (!name || name === "HEAD") {
    return { error: "当前处于分离 HEAD 状态，无法确定分支名：请显式在目标分支上操作，或先切到具名分支。" };
  }
  return { branch: name };
}

/** 取仓库默认分支。 */
export async function defaultBranch(repo, timeoutSec) {
  const r = await callRest(
    [{ url: apiUrl(repo, ""), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return { error: r.message };
  const res = r.results[0];
  if (!res || !res.ok) return { error: describeFailure(res, repo) };
  const db = res.json && res.json.default_branch;
  if (!db) return { error: "无法确定仓库默认分支（响应里没有 default_branch）。" };
  return { branch: String(db) };
}

/** 状态码 → 可读失败说明（含认证引导）。 */
export function describeFailure(res, repoLabel) {
  const status = res && res.status;
  const detail = errorDetail(res);
  if (status === 401) {
    return "GitHub 拒绝（401）：OAuth 令牌无效或已过期。" + AUTH_GUIDANCE + "\nGitHub 原文：" + detail;
  }
  if (status === 403) {
    return "GitHub 拒绝（403）：令牌权限不足或触发了速率限制。\nGitHub 原文：" + detail;
  }
  if (status === 404) {
    return "GitHub 返回 404：" + (repoLabel ? "仓库 " + repoLabel + " 不存在或令牌不可见。" : "目标资源不存在。") +
      "\nGitHub 原文：" + detail;
  }
  if (status === null) {
    return "请求未完成：" + detail;
  }
  return "GitHub 调用失败（HTTP " + status + "）：" + detail;
}

/** 格式化时间 ISO → 本地 yyyy-MM-dd HH:mm */
export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * 由 reviews 记录推导「审查状态」。
 *
 * GitHub 的 REST 没有 reviewDecision（那是 GraphQL 字段）。这里按评审记录聚合：
 * 取每个评审人**最后一条**有状态的评审，任一为 CHANGES_REQUESTED → 请求修改；否则有
 * APPROVED → 已批准；否则有记录 → 有评论；无记录 → 无审查数据。这是推导值，不是平台的
 * 权威裁决（分支保护规则、已 dismiss 的评审都不在这里体现）。
 */
export function reviewSummary(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { key: "NONE", text: "无审查数据（REST 无 reviewDecision，此为评审记录聚合）" };
  }
  const latest = new Map();
  for (const rv of reviews) {
    const who = (rv && rv.user && rv.user.login) || "";
    const state = String((rv && rv.state) || "").toUpperCase();
    if (!who || !state) continue;
    if (state === "COMMENTED") {
      if (!latest.has(who)) latest.set(who, state);
      continue;
    }
    latest.set(who, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return { key: "CHANGES_REQUESTED", text: "请求修改（CHANGES_REQUESTED）" };
  if (states.includes("APPROVED")) return { key: "APPROVED", text: "已批准（APPROVED）" };
  if (states.includes("COMMENTED")) return { key: "COMMENTED", text: "有评论（COMMENTED）" };
  if (states.includes("DISMISSED")) return { key: "DISMISSED", text: "评审已撤销（DISMISSED）" };
  return { key: "NONE", text: "无审查数据（REST 无 reviewDecision，此为评审记录聚合）" };
}

/** REST PR state → 中文可读（status / close / reopen / view 共用同一份渲染）。 */
export function prStateText(pr) {
  const state = String((pr && pr.state) || "?");
  if (pr && pr.merged === true) return "MERGED（已合并）";
  if (state === "open") return "OPEN（打开）" + (pr && pr.draft ? " · 草稿（draft）" : "");
  if (state === "closed") return "CLOSED（已关闭）";
  return state.toUpperCase();
}

/** REST mergeable_state → 中文可读。 */
export function mergeStateText(v) {
  const map = {
    behind: "落后于目标分支（behind）",
    blocked: "被阻断（blocked）",
    clean: "可合并（clean）",
    dirty: "有冲突（dirty）",
    draft: "草稿（draft）",
    has_hooks: "含钩子（has_hooks）",
    unknown: "未知（GitHub 尚在计算，稍后重试）",
    unstable: "检查未通过（unstable）",
  };
  if (v === null || v === undefined || v === "") return "无合并状态";
  return map[String(v).toLowerCase()] || String(v);
}

/**
 * 解析仓库上下文（repo 显式优先，否则从 cwd 的 git remote 推断）。
 *
 * @returns {{ error: string } | { repo: string, repoLabel: string, cwd: string, timeoutSec: * }}
 */
export async function resolveContext(input, label) {
  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return { error: label + " 参数错误：" + repoRes.error };

  // cwd 可选：传了必须存在且为目录
  let cwd = "";
  const cwdParam = input?.cwd;
  if (cwdParam !== undefined && cwdParam !== null && String(cwdParam).trim() !== "") {
    const cwdErr = checkCwd(cwdParam);
    if (cwdErr) return { error: label + " 参数错误：" + cwdErr };
    cwd = String(cwdParam).trim();
  }
  const timeoutSec = input?.timeoutSec;

  let repo = repoRes ? repoRes.owner + "/" + repoRes.repo : "";
  let repoLabel = repo || "（cwd 推断）";
  if (!repo) {
    if (!cwd) {
      return { error: label + " 参数错误：未提供任何仓库上下文。\n" + CONTEXT_GUIDANCE };
    }
    const inferred = await repoFromCwd(cwd);
    if (!inferred) {
      return { error: label + " 无法从 cwd 推断仓库：git remote 里没有可解析的 GitHub 地址。\n" + CONTEXT_GUIDANCE };
    }
    repo = inferred.owner + "/" + inferred.repo;
    repoLabel = repo;
  }

  // 凭据前置检查：令牌由 rest.js 从进程缓存取（DPAPI 解密结果）。这里先判一次，
  // 好给出比 HTTP 401 更直接的引导——只有 OAuth 一条路，没有 keyring 兜底。
  if (!getToolSecretToken()) {
    const meta = getToolOAuthMeta();
    if (meta && meta.needsReauth === true) {
      return {
        error: label + " 需要重新授权：上次令牌刷新失败（refresh_token 已失效或授权被撤销），请到 GitHana 设置页重新点「用 GitHub 登录」。",
      };
    }
    return { error: label + " " + AUTH_GUIDANCE };
  }

  return { repo, repoLabel, cwd, timeoutSec };
}

/**
 * check-runs 响应的**渲染**（`checks` 与 `status` 两个动词都要报检查现状，所以收在这里一处）。
 *
 * conclusion 为空表示还没跑完（status 仍是 queued / in_progress）；success / neutral / skipped
 * 都算通过——neutral 与 skipped 不是失败，把它们算进失败会让「能不能合」判错。
 *
 * @param {*} json `GET /commits/{ref}/check-runs` 的响应体
 * @returns {{ text: string, runs: Array<object>, failed: number, pending: number }}
 */
export function summarizeCheckRuns(json) {
  const runs = json && Array.isArray(json.check_runs) ? json.check_runs : [];
  if (runs.length === 0) return { text: "无检查（check-runs 为空）", runs, failed: 0, pending: 0 };

  let failed = 0;
  let pending = 0;
  let passed = 0;
  for (const run of runs) {
    const conclusion = run && run.conclusion ? String(run.conclusion) : "";
    if (!conclusion) pending += 1;
    else if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") passed += 1;
    else failed += 1;
  }
  const text =
    "共 " + runs.length + " 项（通过 " + passed + " · 失败 " + failed + " · 未完成 " + pending + "）";
  return { text, runs, failed, pending };
}

/**
 * 解析要操作的 PR 编号（prNumber 缺省 = 当前分支关联 PR）。
 *
 * REST 没有「当前分支关联 PR」的语义，所以缺省时先取当前分支、再按 head 过滤；这正是
 * `pr_view` 原本就地做的那件事，其余动词按同一口径共用它。
 *
 * @returns {{ error: string } | { num: number, prNumber: string, branch: string }}
 */
export async function resolvePrNumber(input, label, c = {}) {
  const { repo, repoLabel, cwd, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // prNumber 的"正整数"由 schema 保证：这里只需判断给没给。
  const given = input?.prNumber !== undefined && input?.prNumber !== null ? String(input.prNumber) : "";
  if (given) return { num: Number(given), prNumber: given, branch: "" };

  if (!cwd) {
    return {
      error:
        label + " 参数错误：未传 prNumber，而缺省值需要 cwd 来确定当前分支（REST 无「当前分支关联 PR」语义）。\n" +
        "请传 prNumber，或在 git 仓库 cwd 内执行。",
    };
  }
  const cur = await currentBranch(cwd);
  if (cur.error) return { error: label + " 无法确定当前分支：" + cur.error };

  const listUrl =
    apiUrl(repo, "/pulls") +
    "?state=open&head=" + encodeURIComponent(repo.split("/")[0] + ":" + cur.branch) + "&per_page=1";
  const lr = await callRest([{ url: listUrl, timeoutMs }], { timeoutSec });
  if (!lr.ok) return { error: label + " 执行失败：" + lr.message };
  const lres = lr.results[0];
  if (!lres || !lres.ok) return { error: label + " 执行失败：" + describeFailure(lres, repoLabel) };
  const arr = Array.isArray(lres.json) ? lres.json : [];
  if (arr.length === 0) {
    return { error: label + "：当前分支（" + cur.branch + "）没有打开的关联 PR。可显式传 prNumber 查看指定 PR。" };
  }
  return { num: Number(arr[0].number), prNumber: String(arr[0].number), branch: cur.branch };
}
