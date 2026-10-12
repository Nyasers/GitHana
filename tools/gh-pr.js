// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * gh_pr：PR 生命周期工具（v2 场景写）——action 子模块 create/list/view/merge。
 *
 * 一工具内按 action 分支（照 dsh_session 混合 action 先例：整体标 external_side_effect，
 * 含只读 action 也送审，避免子模块拆分膨胀工具面）。GitHub 域调用全部走自写 REST 通道
 * （tools/lib/rest.js），不经 gh CLI。
 *
 * 公共上下文：repo（owner/repo）显式优先；cwd 可选（从 git remote 推断仓库兜底，并用于
 * 取当前分支）。
 *
 * - create：base?（缺省取仓库默认分支）、title?（缺省取 cwd 内 HEAD commit 首行；cwd 与 title
 *   均缺 → 引导）、body?、draft?；head 取 cwd 的当前分支（REST 必填）。输出新建 PR 的 URL 与编号。
 *   走 REST `POST /repos/{o}/{r}/pulls`——**这是 App 角标的来源**：GraphQL 的 createPullRequest
 *   不写 `performed_via_github_app`，REST 写。
 * - list：state?（open 默认/closed/all）+ limit?（默认 10 ≤50）；输出编号/标题/分支/state/时间 列表。
 * - view：prNumber?（缺省 = 当前分支关联 PR）+ 输出 title/state/head→base/审查状态/合并状态/URL/body（截断）。
 * - merge：prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?。合并不可撤销，描述注明。
 *
 * ## 与 gh CLI 的两处真实行为差异（不藏）
 *
 * 1. **不做「自动推分支」**：`gh pr create` 在分支未推送时会先帮你推上去；REST 不会。
 *    本实现因此**显式报错并引导先 push**，而不是静默失败或悄悄退回去。
 * 2. **reviewDecision 是推导的**：那是 GraphQL 专有字段，REST 没有等价单值。这里由
 *    `GET /pulls/{n}/reviews` 的评审记录聚合出「审查状态」，并注明它是推导值。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { initToolContext, getToolSecretToken, getToolOAuthMeta } from "./lib/context.js";
import { resolveRepo, validatePositiveInt } from "./lib/github.js";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "./lib/rest.js";

export const name = "gh_pr";

export const description = [
  "GitHub Pull Request 生命周期工具（action 子模块：create/list/view/merge）。走自写 REST 通道。",
  "repo 可选（格式 owner/repo，显式优先）；cwd 可选（从 git remote 推断仓库兜底，create 另用它取当前分支）。",
  "create：base?（缺省取仓库默认分支）+ title?（缺省取 cwd 内 HEAD commit 首行，cwd 与 title 均缺则引导）",
  "+ body? + draft?，输出新 PR 的 URL 与编号（创建是远端写操作）。分支须已推送到远端，否则明确报错。",
  "list：state?（open 默认/closed/all）+ limit?（默认 10，1~50），输出编号/标题/分支/state/时间。",
  "view：prNumber?（正整数；缺省 = 当前分支关联 PR），输出状态/分支/审查/合并/URL/正文。",
  "merge：prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?（合并后删源分支）。",
  "注意：merge 合并 PR 不可撤销（会合并代码并可能删除源分支），执行前请确认编号与参数；本工具无交互提示。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "github_pr",
    summary:
      "操作 GitHub 远端 PR（自写 REST 通道）：create 创建 PR、merge 合并 PR（不可撤销，可带 deleteBranch 删除源分支）均修改 GitHub 远端状态；list/view 为只读查询但随本工具整体送审。执行前请确认 repo/prNumber 与参数",
    ruleId: "github-toolkit-gh-pr",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "view", "merge"],
      description: "子模块：create=创建 PR / list=列出 PR / view=查看 PR（详情）/ merge=合并 PR（不可撤销）",
    },
    repo: {
      type: "string",
      description: "可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；显式传则优先于 cwd 推断",
    },
    cwd: {
      type: "string",
      description: "可选：本地仓库绝对路径（推断仓库；create 另用它取当前分支与缺省 title）",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 60，上限 600",
    },
    base: {
      type: "string",
      description: "仅 create：目标分支（缺省取仓库默认分支，如 main）",
    },
    title: {
      type: "string",
      description: "仅 create：PR 标题（缺省取 cwd 内 HEAD commit 首行；cwd 与 title 均缺则返回引导）",
    },
    body: {
      type: "string",
      description: "仅 create：PR 正文（可选，支持 Markdown 与中文）",
    },
    draft: {
      type: "boolean",
      description: "仅 create：以草稿（draft）创建 PR",
    },
    state: {
      type: "string",
      enum: ["open", "closed", "all"],
      description: "仅 list：PR 状态过滤，默认 open",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "仅 list：返回条数，默认 10，上限 50",
    },
    prNumber: {
      type: "integer",
      minimum: 1,
      description: "view/merge：PR 编号（正整数）；view 缺省 = 当前分支关联 PR；merge 必填",
    },
    method: {
      type: "string",
      enum: ["merge", "squash", "rebase"],
      description: "仅 merge：合并方式（默认 merge）",
    },
    deleteBranch: {
      type: "boolean",
      description: "仅 merge：合并后删除源分支",
    },
  },
  required: ["action"],
};

