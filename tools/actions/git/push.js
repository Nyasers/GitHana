// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * git/push：推送本地提交到远端（githana_git 动词）。
 *
 * 语义：
 * - cwd 必填（仓库）；branch 缺省 = 当前分支（git rev-parse --abbrev-ref HEAD）；
 *   remote 缺省 "origin"；branch 未指定时简化为 "git push <remote>"（推配置的跟踪分支）；
 *   显式 branch 时带分支名推送。
 * - setUpstream=true → -u（建立跟踪）；force=true → --force-with-lease（安全 force，
 *   非裸 --force——防覆盖他人提交；裸 force 需走 githana_git(action="exec") 显式传）；
 *   dryRun=true → --dry-run（只验证不真推）。
 * - 返回推送结果摘要（含远端/分支/参数与 git 原文）。
 *
 * 凭据：GitHub App 令牌由**本 App 自写的 git remote helper** 使用（tools/lib/remote-helper-shim.js
 * 在 spawn git 时注入 `githana-push::` 前缀改写与 PATH——push 只注入 push 侧那一组，取侧的
 * `githana::.insteadOf` 在 push 时故意缺席，否则显式 `pushurl` 会被它抢走）。helper 自己从
 * dataDir 解 DPAPI 密文、自己发 HTTPS，所以令牌不进命令行、不进远端 URL、不进 gitconfig、
 * **不进 git 子进程的 env**——
 * `git remote -v` 里看不到它，git 的 stderr 里也不会回显。github.com 的远端不回落系统凭据：
 * 未登录时 helper 会给可读引导，不静默失败。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { getToolSecretToken } from "../../lib/context.js";
import { isGitHubHttpsUrl, GIT_AUTH_NOTE } from "../../lib/remote-helper-shim.js";

export const command = "push";
export const summary = "Push to the remote";

export const schema = {
  cwd: params.cwd,
  branch: z.string().optional().describe("Optional: name of the branch to push; default = the current branch (git rev-parse --abbrev-ref HEAD)"),
  remote: z.string().optional().describe("Optional: remote name, defaults to origin"),
  setUpstream: z.boolean().optional().describe("Optional: pass -u to set up an upstream tracking branch (recommended for a first push)"),
  force: z
    .boolean()
    .optional()
    .describe("Optional: force push — maps to --force-with-lease (a safe force that refuses to overwrite others' new commits); for a bare --force go through githana_git(action=\"exec\")"),
  dryRun: z.boolean().optional().describe("Optional: only do a --dry-run to verify pushability without actually updating the remote"),
};

