// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/revert：把已合并的 PR 回退掉（githana_pr 动词）。
 *
 * ## 为什么它要走本地 git
 *
 * GitHub 没有「回退一个 PR」的端点——没有 REST，也没有 GraphQL 变更。gh 的 `pr revert` 也是
 * 本地做：从目标分支切一个新分支、`git revert` 那个合并提交、推上去、再开一个 PR 走正常审查。
 * 本动词照同一条路做，所以它**既需要 cwd，也需要能推送**（支撑权限 `contents: write` +
 * `pull_requests: write`，见 spec D7）。
 *
 * ## 步骤与失败面
 *
 *   1. 读 PR：必须是已合并的（未合并没有什么可回退的），取 `merge_commit_sha` 与 `base`；
 *   2. 检查工作区干净（`git status --porcelain` 有输出就停）——切换分支会打断正在进行的工作，
 *      所以宁可拒绝也不悄悄换分支；
 *   3. `git fetch` 目标分支 → 从 `origin/<base>` 切出新分支 `revert-<n>-<原分支>`；
 *   4. `git revert`：合并提交要带 `-m 1`（主线取第一父），squash / rebase 合并出来的提交不是
 *      合并提交，则不带 `-m`——带错会直接失败，所以先判父提交数；
 *   5. `git push -u` 新分支；
 *   6. REST `POST /pulls` 开回退 PR。
 *
 * 任一步失败都回报做了到哪一步、以及**留下了什么**（新分支是否已建、是否停在它上面）。
 * 这个动词会改本地仓库状态（新分支 + 一个新提交）并推送远端，属于写操作。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure } from "../../lib/pr.js";
import { GIT_AUTH_NOTE, GIT_FETCH_AUTH_NOTE } from "../../lib/remote-helper-shim.js";

export const command = "revert";
export const summary = "Revert a merged PR (local revert + new branch + revert PR)";

export const schema = {
  repo: params.repo,
  // 与其它 pr_* 不同：回退要在本地仓库里做 git 操作，所以 cwd 是必填的。
  cwd: params.cwd.describe(
    "Absolute path of the local repository (required): reverting requires switching branches locally, running git revert and pushing; REST has no corresponding endpoint",
  ),
  prNumber: params.prNumber.describe("PR number to revert (must be a merged PR)"),
  branch: z.string().optional().describe("Optional: revert branch name, defaults to revert-<PR number>-<original branch name>"),
  title: z.string().optional().describe("Optional: title of the revert PR, defaults to Revert \"<original PR title>\""),
  body: z.string().optional().describe("Optional: body of the revert PR, by default noting which PR is being reverted"),
  draft: z.boolean().optional().describe("Optional: create the revert PR as a draft"),
  remote: z.string().optional().describe("Optional: remote name, defaults to origin"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_remote",
  summary:
    "Revert a merged PR: in the local repository (cwd) branch off the base branch, git revert that merge commit and push to the remote, then create a revert PR on GitHub — modifies local repository state (a new branch and a new commit), pushes to the remote and creates a remote PR; confirm cwd, repo and prNumber before running",
  ruleId: "github-toolkit-pr-revert",
};

/**
 * git 错误 → 中文引导。本动词**既 fetch 也 push**，两者都走本 App 自写的 remote helper
 * （取侧 `githana::` 报 stateless-connect、push 侧 `githana-push::` 报 connect），所以认证失败
 * 时给同一份引导，不把调用方引到两条不同的路上。
 */
function gitGuide(text) {
  const s = String(text || "");
  if (/not a git repository/i.test(s)) return "The current directory is not a git repository: run this inside a repository directory.";
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "Remote authentication failed (both fetch and push go through this App's remote helper):\n  · " + GIT_AUTH_NOTE + ".\n  · " + GIT_FETCH_AUTH_NOTE + ".";
  }
  if (/non-fast-forward|fetch first|rejected/i.test(s)) {
    return "The remote rejected the push: pull and merge the remote changes, then retry.";
  }
  if (/CONFLICT|conflict/i.test(s)) {
    return "git revert hit a conflict: those lines have already been changed on the base branch. Resolve it by hand (or open a separate PR for the relevant changes); this verb does not make that decision for you.";
  }
  return null;
}