const CONTEXT_GUIDANCE =
  "gh_pr 需要 GitHub 仓库上下文：请显式传 repo（格式 owner/repo）或在 git 仓库 cwd 内执行。";

/** 无凭据时的统一引导（去 gh 后不再有 keyring 兜底，只有 OAuth 一条）。 */
const AUTH_GUIDANCE =
  "尚未完成 GitHub App 授权（进程内没有 OAuth 令牌）：请到 GitHana 设置页点「用 GitHub 登录」后重试。";

/** repo 解析：显式提供则必须合法；空/缺省 → null（走 cwd 推断）。 */
function parseRepo(repoParam) {
  const raw = repoParam !== undefined && repoParam !== null ? String(repoParam).trim() : "";
  if (!raw) return null;
  const res = resolveRepo(raw);
  if (res.error) return { error: res.error };
  return res;
}

/** 从 cwd 的 git remote 推断 owner/repo（github.com 的 https 或 ssh 形态）。 */
async function repoFromCwd(cwd) {
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
async function currentBranch(cwd) {
  const r = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutSec: 30 });
  if (!r.ok) return { error: (r.message || "读取当前分支失败").split("\n")[0] };
  const name = String(r.stdout || "").trim();
  if (!name || name === "HEAD") {
    return { error: "当前处于分离 HEAD 状态，无法确定分支名：请显式在目标分支上操作，或先切到具名分支。" };
  }
  return { branch: name };
}

