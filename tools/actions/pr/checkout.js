// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/checkout：把 PR 的源分支取到本地并检出（githana_pr 动词）。
 *
 * ## 取法
 *
 * GitHub 在**每个仓库**上都暴露 `refs/pull/<n>/head`——它指向该 PR 的源分支头，fork 来的 PR 也有
 * （这是服务器端的引用，不需要把 fork 加成本地 remote）。所以本动词走
 * `git fetch <remote> pull/<n>/head:<branch>` 再 `git checkout <branch>`，与 gh `pr checkout` 同路，
 * 且**不需要**知道源分支属于谁。
 *
 * ## 两道安全闸
 *
 * 1. **remote 必须真的指向这个 PR 所在的仓库**：`refs/pull/<n>/head` 是**每个仓库各自**的引用，
 *    `n` 在不同仓库里是不同的 PR。若 cwd 的 origin 不是 `repo`，取回来的会是另一个 PR 的分支——
 *    所以先比对，不符就拒绝并说明（可用 remote 参数显式指定别的远端名）。
 * 2. **本地已有同名分支时不覆盖**：直接 `git fetch ... :<branch>` 会在非快进时失败，而
 *    `+`/`--force` 会把本地分支指过去——那会丢本地提交。所以默认只检出已存在的分支并说明它
 *    可能不是最新；要真覆盖得显式给 `force=true`。
 *
 * 会改本地仓库状态（新建/切换分支、更新引用），但不改远端、也不推送。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, repoFromCwd, describeFailure } from "../../lib/pr.js";
import { GIT_FETCH_AUTH_NOTE } from "../../lib/remote-helper-shim.js";

export const command = "checkout";
export const summary = "Fetch a PR's source branch locally and check it out";