/** 组装失败文案：git 原文 + 引导。 */
function gitFailure(label, what, r) {
  const raw = ((r.stderr || "") + "\n" + (r.stdout || "")).trim();
  const text = label + " " + what + " failed (exit code " + r.exitCode + "):\n" + (raw || r.message || "unknown error");
  const guide = gitGuide(raw);
  return guide ? text + "\n" + guide : text;
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  // 回退必须落到一个本地克隆：显式传 cwd，不做隐式推断（与 exec / commit / push 同口径）。
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = String(cwdParam).trim();
  if (!cwd) {
    return label + " argument error: cwd is required (reverting requires switching branches locally, reverting and pushing).";
  }

  const num = input.prNumber;
  const remote = input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
    ? String(input.remote).trim()
    : "origin";
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // —— 1) 读 PR：必须已合并 ——
  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " execution failed: " + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + ": PR #" + num + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  if (pr.merged !== true) {
    return (
      label + ": PR #" + num + " has not been merged yet (state=" + String(pr.state || "?") + "), so there is no merge commit to revert.\n" +
      "Reverting is only meaningful for a merged PR; if you merely want to abandon these changes, close it with githana_pr(action=\"close\")."
    );
  }
  const mergeSha = pr.merge_commit_sha ? String(pr.merge_commit_sha) : "";
  const baseRef = pr.base && pr.base.ref ? String(pr.base.ref) : "";
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "";
  const prTitle = pr.title ? String(pr.title) : "";
  if (!mergeSha || !baseRef) {
    return label + ": the response for PR #" + num + " is missing merge_commit_sha or base.ref, so it cannot be reverted locally.";
  }

  // —— 2) 工作区必须干净：切分支会打断正在进行的工作，所以宁可拒绝也不悄悄换分支 ——
  const statusR = await runCli("git", ["status", "--porcelain"], { cwd, timeoutSec: 30 });
  if (!statusR.ok) return gitFailure(label, "reading the working tree status", statusR);
  if (String(statusR.stdout || "").trim() !== "") {
    return (
      label + ": the working tree in cwd is not clean (it has uncommitted changes), so branches cannot safely be switched to revert.\n" +
      "Commit or stash (git stash) those changes first, then retry. Reverting switches branches locally and produces a new commit."
    );
  }

  const branchName =
    input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== ""
      ? String(input.branch).trim()
      : "revert-" + num + (headRef ? "-" + headRef : "");

  const steps = [label + " revert PR #" + num + " (" + repoLabel + " · merge commit " + mergeSha.slice(0, 7) + "):"];

  // —— 3) fetch + 从远端目标分支切新分支 ——
  const fetchR = await runCli("git", ["fetch", remote, baseRef], { cwd });
  if (!fetchR.ok) return gitFailure(label, "fetch " + remote + " " + baseRef, fetchR);

  const checkoutR = await runCli("git", ["checkout", "-b", branchName, remote + "/" + baseRef], { cwd });
  if (!checkoutR.ok) {
    const raw = ((checkoutR.stderr || "") + "\n" + (checkoutR.stdout || "")).trim();
    if (/already exists/i.test(raw)) {
      return (
        label + ": branch " + branchName + " already exists and cannot be reused for the revert (to avoid overwriting existing work).\n" +
        "Use the branch parameter to pick another name, or delete that branch first."
      );
    }
    return gitFailure(label, "branching " + branchName + " off " + remote + "/" + baseRef, checkoutR);
  }
  steps.push("  1. created new branch " + branchName + " from " + remote + "/" + baseRef);

  /** 回退失败时的收尾说明：新分支已经建出来了，得让调用方知道留下了什么。 */
  const leftover = "  state left behind: the local branch " + branchName + " has been created and is checked out (not pushed). To discard it, run git checkout " + baseRef + " && git branch -D " + branchName + ".";

  // —— 4) git revert：合并提交要带 -m 1，squash / rebase 出来的提交不带 ——
  // 先判父提交数（rev-list --parents -n 1 输出 "sha p1 [p2 ...]"），带错 -m 会直接失败。
  const parentsR = await runCli("git", ["rev-list", "--parents", "-n", "1", mergeSha], { cwd });
  if (!parentsR.ok) return gitFailure(label, "reading the parents of commit " + mergeSha.slice(0, 7), parentsR);
  const parentCount = String(parentsR.stdout || "").trim().split(/\s+/).filter(Boolean).length - 1;
  if (parentCount < 1) {
    return label + ": commit " + mergeSha.slice(0, 7) + " was not found in cwd (this repository may not have fetched that commit yet).\n" + leftover;
  }
  const revertArgs = ["revert", "--no-edit"];
  if (parentCount >= 2) revertArgs.push("-m", "1");
  revertArgs.push(mergeSha);
  const revertR = await runCli("git", revertArgs, { cwd });
  if (!revertR.ok) {
    const text = gitFailure(label, "git revert " + mergeSha.slice(0, 7), revertR);
    // revert 冲突会留下冲突标记与进行中的 revert 状态，必须说清怎么退出来。
    if (/CONFLICT|conflict/i.test((revertR.stdout || "") + (revertR.stderr || ""))) {
      return text + "\n  To give up and return to a clean state: git revert --abort && git checkout " + baseRef + " && git branch -D " + branchName + ".";
    }
    return text + "\n" + leftover;
  }
  steps.push("  2. git revert done (" + (parentCount >= 2 ? "merge commit, -m 1" : "non-merge commit, no -m") + ")");

  // —— 5) 推新分支 ——
  const pushR = await runCli("git", ["push", "-u", remote, branchName], { cwd });
  if (!pushR.ok) return gitFailure(label, "pushing branch " + branchName, pushR) + "\n" + leftover;
  steps.push("  3. pushed the new branch " + branchName + " (-u sets up tracking)");

  // —— 6) 开回退 PR ——
  const title =
    input?.title !== undefined && input?.title !== null && String(input.title).trim() !== ""
      ? String(input.title).trim()
      : 'Revert "' + prTitle + '"';
  const body =
    input?.body !== undefined && input?.body !== null
      ? String(input.body)
      : "Revert PR #" + num + " (merge commit " + mergeSha + ").\n\nGenerated by GitHana's githana_pr(action=\"revert\").";

  const payload = { title, head: branchName, base: baseRef, body };
  if (input?.draft === true) payload.draft = true;

  const cr = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/pulls"), json: payload, timeoutMs }],
    { timeoutSec },
  );
  const cres = cr.ok ? cr.results[0] : null;
  if (!cres || !cres.ok) {
    // 分支已经推上去了，只是 PR 没开成——如实说明，别让调用方以为整件事没发生。
    const detail = cres ? describeFailure(cres, repoLabel) : cr.message;
    return (
      label + " partially done:\n" + steps.join("\n") + "\n" +
      "  4. creating the revert PR failed — " + detail + "\n" +
      "the branch " + branchName + " is already on the remote (and locally checked out), so you can create the PR later with githana_pr(action=\"create\") (base=" + baseRef + ")."
    );
  }

  const created = cres.json && typeof cres.json === "object" ? cres.json : {};
  steps.push(
    "  4. created the revert PR #" + (created.number !== undefined ? String(created.number) : "?") +
      (created.html_url ? ": " + String(created.html_url) : ""),
  );
  steps.push("revert PR title: " + title + " · branch: " + branchName + " → " + baseRef);
  steps.push("note: the local repository is now on branch " + branchName + " (a revert branch does not merge back automatically; it still goes through the normal review).");
  return steps.join("\n");
}
