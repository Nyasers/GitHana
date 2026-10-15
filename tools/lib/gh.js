// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/gh.js — GitHub 域各名词工具（repo / pr / issue / label）共用的仓库上下文与失败渲染。
 *
 * 这里只放**跨名词共用**的部分：仓库上下文解析、仓库推断、当前分支、默认分支、失败说明、
 * 时间渲染。各名词自己那份请求编排与输出格式留在 tools/actions/<组>/<动词>.js，
 * PR 专有的部分（编号解析、审查聚合、检查计数）留在 tools/lib/pr.js。
 *
 * ## 仓库上下文
 *
 * repo（owner/repo）显式优先；cwd 可选（从 git remote 推断仓库兜底）。两者都没有 → 报错并给
 * 引导，不猜。凭据在发请求前先判一次，好给出比 HTTP 401 更直接的引导（只有 OAuth 一条路，
 * 没有 keyring 兜底）。
 */
import { runCli, checkCwd } from "./exec.js";
import { getToolSecretToken, getToolOAuthMeta } from "./context.js";
import { resolveRepo } from "./github.js";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";

/** 缺仓库上下文时的引导（各 action 拼在自己的错误文案后面）。 */
export const CONTEXT_GUIDANCE =
  "GitHub repository context required: pass repo explicitly (format owner/repo) or run inside a git repository cwd.";

/** 无凭据时的统一引导（只有 OAuth 一条路，没有 keyring 兜底）。 */
export const AUTH_GUIDANCE =
  "GitHub App authorization is not complete yet (no OAuth token in this process): go to the GitHana settings page, click \"Sign in with GitHub\", and retry.";

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
  if (!r.ok) return { error: (r.message || "failed to read the current branch").split("\n")[0] };
  const name = String(r.stdout || "").trim();
  if (!name || name === "HEAD") {
    return { error: "HEAD is detached, so the branch name cannot be determined: operate on a named branch explicitly, or switch to one first." };
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
  if (!db) return { error: "cannot determine the repository default branch (the response has no default_branch)." };
  return { branch: String(db) };
}

/** 状态码 → 可读失败说明（含认证引导）。 */
export function describeFailure(res, repoLabel) {
  const status = res && res.status;
  const detail = errorDetail(res);
  if (status === 401) {
    return "GitHub rejected the request (401): the OAuth token is invalid or has expired. " + AUTH_GUIDANCE + "\nGitHub response: " + detail;
  }
  if (status === 403) {
    return "GitHub rejected the request (403): the token lacks the required permission, or a rate limit was hit.\nGitHub response: " + detail;
  }
  if (status === 404) {
    return "GitHub returned 404: " + (repoLabel ? "repository " + repoLabel + " does not exist or is not visible to the token." : "the target resource does not exist.") +
      "\nGitHub response: " + detail;
  }
  if (status === null) {
    return "the request did not complete: " + detail;
  }
  return "GitHub call failed (HTTP " + status + "): " + detail;
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
 * 只做凭据前置检查（没有仓库上下文可解析时用它，如 `repo create`——仓库还不存在）。
 * @returns {string|null} 通过返回 null，否则返可读引导
 */
export function requireAuth(label) {
  if (getToolSecretToken()) return null;
  const meta = getToolOAuthMeta();
  if (meta && meta.needsReauth === true) {
    return label + " requires re-authorization: the last token refresh failed (the refresh_token is no longer valid or the authorization was revoked). Go to the GitHana settings page and click \"Sign in with GitHub\" again.";
  }
  return label + " " + AUTH_GUIDANCE;
}

/**
 * 解析仓库上下文（repo 显式优先，否则从 cwd 的 git remote 推断）。
 *
 * @returns {{ error: string } | { repo: string, repoLabel: string, cwd: string, timeoutSec: * }}
 */
export async function resolveContext(input, label) {
  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return { error: label + " invalid arguments: " + repoRes.error };

  // cwd 可选：传了必须存在且为目录
  let cwd = "";
  const cwdParam = input?.cwd;
  if (cwdParam !== undefined && cwdParam !== null && String(cwdParam).trim() !== "") {
    const cwdErr = checkCwd(cwdParam);
    if (cwdErr) return { error: label + " invalid arguments: " + cwdErr };
    cwd = String(cwdParam).trim();
  }
  const timeoutSec = input?.timeoutSec;

  let repo = repoRes ? repoRes.owner + "/" + repoRes.repo : "";
  let repoLabel = repo || "(inferred from cwd)";
  if (!repo) {
    if (!cwd) {
      return { error: label + " invalid arguments: no repository context was provided.\n" + CONTEXT_GUIDANCE };
    }
    const inferred = await repoFromCwd(cwd);
    if (!inferred) {
      return { error: label + " cannot infer the repository from cwd: the git remote has no parsable GitHub URL.\n" + CONTEXT_GUIDANCE };
    }
    repo = inferred.owner + "/" + inferred.repo;
    repoLabel = repo;
  }

  // 凭据前置检查：令牌由 rest.js 从进程缓存取（DPAPI 解密结果）。这里先判一次，
  // 好给出比 HTTP 401 更直接的引导——只有 OAuth 一条路，没有 keyring 兜底。
  const authErr = requireAuth(label);
  if (authErr) return { error: authErr };

  return { repo, repoLabel, cwd, timeoutSec };
}