/** 取仓库默认分支。 */
async function defaultBranch(repo, timeoutSec) {
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
function describeFailure(res, repoLabel) {
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
function fmtTime(iso) {
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
function reviewSummary(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return { key: "NONE", text: "无审查数据（REST 无 reviewDecision，此为评审记录聚合）" };
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
function mergeStateText(v) {
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

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const action = String(input?.action ?? "").trim();
  if (!["create", "list", "view", "merge"].includes(action)) {
    return "gh_pr 参数错误：action 必须是 create / list / view / merge（收到：" + (action || "空") + "）。";
  }

  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return "gh_pr 参数错误：" + repoRes.error;

  // cwd 可选：传了必须存在且为目录
  let cwd = "";
  const cwdParam = input?.cwd;
  if (cwdParam !== undefined && cwdParam !== null && String(cwdParam).trim() !== "") {
    const cwdErr = checkCwd(cwdParam);
    if (cwdErr) return "gh_pr 参数错误：" + cwdErr;
    cwd = String(cwdParam).trim();
  }
  const timeoutSec = input?.timeoutSec;

  // 仓库上下文：repo 显式优先，否则从 cwd 的 git remote 推断（gh CLI 以前自己做这件事）。
  let repo = repoRes ? repoRes.owner + "/" + repoRes.repo : "";
  let repoLabel = repo || "（cwd 推断）";
  if (!repo) {
    if (!cwd) {
      return "gh_pr（action=" + action + "）参数错误：未提供任何仓库上下文。\n" + CONTEXT_GUIDANCE;
    }
    const inferred = await repoFromCwd(cwd);
    if (!inferred) {
      return (
        "gh_pr 无法从 cwd 推断仓库：git remote 里没有可解析的 GitHub 地址。\n" + CONTEXT_GUIDANCE
      );
    }
    repo = inferred.owner + "/" + inferred.repo;
    repoLabel = repo;
  }

  // 凭据前置检查：令牌由 rest.js 从进程缓存取（DPAPI 解密结果）。这里先判一次，
  // 好给出比 HTTP 401 更直接的引导——去 gh 之后没有 keyring 兜底，只有 OAuth 一条路。
  if (!getToolSecretToken()) {
    const meta = getToolOAuthMeta();
    if (meta && meta.needsReauth === true) {
      return "gh_pr 需要重新授权：上次令牌刷新失败（refresh_token 已失效或授权被撤销），请到 GitHana 设置页重新点「用 GitHub 登录」。";
    }
    return "gh_pr " + AUTH_GUIDANCE;
  }

  try {
    if (action === "create") return await doCreate(input, { cwd, repo, repoLabel, timeoutSec });
    if (action === "list") return await doList(input, { repo, repoLabel, timeoutSec });
    if (action === "view") return await doView(input, { cwd, repo, repoLabel, timeoutSec });
    return await doMerge(input, { repo, repoLabel, timeoutSec });
  } catch (e) {
    return "gh_pr（action=" + action + "）执行异常：" + (e && e.message ? e.message : String(e));
  }
}

/** create：head = cwd 当前分支；base 缺省取仓库默认分支；title 缺省取 HEAD commit 首行。 */
async function doCreate(input, { cwd, repo, repoLabel, timeoutSec }) {
  let title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) {
    if (!cwd) {
      return "gh_pr create 参数错误：title 缺省需要 cwd（取当前分支 HEAD commit 首行），但未传 cwd。请传 title 或 cwd。";
    }
    const headR = await runCli("git", ["log", "-1", "--format=%s"], { cwd, timeoutSec: 30 });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet/i.test(raw)) {
        return "gh_pr create 无法推导 title：cwd 仓库尚无提交（HEAD 不存在）。请显式传 title。";
      }
      if (/not a git repository/i.test(raw)) {
        return "gh_pr create：cwd 不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请传仓库 cwd 或显式 title+repo。";
      }
      return "gh_pr create 读取 HEAD title 失败：" + (raw || headR.message);
    }
    title = headR.stdout.trim();
    if (!title) {
      return "gh_pr create 无法推导 title：HEAD commit 无首行内容，请显式传 title。";
    }
  }

  // head：REST 必填，取 cwd 当前分支（gh CLI 以前自己推断）。
  let head = "";
  if (cwd) {
    const cur = await currentBranch(cwd);
    if (cur.error) return "gh_pr create 无法确定源分支：" + cur.error;
    head = cur.branch;
  } else {
    return (
      "gh_pr create 参数错误：缺少 cwd，无法确定要提交哪个分支（REST 创建 PR 必须显式给出源分支）。\n" +
      "请传 cwd（在目标分支所在仓库内），或在 git 仓库 cwd 内执行。"
    );
  }

  // base：缺省取仓库默认分支。
  let base = input?.base !== undefined && input?.base !== null ? String(input.base).trim() : "";
  if (!base) {
    const db = await defaultBranch(repo, timeoutSec);
    if (db.error) return "gh_pr create 无法确定目标分支：" + db.error;
    base = db.branch;
  }

  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";
  const payload = { title, head, base };
  if (body.trim()) payload.body = body;
  if (input?.draft === true) payload.draft = true;

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/pulls"), json: payload, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return "gh_pr create 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    // 分支未推送是这条路上最常见的失败，单独给引导（REST 不做 gh 的自动推分支）。
    const detail = errorDetail(res);
    const notPushed =
      res && res.status === 422 && /"field"\s*:\s*"head"|head.*invalid|No commits between/i.test(JSON.stringify(res.json || "")) ;
    if (notPushed) {
      return (
        "gh_pr create 执行失败：源分支 " + head + " 在远端不存在或没有新提交。\n" +
        "REST 创建 PR 要求分支已推送到远端（本工具不做自动推送）：请先 git_push 该分支，再重试。\n" +
        "GitHub 原文：" + detail
      );
    }
    return "gh_pr create 执行失败：" + describeFailure(res, repoLabel) +
      (res && res.status === 422 ? "\n（422 常见原因：分支未推送、base 分支不存在、或同分支已有打开的 PR）" : "");
  }

  const pr = res.json && typeof res.json === "object" ? res.json : {};
  const number = pr.number !== undefined && pr.number !== null ? String(pr.number) : "?";
  const url = pr.html_url ? String(pr.html_url) : "";

  // 归因：查 issue 表示（角标读的那一层）。查不到就如实说未确认，不假装。
  let appSlug = "";
  let attributionChecked = false;
  if (pr.number !== undefined && pr.number !== null) {
    const ar = await callRest(
      [{ url: apiUrl(repo, "/issues/" + String(pr.number)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
      { timeoutSec },
    );
    const ares = ar.ok ? ar.results[0] : null;
    if (ares && ares.ok && ares.json) {
      attributionChecked = true;
      const app = ares.json.performed_via_github_app;
      if (app && app.slug) appSlug = String(app.slug);
    }
  }

  const lines = ["gh_pr create 完成："];
  if (url) {
    lines.push("PR URL：" + url);
    lines.push("PR 编号：#" + number);
  } else {
    lines.push("（响应里没有 html_url——见下方原始输出）");
    lines.push(String(res.text || "").slice(0, 800));
  }
  lines.push("标题：" + title);
  lines.push("分支：" + head + " → " + base + "（" + repoLabel + "）");
  if (body.trim()) lines.push("body 长度：" + body.length + " 字符");
  if (input?.draft === true) lines.push("草稿：是");
  // 角标归因：这条是本次改造的目标，如实回报（没确认也说明白了，不假装）。
  lines.push(
    appSlug
      ? "App 归因：performed_via_github_app = " + appSlug + "（PR 页会显示 App 角标）"
      : attributionChecked
        ? "App 归因：issue 表示里 performed_via_github_app 为空（角标不显示；通常是令牌不是 GitHub App 的 user access token）"
        : "App 归因：未能核对（查询 issue 表示失败，不影响 PR 已创建）",
  );
  return lines.join("\n");
}

/** list：GET /repos/{o}/{r}/pulls?state=&per_page=&sort=created&direction=desc */
async function doList(input, { repo, repoLabel, timeoutSec }) {
  const state = input?.state !== undefined && input?.state !== null ? String(input.state).trim() : "open";
  if (!["open", "closed", "all"].includes(state)) {
    return "gh_pr list 参数错误：state 必须是 open / closed / all（收到：" + state + "）。";
  }
  let limit = 10;
  if (input?.limit !== undefined && input?.limit !== null && input?.limit !== "") {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n <= 0) return "gh_pr list 参数错误：limit 必须是正整数。";
    limit = Math.min(50, n);
  }

  const url =
    apiUrl(repo, "/pulls") +
    "?state=" + encodeURIComponent(state) +
    "&sort=created&direction=desc&per_page=" + String(limit);
  const r = await callRest([{ url, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }], { timeoutSec });
  if (!r.ok) return "gh_pr list 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) return "gh_pr list 执行失败：" + describeFailure(res, repoLabel);

  const items = Array.isArray(res.json) ? res.json : [];
  if (items.length === 0) {
    return "gh_pr list（" + repoLabel + " · state=" + state + "）：没有匹配的 PR。";
  }
  const out = ["gh_pr list（" + repoLabel + " · state=" + state + " · " + items.length + " 条）："];
  for (const it of items) {
    const head = it && it.head && it.head.ref ? it.head.ref : "?";
    out.push(
      "#" + it.number + " [" + (it.state || "?") + (it.draft ? "·draft" : "") + "] " + head +
      " · " + fmtTime(it.created_at) + " · " + (it.title || ""),
    );
    if (it.html_url) out.push("  " + it.html_url);
  }
  return out.join("\n");
}

/** view：PR 详情 + reviews 聚合。prNumber 缺省时用当前分支查（REST 没有「当前分支关联 PR」的语义）。 */
async function doView(input, { cwd, repo, repoLabel, timeoutSec }) {
  let numStr = "";
  if (input?.prNumber !== undefined && input?.prNumber !== null && input?.prNumber !== "") {
    const numRes = validatePositiveInt(input.prNumber, "prNumber");
    if (numRes.error) return "gh_pr view 参数错误：" + numRes.error;
    numStr = String(numRes.value);
  }

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  if (!numStr) {
    // 缺省 = 当前分支关联 PR：先取当前分支，再按 head 过滤。
    if (!cwd) {
      return (
        "gh_pr view 参数错误：未传 prNumber，而缺省值需要 cwd 来确定当前分支（REST 无「当前分支关联 PR」语义）。\n" +
        "请传 prNumber，或在 git 仓库 cwd 内执行。"
      );
    }
    const cur = await currentBranch(cwd);
    if (cur.error) return "gh_pr view 无法确定当前分支：" + cur.error;
    const listUrl =
      apiUrl(repo, "/pulls") + "?state=open&head=" + encodeURIComponent(repo.split("/")[0] + ":" + cur.branch) + "&per_page=1";
    const lr = await callRest([{ url: listUrl, timeoutMs }], { timeoutSec });
    if (!lr.ok) return "gh_pr view 执行失败：" + lr.message;
    const lres = lr.results[0];
    if (!lres || !lres.ok) return "gh_pr view 执行失败：" + describeFailure(lres, repoLabel);
    const arr = Array.isArray(lres.json) ? lres.json : [];
    if (arr.length === 0) {
      return "gh_pr view：当前分支（" + cur.branch + "）没有打开的关联 PR。可显式传 prNumber 查看指定 PR。";
    }
    numStr = String(arr[0].number);
  }

  const r = await callRest(
    [
      { id: "pr", url: apiUrl(repo, "/pulls/" + numStr), timeoutMs },
      { id: "reviews", url: apiUrl(repo, "/pulls/" + numStr + "/reviews"), timeoutMs, paginate: true },
    ],
    { timeoutSec },
  );
  if (!r.ok) return "gh_pr view 执行失败：" + r.message;
  const prRes = r.results.find((x) => x.id === "pr");
  const rvRes = r.results.find((x) => x.id === "reviews");
  if (!prRes || !prRes.ok) {
    const st = prRes && prRes.status;
    if (st === 404) return "gh_pr view：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    return "gh_pr view 执行失败：" + describeFailure(prRes, repoLabel);
  }

  const pr = prRes.json && typeof prRes.json === "object" ? prRes.json : {};
  const author = pr.user && pr.user.login ? "@" + pr.user.login : "?";
  const headRef = pr.head && pr.head.ref ? pr.head.ref : "?";
  const baseRef = pr.base && pr.base.ref ? pr.base.ref : "?";
  const review = reviewSummary(rvRes && rvRes.ok ? rvRes.json : []);

  const out = [];
  out.push("PR #" + pr.number + "：「" + (pr.title || "（无标题）") + "」");
  out.push(
    "状态：" + String(pr.state || "?").toUpperCase() + (pr.draft ? "（草稿 draft）" : "") +
    (pr.merged ? "（已合并）" : "") +
    " · 分支：" + headRef + " → " + baseRef +
    " · 作者：" + author,
  );
  out.push("审查：" + review.text + " · 合并：" + mergeStateText(pr.mergeable_state));
  if (pr.created_at) out.push("创建于：" + fmtTime(pr.created_at) + (pr.merged_at ? " · 合并于：" + fmtTime(pr.merged_at) : ""));
  if (pr.html_url) out.push("URL：" + pr.html_url);
  const stats =
    (pr.commits !== undefined ? "提交 " + pr.commits : "") +
    (pr.changed_files !== undefined ? " · 文件 " + pr.changed_files : "") +
    (pr.additions !== undefined ? " · +" + pr.additions : "") +
    (pr.deletions !== undefined ? " / -" + pr.deletions : "");
  if (stats) out.push("规模：" + stats);
  const body = pr.body !== null && pr.body !== undefined ? String(pr.body) : "";
  const BODY_MAX = 2000;
  out.push("");
  out.push("—— 正文" + (body.length > BODY_MAX ? "（截断，共 " + body.length + " 字符）" : "") + " ——");
  out.push(body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body) : "（无正文）");
  return out.join("\n");
}

/** merge：PUT /pulls/{n}/merge，成功后再取一次终态确认；deleteBranch 走 git refs 删除。 */
async function doMerge(input, { repo, repoLabel, timeoutSec }) {
  const numRes = validatePositiveInt(input?.prNumber, "prNumber");
  if (numRes.error) return "gh_pr merge 参数错误：" + numRes.error + "（merge 必须指定要合并的 PR 编号）。";
  const num = numRes.value;

  const method = input?.method !== undefined && input?.method !== null ? String(input.method).trim() : "merge";
  if (!["merge", "squash", "rebase"].includes(method)) {
    return "gh_pr merge 参数错误：method 必须是 merge / squash / rebase（收到：" + method + "）。";
  }
  const deleteBranch = input?.deleteBranch === true;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 合并前取一次源分支名（deleteBranch 要用，且合并后 head 仍可读，这里取一次更稳）。
  let headRef = "";
  if (deleteBranch) {
    const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
    const pr = prRes.ok && prRes.results[0] && prRes.results[0].json ? prRes.results[0].json : null;
    if (pr && pr.head && pr.head.ref) headRef = String(pr.head.ref);
  }

  const mr = await callRest(
    [{ method: "PUT", url: apiUrl(repo, "/pulls/" + num + "/merge"), json: { merge_method: method }, timeoutMs }],
    { timeoutSec },
  );
  if (!mr.ok) return "gh_pr merge 执行失败（PR #" + num + "）：" + mr.message;
  const mres = mr.results[0];
  const mjson = mres && mres.json ? mres.json : null;
  const merged = Boolean(mjson && mjson.merged);

  if (!mres || !mres.ok || !merged) {
    const detail = errorDetail(mres);
    const st = mres && mres.status;
    if (/already merged/i.test(detail)) {
      return "gh_pr merge：PR #" + num + " 已经合并（不可重复合并）。\n" + detail;
    }
    if (st === 405) {
      return "gh_pr merge：PR #" + num + " 当前不可合并（405）。常见原因：有冲突、必需检查未通过、或缺少必需审查。\nGitHub 原文：" + detail;
    }
    if (st === 409) {
      return "gh_pr merge：PR #" + num + " 合并冲突（409）：源分支与目标分支有冲突，需先解决。\nGitHub 原文：" + detail;
    }
    return "gh_pr merge 执行失败（PR #" + num + "）：" + describeFailure(mres, repoLabel);
  }

  const out = [
    "gh_pr merge 已执行（PR #" + num + " · " + repoLabel + " · method=" + method + (deleteBranch ? " · deleteBranch" : "") + "）：",
    "状态：MERGED（已合并）" + (mjson && mjson.message ? " · " + String(mjson.message) : ""),
  ];

  // 删源分支：DELETE /repos/{o}/{r}/git/refs/heads/{branch}
  if (deleteBranch) {
    if (!headRef) {
      out.push("源分支删除：未能取到源分支名（跳过删除）。");
    } else {
      const dr = await callRest(
        [{ method: "DELETE", url: apiUrl(repo, "/git/refs/heads/" + encodeURIComponent(headRef)), timeoutMs }],
        { timeoutSec },
      );
      const dres = dr.ok ? dr.results[0] : null;
      if (dres && (dres.ok || dres.status === 404 || dres.status === 422)) {
        out.push("源分支：" + headRef + " 已删除" + (dres.status === 404 ? "（本来就不存在）" : ""));
      } else {
        out.push("源分支：" + headRef + " 删除失败——" + (dres ? describeFailure(dres, repoLabel) : dr.message));
      }
    }
  }

  // 终态确认（合并是异步落地，取一次 state/merged 更可靠）。
  const conf = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  const cp = conf.ok && conf.results[0] && conf.results[0].json ? conf.results[0].json : null;
  if (cp) {
    out.push("确认：state=" + String(cp.state || "?").toUpperCase() + (cp.merged ? " · merged=true" : "") +
      (cp.merged_at ? " · 合并于 " + fmtTime(cp.merged_at) : ""));
    if (cp.html_url) out.push("URL：" + cp.html_url);
  }
  return out.join("\n");
}