export const sideEffect = {
  kind: "git_remote",
  summary:
    "Push local commits to a remote repository (origin by default, updating the remote branch reference; dryRun only verifies without really pushing; force maps only to the safe --force-with-lease force push) — confirm cwd, remote and branch before running",
  ruleId: "github-toolkit-git-push",
};

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = String(cwdParam).trim();

  const remote = input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
    ? String(input.remote).trim()
    : "origin";
  const setUpstream = input?.setUpstream === true;
  const force = input?.force === true;
  const dryRun = input?.dryRun === true;

  // 缺省分支 = 当前分支；游离 HEAD 无分支名 → 引导
  let branch = input?.branch !== undefined && input?.branch !== null ? String(input.branch).trim() : "";
  if (!branch) {
    const brR = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (!brR.ok) {
      const raw = (brR.stderr || "").trim();
      if (/not a git repository/i.test(raw)) {
        return label + ": the current directory is not a git repository (git says: " + (raw.split("\n")[0] || raw) + "). Run this inside a repository directory.";
      }
      if (/HEAD|ambiguous/i.test(raw)) {
        return label + ": cannot determine the current branch (detached HEAD, or the repository has no commits yet): pass branch explicitly, or check out a branch first.";
      }
      return label + " failed to read the branch:\n" + (brR.message || raw);
    }
    branch = brR.stdout.trim();
    if (!branch || branch === "HEAD") {
      return label + ": HEAD is detached or the branch is unnamed, so it cannot be pushed. Check out / create a branch first (githana_git(action=\"exec\"): checkout -b <branch>) or pass branch explicitly.";
    }
  }

  // 远端 URL：只用来判定这次推送走哪条传输路径（github.com 的 https 才接 App 的 helper），
  // 以及让「远端不存在」在推送前就说清楚。取 **--push** 那一份：git 的 `get-url` 会展开
  // `insteadOf` / `pushInsteadOf`，配了单独的 `pushurl` 时推送去的 host 更可能与 fetch URL 不同——
  // 用 fetch URL 判定会把引导与成功文案都指错侧。
  // 本探测的子命令是 `remote`，不在 helper 的注入范围（见 remoteHelperSubcommand），所以
  // 它读到的只有仓库自己配置的那一份，不含本 App 为 push 注入的 `githana-push::` 前缀。
  // remote 也可能直接写成 URL（那时 get-url 会失败），所以取不到就退回 remote 本身——
  // 探测失败不拦推送，注入与否由 remote-helper-shim 按子命令判定。
  const token = getToolSecretToken();
  const urlR = await runCli("git", ["remote", "get-url", "--push", remote], { cwd, timeoutSec: 30 });
  const remoteUrl = urlR.ok ? String(urlR.stdout || "").trim() : remote;
  const githubTarget = isGitHubHttpsUrl(remoteUrl);

  const args = ["push"];
  if (dryRun) args.push("--dry-run");
  if (force) args.push("--force-with-lease");
  if (setUpstream) args.push("-u");
  args.push(remote, branch);

  const r = await runCli("git", args, { cwd });
  const text = r.ok
    ? [
        "push succeeded (dryRun=" + dryRun + "): " + remote + " " + branch +
          (setUpstream ? " (-u upstream tracking set up)" : "") + (force ? " (--force-with-lease)" : ""),
      ]
    : [
        "push failed (exit code " + r.exitCode + "): " + remote + " " + branch + "",
      ];
  if (r.ok && githubTarget) {
    text.push("credentials: through this App's own git remote helper (only for https remotes on github.com); the token never passes through git.");
  }
  const rawOut = (r.stdout || "").trim();
  const rawErr = (r.stderr || "").trim();
  if (rawOut) text.push("—— stdout ——\n" + rawOut);
  if (rawErr) text.push("—— stderr ——\n" + rawErr);
  if (r.ok) {
    if (/Everything up-to-date/.test(rawOut + rawErr)) {
      text.push("the remote is already up to date (Everything up-to-date); there are no new commits to push.");
    } else if (/->/.test(rawOut + rawErr)) {
      text.push("the remote reference was updated (see the -> line above).");
    }
  } else {
    const s = rawOut + "\n" + rawErr;
    // 顺序要紧：GitHub 拒带 .github/workflows 改动的推送时，文案里同时含 "remote rejected"，
    // 所以「缺 workflows 权限」这一条必须排在通用的 non-fast-forward / rejected 之前。
    if (/refusing to allow .*workflow|workflows? permission|without `workflows` permission/i.test(s)) {
      // App 令牌在位但授权范围不含 workflows：GitHub 会拒带 .github/workflows/* 改动的推送。
      text.push(
        "hint: this push carries changes under .github/workflows/, but the current authorization lacks `workflows: write`.\n" +
        "Go to the GitHana settings page and click \"Sign in with GitHub\" again to get the new scope; or split the workflow changes into a separate commit first (a push without it is unaffected).",
      );
    } else if (/not a git repository/i.test(s)) {
      text.push("hint: the current directory is not a git repository; run this inside a repository directory.");
    } else if (/does not appear to be a git repository|repository .* not found/i.test(s)) {
      text.push("hint: the remote " + remote + " does not exist or is unreachable: check the remote configuration (git remote -v) or the URL.");
    } else if (/non-fast-forward|fetch first|rejected/i.test(s)) {
      text.push("hint: the remote rejected the fast-forward push (non-fast-forward): pull and merge the remote changes first, or safely overwrite with force=true (--force-with-lease) on githana_git(action=\"push\").");
    } else if (/Authentication failed|could not read Username|fatal: unable to access|Invalid username or password|HTTP 403|403 Forbidden/i.test(s)) {
      text.push("hint: remote authentication failed. " + gitAuthGuide(githubTarget, token));
    }
  }
  return text.join("\n");
}

/**
 * 认证失败时的引导：按「这次走没走 App 的 helper」分流——两种情况的可修之处不同，
 * 给同一句话等于让调用方去试一个不对的方向。
 *
 * 走 helper 时，令牌由 helper 自己从 dataDir 解（与 App 进程读到的是同一份凭据），
 * 所以「App 进程里有没有令牌」仍能指示凭据是否就位。
 */
function gitAuthGuide(githubTarget, token) {
  if (githubTarget && token) {
    return (
      "GitHub rejected the App token: most likely the authorization scope does not cover this operation (e.g. changes under .github/workflows need `workflows: write`), " +
      "or the token has expired — go to the GitHana settings page and click \"Sign in with GitHub\" again, then retry."
    );
  }
  if (githubTarget && !token) {
    return (
      "There is no usable App token for this push (not signed in yet), and the helper reported that explicitly. " + GIT_AUTH_NOTE + ".\n" +
      "Go to the GitHana settings page and click \"Sign in with GitHub\" to complete authorization, then retry."
    );
  }
  return (
    "The remote is not an https address on github.com; this App's helper only applies to github.com, so this path uses git's native transport and the system Git credentials. " +
    "Check that this machine already has credentials for that remote, or check the remote URL's protocol."
  );
}

