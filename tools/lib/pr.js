// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/pr.js — PR 四个 action（create / list / view / merge）共用的 REST 调用与仓库解析。
 *
 * 只放**真正共用**的部分：仓库上下文解析、默认分支查询、失败说明、时间与审查状态渲染。
 * 每个 action 自己那份请求编排与输出格式留在 tools/actions/pr-*.js。
 *
 * ## 仓库上下文（收敛前 gh_pr 的口径，逐条不变）
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

/** 从 cwd 的 git remote 推断 owner/repo（github.com 的 https 或 ssh 形态）。 */
export async function repoFromCwd(cwd) {
  const r = await runCli("git", ["remote", "get-url", "origin"], { cwd, timeoutSec: 30 });
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
