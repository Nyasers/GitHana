// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/pr.js — githana_pr 各动词共用的 REST 调用与仓库解析。
 *
 * 跨名词共用的那部分（仓库上下文、默认分支、失败说明、时间渲染）在 tools/lib/gh.js；本模块
 * 把它们原样转出，好让 pr 的动词只 import 一处。这里只放 **PR 专有**的部分：PR 编号解析、
 * 审查状态聚合、检查计数、状态渲染。每个动词自己那份请求编排与输出格式留在
 * tools/actions/pr/<verb>.js。
 *
 * ## 与 gh CLI 的两处真实行为差异（不藏）
 *
 * 1. **不做「自动推分支」**：`gh pr create` 在分支未推送时会先帮你推上去；REST 不会。
 *    本实现因此**显式报错并引导先 push**，而不是静默失败或悄悄退回去。
 * 2. **reviewDecision 是推导的**：那是 GraphQL 专有字段，REST 没有等价单值。这里由
 *    `GET /pulls/{n}/reviews` 的评审记录聚合出「审查状态」，并注明它是推导值。
 */
import { currentBranch, describeFailure } from "./gh.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";

// 跨名词共用（定义在 gh.js）：各动词从本模块 import 同一份，不必知道它其实住在 gh.js。
// 本地已经用到的那两个（currentBranch / describeFailure）按本地绑定转出，其余走 re-export——
// 同一个名字既有本地绑定又 `export … from` 虽然合法，但读起来像两份东西，不必留这个歧义。
export {
  AUTH_GUIDANCE,
  CONTEXT_GUIDANCE,
  defaultBranch,
  fmtTime,
  parseRepo,
  repoFromCwd,
  resolveContext,
} from "./gh.js";
export { currentBranch, describeFailure };

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
