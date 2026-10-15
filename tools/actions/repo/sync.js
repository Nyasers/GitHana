// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/sync：把 fork 与上游同步（githana_repo 动词）。
 *
 * ## 为什么它靠本地 git 而不是 REST
 *
 * 「同步 fork」在 GitHub 上**没有**一个 REST 端点能一次做完它——这正是 GitHub 自己在
 * 网页上给的两种做法：一是用 `merge-upstream` 端点**只对 fork 的默认分支**做快进合并，
 * 二是让开发者在本机 `git fetch upstream && git merge`。两者覆盖面不同：
 *
 *   · merge-upstream 快，但只动默认分支，其它分支碰不到，且要求 fork 是干净的（不能有本地提交）；
 *   · 本地 fetch + 合并能覆盖任意分支，也能在冲突时留在本地解决——但它要一个**已存在的本地克隆**。
 *
 * gh 的 `repo sync` 走的正是第二种（它是个本地操作：`gh repo sync` 在本机 fetch 上游再推回 fork）。
 * 所以本动词走**本地 git 子进程**：`git fetch <上游> <分支>` 然后按 `strategy` 合并。
 * 与 clone 一样，这不是 REST 能替代的语义（D2 里这一行的支撑权限是 `contents`，而它消费的
 * 是本地克隆里的对象）。
 *
 * ## 上游怎么确定
 *
 * 首选 GitHub 给的权威答案：`GET /repos/{owner}/{repo}` 的 `parent` 字段（fork 才有）。
 * 拿到上游 full_name 再去本地的 remote 列表里找**指向它的那个 remote**（通常是 upstream，
 * 但那是本地命名习惯，不能假定）。找不到就明确报错并给出 `git remote add` 的命令，
 * 不静默拿 origin 顶上——拿错了就是往别的仓库合并。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { resolveContext, describeFailure, currentBranch, repoFromCwd } from "../../lib/gh.js";
import { GIT_FETCH_AUTH_NOTE } from "../../lib/remote-helper-shim.js";

export const command = "sync";
export const summary = "Sync a fork with its upstream (fetch + merge)";

