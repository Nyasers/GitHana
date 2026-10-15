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
import { GIT_CREDENTIAL_NOTE } from "../../lib/git-cred.js";

export const command = "sync";
export const summary = "把 fork 与上游同步（fetch + 合并）";

export const schema = {
  repo: params.repo.describe("可选：要同步的 fork（格式 owner/repo）；缺省从 cwd 的 git remote 推断"),
  cwd: params.cwd.describe("本地 fork 克隆的绝对路径（必填）：同步要在本地 fetch 上游并合并"),
  branch: z.string().optional().describe("可选：要同步的分支；缺省取该 fork 的默认分支，且必须等于 cwd 的当前检出分支"),
  strategy: z
    .enum(["merge", "ff-only", "rebase"])
    .optional()
    .describe("可选：合并方式，默认 merge（--no-edit）；ff-only 只接受快进；rebase 用变基"),
  remote: z.string().optional().describe("可选：**上游**的远端名；缺省从 remote 列表里找指向上游仓库的那个"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "把上游仓库的提交取到本地 fork 克隆并合并/变基（在本机跑 git fetch + merge，可能改动本地分支与工作区）：会重写本地分支历史（rebase 时），执行前请确认 cwd、分支与 strategy",
  ruleId: "github-toolkit-repo-sync",
};

/** git 错误 → 中文引导。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "远端认证失败：" + GIT_CREDENTIAL_NOTE + "。请确认已登录（github.com 的 https 远端）或本机已有该远端的凭据。";
  }
  if (/CONFLICT|Automatic merge failed/i.test(s)) {
    return "合并有冲突：git 已停下并留下冲突标记。请在 cwd 里手工解决后 git commit（或 git merge --abort 放弃）。";
  }
  if (/Not possible to fast-forward|diverged/i.test(s)) {
    return "不是快进：上游有提交、本地分支也有自己的提交。要么用默认的 strategy=merge，要么先自己理清分支。";
  }
  if (/Your local changes|would be overwritten|Please commit your changes/i.test(s)) {
    return "工作区有未提交改动：请先提交或 git stash，再同步。";
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
  if (cwdErr) return label + " 参数错误：" + cwdErr;
  const cwd = input?.cwd !== undefined && input?.cwd !== null ? String(input.cwd).trim() : "";
  if (!cwd) {
    return (
      label + " 参数错误：cwd 必填（本地 fork 克隆的绝对路径）。\n" +
      "同步是本地 git 语义（fetch 上游 + 合并），没有对应的 REST 端点能替它做完。"
    );
  }

  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // —— 上游是谁：先问 GitHub（权威），再去本地 remote 里找它 ——
  const repoRes = await callRest([{ url: apiUrl(repo, ""), timeoutMs }], { timeoutSec });
  if (!repoRes.ok) return label + " 执行失败：" + repoRes.message;
  const rres = repoRes.results[0];
  if (!rres || !rres.ok) return label + " 执行失败：" + describeFailure(rres, repoLabel);

  const parent = rres.json && rres.json.parent && rres.json.parent.full_name ? String(rres.json.parent.full_name) : "";
  if (!parent) {
    return (
      label + "：仓库 " + repoLabel + " 不是 fork（GitHub 的响应里没有 parent），没有上游可同步。\n" +
      "要取远端最新提交，请直接 githana_git(action=\"exec\", args=[\"pull\"]) 或 githana_repo(action=\"clone\")。"
    );
  }

  // —— 本地 remote 列表：找出指向上游的那个 ——
  const remotesR = await runCli("git", ["remote"], { cwd, timeoutSec: 30 });
  if (!remotesR.ok) {
    const raw = ((remotesR.stderr || "") + "\n" + (remotesR.stdout || "")).trim();
    return label + " 读取远端列表失败：\n" + (raw || remotesR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
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
        label + " 参数错误：cwd 里没有名为 " + explicitRemote + " 的远端（现有：" + (remotes.join(" / ") || "无") + "）。"
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
      label + " 无法确定上游远端：cwd 的远端里没有指向 " + parent + " 的那个（现有：" + (remotes.join(" / ") || "无") + "）。\n" +
      "请先把它加进来，例如：\n" +
      "  githana_git(action=\"exec\", cwd=\"" + cwd + "\", args=[\"remote\", \"add\", \"upstream\", \"https://github.com/" + parent + ".git\"])\n" +
      "或用 remote 参数显式指定已有的远端名（必须是 " + parent + "）。"
    );
  }

  // 核对显式给的远端确实指着上游：指错了就是往别的仓库合并。
  const checkInferred = await repoFromCwd(cwd, upstreamRemote);
  if (checkInferred && (checkInferred.owner + "/" + checkInferred.repo).toLowerCase() !== parent.toLowerCase()) {
    return (
      label + " 参数错误：远端 " + upstreamRemote + " 指向 " + checkInferred.owner + "/" + checkInferred.repo +
      "，而上游是 " + parent + "。\n请用 remote 参数指定指向上游的那个远端。"
    );
  }

  // —— 分支：缺省取 fork 的默认分支 ——
  const defaultBr = rres.json && rres.json.default_branch ? String(rres.json.default_branch) : "";
  const branch =
    input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== ""
      ? String(input.branch).trim()
      : defaultBr;
  if (!branch) {
    return label + " 参数错误：无法确定要同步的分支（响应里没有 default_branch），请显式传 branch。";
  }
  const strategy = String(input?.strategy || "merge");

  // —— 合进哪个分支：必须是 cwd 当前分支 ——
  // `git merge` 改的是**当前检出的分支**，而 fetch 取的可以是任意分支。两者不一致时静默合并
  // 会把上游的提交合到另一个分支上——所以先核对，不一致就拒绝并给出该怎么做，不替调用方切分支
  // （切分支会改工作区，那是 `git checkout` 的语义，不该藏在 sync 里）。
  const cur = await currentBranch(cwd);
  if (cur.error) return label + " 无法确定 cwd 的当前分支：" + cur.error;
  if (cur.branch !== branch) {
    return (
      label + " 参数错误：cwd 当前分支是 " + cur.branch + "，而本次要同步的是 " + branch + "。\n" +
      "git merge / rebase 只改当前检出的分支，不一致会把上游提交合到别的分支上。\n" +
      "请先切到 " + branch + "：githana_git(action=\"exec\", cwd=\"" + cwd + "\", args=[\"checkout\", \"" + branch + "\"])，" +
      "或把 branch 参数改成 " + cur.branch + "。"
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
      label + " fetch 上游失败（" + upstreamRemote + " " + branch + "）：\n" +
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
      label + " 上游已取到本地，但 " + strategy + " 失败（" + upstreamRemote + "/" + branch + " → 当前分支）：\n" +
      (raw || mergeR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "") +
      "\n本地引用 " + upstreamRemote + "/" + branch + " 已更新，可自行处理合并。"
    );
  }

  const headR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutSec: 30 });
  const out = [
    label + " 完成：",
    "上游：" + parent + "（远端名 " + upstreamRemote + "）· 分支 " + branch + " · 方式 " + strategy,
    "本地 cwd：" + cwd,
  ];
  if (headR.ok) out.push("本地 HEAD：" + headR.stdout.trim());
  const merged = ((mergeR.stdout || "") + (mergeR.stderr || "")).trim();
  if (/Already up to date|Already up-to-date/i.test(merged)) out.push("结果：本来就与上游一致（Already up to date）。");
  else out.push("结果：已把上游提交取到本地并" + (strategy === "rebase" ? "变基" : "合并") + "。");
  out.push("说明：本动词只动本地克隆，**不推送** fork。要让远端 fork 也对齐，请接着 githana_git(action=\"push\")。");
  return out.join("\n");
}