export const schema = {
  repo: params.repo,
  // 与 revert 同理：要在本地仓库里做 git 操作，所以 cwd 必填。
  cwd: params.cwd.describe(
    "Absolute path of the local repository (required): checking out requires fetching locally and switching branches",
  ),
  prNumber: params.prNumber.describe("PR number to check out (positive integer), required"),
  branch: z.string().optional().describe("Optional: local branch name, defaults to the PR's source branch name (head.ref)"),
  remote: z.string().optional().describe("Optional: remote name, defaults to origin; it must point at the repository that holds this PR"),
  force: z
    .boolean()
    .optional()
    .describe("Optional: when a local branch with the same name already exists, force the reference to point at the PR's source branch (discards local commits on that branch that are not in the PR; default false)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "Fetch the source branch of a remote GitHub PR into the local repository (cwd) and check it out: creates or switches a local branch and updates a local reference (with force=true it overwrites a same-named local branch); does not change the remote and does not push — confirm cwd and prNumber before running",
  ruleId: "github-toolkit-pr-checkout",
};

/** git 错误 → 中文引导。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/not a git repository/i.test(s)) return "The current directory is not a git repository: run this inside a repository directory.";
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "Remote authentication failed: " + GIT_FETCH_AUTH_NOTE + ".";
  }
  if (/couldn't find remote ref/i.test(s)) {
    return "That pull reference was not found on this remote: confirm that remote points at the repository that actually holds the PR (refs/pull/<n>/head is per-repository).";
  }
  if (/Your local changes|would be overwritten/i.test(s)) {
    return "The working tree has uncommitted changes that conflict with the branch to check out: commit them or git stash first, then retry.";
  }
  return null;
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = String(cwdParam).trim();
  if (!cwd) return label + " argument error: cwd is required (checking out requires fetching locally and switching branches).";

  const num = input.prNumber;
  const remote = input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
    ? String(input.remote).trim()
    : "origin";
  const force = input?.force === true;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // —— 安全闸 1：remote 必须指向这个 PR 所在的仓库 ——
  // 先看该远端名是否存在（不存在时 git 会去当 URL 用，报错很难懂）。
  const remotesR = await runCli("git", ["remote"], { cwd, timeoutSec: 30 });
  if (!remotesR.ok) {
    const raw = ((remotesR.stderr || "") + "\n" + (remotesR.stdout || "")).trim();
    return label + " failed to read the remote list:\n" + (raw || remotesR.message) +
      (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
  }
  const remotes = String(remotesR.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    return (
      label + " argument error: cwd has no remote named " + remote + " (existing: " + (remotes.join(" / ") || "none") + ").\n" +
      "Use the remote parameter to name the right remote, or run git remote add first."
    );
  }

  const inferred = await repoFromCwd(cwd, remote);
  if (!inferred) {
    return (
      label + " cannot verify cwd's repository: the URL of remote " + remote + " is not a resolvable GitHub address.\n" +
      "Checking out relies on refs/pull/<n>/head, which refers to this PR only on the repository that holds it — confirm that remote points at the right place."
    );
  }
  const inferredFull = inferred.owner + "/" + inferred.repo;
  if (inferredFull.toLowerCase() !== String(repo).toLowerCase()) {
    return (
      label + " argument error: cwd's remote " + remote + " points at " + inferredFull + ", while the repository to operate on is " + repo + ".\n" +
      "refs/pull/<n>/head is a per-repository reference, so fetching n on another repository yields a different PR.\n" +
      "Run this in the right repository (or pass repo and remote explicitly to align them)."
    );
  }

  // —— 取 PR 本体：要源分支名 ——
  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " execution failed: " + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + ": PR #" + num + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "";
  const headRepoFull = pr.head && pr.head.repo && pr.head.repo.full_name ? String(pr.head.repo.full_name) : "";
  const headSha = pr.head && pr.head.sha ? String(pr.head.sha) : "";
  if (!headRef) return label + ": the response for PR #" + num + " has no head.ref, so the local branch name cannot be determined.";

  const branch =
    input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== ""
      ? String(input.branch).trim()
      : headRef;

  // —— 安全闸 2：本地已有同名分支 → 默认不覆盖 ——
  const existR = await runCli("git", ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch], { cwd, timeoutSec: 30 });
  const exists = existR.ok;

  if (exists && !force) {
    const checkoutR = await runCli("git", ["checkout", branch], { cwd });
    if (!checkoutR.ok) {
      const raw = ((checkoutR.stderr || "") + "\n" + (checkoutR.stdout || "")).trim();
      return label + " switching to branch " + branch + " failed:\n" + (raw || checkoutR.message) +
        (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
    }
    const localR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutSec: 30 });
    const localSha = localR.ok ? localR.stdout.trim() : "";
    const out = [
      label + " switched to the existing local branch " + branch + " (PR #" + num + " · " + repoLabel + "):",
      "local HEAD: " + (localSha || "?"),
    ];
    if (headSha) out.push("PR source branch HEAD: " + headSha.slice(0, 7));
    out.push(
      localSha && headSha && localSha !== headSha.slice(0, localSha.length)
        ? "note: the local branch may **not** match the PR's latest commit — this verb does not overwrite the local branch by default (to avoid losing local commits). To get the PR's latest state, pass force=true explicitly."
        : "The local branch matches the PR source branch HEAD.",
    );
    return out.join("\n");
  }

  // fetch：把 refs/pull/<n>/head 取成（或覆盖成）本地分支。
  // 非 force 时用 `:<branch>`（非快进会被 git 拒）；force 时用 `+refs/pull/<n>/head:<branch>` 强指。
  const fetchR = exists
    ? await runCli("git", ["fetch", "--force", remote, "+refs/pull/" + num + "/head:refs/heads/" + branch], { cwd })
    : await runCli("git", ["fetch", remote, "refs/pull/" + num + "/head:refs/heads/" + branch], { cwd });
  if (!fetchR.ok) {
    const raw = ((fetchR.stderr || "") + "\n" + (fetchR.stdout || "")).trim();
    return label + " fetching the PR source branch failed (" + remote + " refs/pull/" + num + "/head → " + branch + "):\n" +
      (raw || fetchR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
  }

  const checkoutR = await runCli("git", ["checkout", branch], { cwd });
  if (!checkoutR.ok) {
    const raw = ((checkoutR.stderr || "") + "\n" + (checkoutR.stdout || "")).trim();
    return label + " the fetch succeeded but switching branches failed:\n" + (raw || checkoutR.message) +
      (gitGuide(raw) ? "\n" + gitGuide(raw) : "") +
      "\nThe local branch " + branch + " is in place, so you can git checkout " + branch + " yourself.";
  }

  const out = [
    label + " checked out (PR #" + num + " · " + repoLabel + "):",
    "local branch: " + branch + (branch === headRef ? "" : " (source branch is " + headRef + ")"),
    (exists ? "overwrote an existing local branch with the same name (force=true)" : "created a new local branch") +
      (headRepoFull && headRepoFull.toLowerCase() !== String(repo).toLowerCase() ? " · source branch comes from " + headRepoFull + " (fork)" : ""),
  ];
  if (headSha) out.push("HEAD: " + headSha.slice(0, 7));
  if (pr.html_url) out.push("URL: " + pr.html_url);
  return out.join("\n");
}