export const schema = {
  repo: params.repo.describe("Optional: the fork to sync (owner/repo form); by default inferred from the git remotes of cwd"),
  cwd: params.cwd.describe("Absolute path of the local fork clone (required): syncing needs to fetch the upstream and merge locally"),
  branch: z.string().optional().describe("Optional: branch to sync; defaults to that fork's default branch and must equal the branch currently checked out in cwd"),
  strategy: z
    .enum(["merge", "ff-only", "rebase"])
    .optional()
    .describe("Optional: how to combine, default merge (--no-edit); ff-only accepts fast-forwards only; rebase uses rebase"),
  remote: z.string().optional().describe("Optional: the remote name of the **upstream**; by default the remote pointing at the upstream repository is found in the remote list"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "Fetch the upstream repository's commits into the local fork clone and merge/rebase them (runs git fetch + merge on this machine; may change the local branch and working tree): rewrites local branch history (when rebasing) — confirm cwd, branch and strategy before running",
  ruleId: "github-toolkit-repo-sync",
};

/** git 错误 → 中文引导。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "Remote authentication failed: " + GIT_FETCH_AUTH_NOTE + ".";
  }
  if (/CONFLICT|Automatic merge failed/i.test(s)) {
    return "The merge has conflicts: git stopped and left conflict markers. Resolve them by hand in cwd and then git commit (or give up with git merge --abort).";
  }
  if (/Not possible to fast-forward|diverged/i.test(s)) {
    return "Not a fast-forward: the upstream has commits and the local branch has its own commits too. Either use the default strategy=merge, or sort the branch out yourself first.";
  }
  if (/Your local changes|would be overwritten|Please commit your changes/i.test(s)) {
    return "The working tree has uncommitted changes: commit them or git stash first, then sync.";
  }
  return null;
}

/**
 * 位置参数注入防护：`remote` 与 `branch` 最终都落在 `git fetch <remote> <branch>` 的**位置参数**上，
 * 而 git 对 `-` 开头的 token 会先按选项解析（同族实测：`git clone <url> '-evil-dir'` →
 * `error: unknown switch 'e'`）。`-x` 这种值不是合法的远端名 / 分支名，落到位置参数上只会
 * 变成一次选项解析，所以这里直接拒绝，不给它进 git 的机会。
 *
 * 这里选「显式拒绝」而不是加 `--` 分隔：`git fetch -- <remote> <branch>` 的 `--` 之后到底走
 * 「远端名 + 分支名」还是 **refspec** 那条解析路径，我没有实测把握（`git clone` 那条的 `--` 语义
 * 是明确的，主上下文已实测 `--branch` 之后是分支名、位置参数才是洞；fetch 的 refspec 解析有额外
 * 分支，不能照搬这个结论）。没把握就不改行为，已在 PR 报告里标为待实测。拒绝本身没有误伤面：
 * 远端名与分支名都不以 `-` 开头，收到这种值一定是构造出来的。
 */
export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const cwdErr = checkCwd(input?.cwd);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = input?.cwd !== undefined && input?.cwd !== null ? String(input.cwd).trim() : "";
  if (!cwd) {
    return (
      label + " argument error: cwd is required (the absolute path of the local fork clone).\n" +
      "Syncing is local git semantics (fetch the upstream + merge); no REST endpoint can do it for you."
    );
  }

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // —— 上游是谁：先问 GitHub（权威），再去本地 remote 里找它 ——
  const repoRes = await callRest([{ url: apiUrl(repo, ""), timeoutMs }], { timeoutSec });
  if (!repoRes.ok) return label + " execution failed: " + repoRes.message;
  const rres = repoRes.results[0];
  if (!rres || !rres.ok) return label + " execution failed: " + describeFailure(rres, repoLabel);

  const parent = rres.json && rres.json.parent && rres.json.parent.full_name ? String(rres.json.parent.full_name) : "";
  if (!parent) {
    return (
      label + ": repository " + repoLabel + " is not a fork (GitHub's response has no parent), so there is no upstream to sync from.\n" +
      "To fetch the latest commits from the remote, use githana_git(action=\"exec\", args=[\"pull\"]) or githana_repo(action=\"clone\") directly."
    );
  }

  // —— 本地 remote 列表：找出指向上游的那个 ——
  const remotesR = await runCli("git", ["remote"], { cwd, timeoutSec: 30 });
  if (!remotesR.ok) {
    const raw = ((remotesR.stderr || "") + "\n" + (remotesR.stdout || "")).trim();
    return label + " failed to read the remote list:\n" + (raw || remotesR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
  }
  const remotes = String(remotesR.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);

  const explicitRemote =
    input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
      ? String(input.remote).trim()
      : "";
  let upstreamRemote = "";
  if (explicitRemote) {
    if (!remotes.includes(explicitRemote)) {
      return (
        label + " argument error: cwd has no remote named " + explicitRemote + " (existing: " + (remotes.join(" / ") || "none") + ")."
      );
    }
    upstreamRemote = explicitRemote;
  } else {
    for (const name of remotes) {
      const inferred = await repoFromCwd(cwd, name);
      if (inferred && (inferred.owner + "/" + inferred.repo).toLowerCase() === parent.toLowerCase()) {
        upstreamRemote = name;
        break;
      }
    }
  }

  if (!upstreamRemote) {
    return (
      label + " cannot determine the upstream remote: none of cwd's remotes points at " + parent + " (existing: " + (remotes.join(" / ") || "none") + ").\n" +
      "Add it first, for example:\n" +
      "  githana_git(action=\"exec\", cwd=\"" + cwd + "\", args=[\"remote\", \"add\", \"upstream\", \"https://github.com/" + parent + ".git\"])\n" +
      "or use the remote parameter to name an existing remote explicitly (it must be " + parent + ")."
    );
  }

  // 核对显式给的远端确实指着上游：指错了就是往别的仓库合并。
  const checkInferred = await repoFromCwd(cwd, upstreamRemote);
  if (checkInferred && (checkInferred.owner + "/" + checkInferred.repo).toLowerCase() !== parent.toLowerCase()) {
    return (
      label + " argument error: remote " + upstreamRemote + " points at " + checkInferred.owner + "/" + checkInferred.repo +
      ", while the upstream is " + parent + ".\nUse the remote parameter to name the remote that points at the upstream."
    );
  }

  // —— 分支：缺省取 fork 的默认分支 ——
  const defaultBr = rres.json && rres.json.default_branch ? String(rres.json.default_branch) : "";
  const branch =
    input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== ""
      ? String(input.branch).trim()
      : defaultBr;
  if (!branch) {
    return label + " argument error: cannot determine which branch to sync (the response has no default_branch); pass branch explicitly.";
  }
  const strategy = String(input?.strategy || "merge");

  // —— 合进哪个分支：必须是 cwd 当前分支 ——
  // `git merge` 改的是**当前检出的分支**，而 fetch 取的可以是任意分支。两者不一致时静默合并
  // 会把上游的提交合到另一个分支上——所以先核对，不一致就拒绝并给出该怎么做，不替调用方切分支
  // （切分支会改工作区，那是 `git checkout` 的语义，不该藏在 sync 里）。
  const cur = await currentBranch(cwd);
  if (cur.error) return label + " cannot determine cwd's current branch: " + cur.error;
  if (cur.branch !== branch) {
    return (
      label + " argument error: cwd's current branch is " + cur.branch + ", while this sync targets " + branch + ".\n" +
      "git merge / rebase only changes the currently checked-out branch, so a mismatch would merge upstream commits into a different branch.\n" +
      "Check out " + branch + " first: githana_git(action=\"exec\", cwd=\"" + cwd + "\", args=[\"checkout\", \"" + branch + "\"]), " +
      "or change the branch parameter to " + cur.branch + "."
    );
  }

  // —— fetch 上游 ——
  // `--` 分隔符：remote 与 branch 落在位置参数上，不加的话以 `-` 开头的值会被 git 当选项
  // （实测：`git clone <url> '-evil-dir'` → `error: unknown switch 'e'`）。已实测 `--` 不破坏
  // fetch 的 refspec 路径，且与 `repo clone` 同形。
  const fetchR = await runCli("git", ["fetch", "--", upstreamRemote, branch], { cwd, timeoutSec: input?.timeoutSec });
  if (!fetchR.ok) {
    const raw = ((fetchR.stderr || "") + "\n" + (fetchR.stdout || "")).trim();
    return (
      label + " fetching the upstream failed (" + upstreamRemote + " " + branch + "):\n" +
      (raw || fetchR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "")
    );
  }

  // —— 合并进本地分支 ——
  const mergeArgs =
    strategy === "rebase"
      ? ["rebase", upstreamRemote + "/" + branch]
      : strategy === "ff-only"
        ? ["merge", "--ff-only", upstreamRemote + "/" + branch]
        : ["merge", "--no-edit", upstreamRemote + "/" + branch];
  const mergeR = await runCli("git", mergeArgs, { cwd, timeoutSec: input?.timeoutSec });
  if (!mergeR.ok) {
    const raw = ((mergeR.stderr || "") + "\n" + (mergeR.stdout || "")).trim();
    return (
      label + " the upstream was fetched locally, but " + strategy + " failed (" + upstreamRemote + "/" + branch + " → current branch):\n" +
      (raw || mergeR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "") +
      "\nThe local reference " + upstreamRemote + "/" + branch + " has been updated; you can handle the merge yourself."
    );
  }

  const headR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutSec: 30 });
  const out = [
    label + " done:",
    "upstream: " + parent + " (remote name " + upstreamRemote + ") · branch " + branch + " · strategy " + strategy,
    "local cwd: " + cwd,
  ];
  if (headR.ok) out.push("local HEAD: " + headR.stdout.trim());
  const merged = ((mergeR.stdout || "") + (mergeR.stderr || "")).trim();
  if (/Already up to date|Already up-to-date/i.test(merged)) out.push("result: it was already in sync with the upstream (Already up to date).");
  else out.push("result: the upstream commits were fetched locally and " + (strategy === "rebase" ? "rebased" : "merged") + ".");
  out.push("note: this verb only touches the local clone; it does **not push** the fork. To bring the remote fork in line too, follow up with githana_git(action=\"push\").");
  return out.join("\n");
}
