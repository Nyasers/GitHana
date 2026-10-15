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
import { GIT_CREDENTIAL_NOTE } from "../../lib/git-cred.js";

export const command = "checkout";
export const summary = "把 PR 的源分支取到本地并检出";

export const schema = {
  repo: params.repo,
  // 与 revert 同理：要在本地仓库里做 git 操作，所以 cwd 必填。
  cwd: params.cwd.describe(
    "本地仓库绝对路径（必填）：检出要在本地 fetch 并切分支",
  ),
  prNumber: params.prNumber.describe("要检出的 PR 编号（正整数），必填"),
  branch: z.string().optional().describe("可选：本地分支名，默认用 PR 的源分支名（head.ref）"),
  remote: z.string().optional().describe("可选：远端名，默认 origin；它必须指向该 PR 所在仓库"),
  force: z
    .boolean()
    .optional()
    .describe("可选：本地已有同名分支时强制把引用指向 PR 的源分支（会丢弃该分支上不在 PR 里的本地提交，默认 false）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "把 GitHub 远端 PR 的源分支取到本地仓库（cwd）并检出：会新建或切换本地分支、更新本地引用（force=true 时覆盖同名本地分支），不改远端、不推送；执行前请确认 cwd 与 prNumber",
  ruleId: "github-toolkit-pr-checkout",
};

/** git 错误 → 中文引导。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/not a git repository/i.test(s)) return "当前目录不是 git 仓库：请在仓库目录内执行。";
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "远端认证失败：" + GIT_CREDENTIAL_NOTE + "。请确认已登录（github.com 的 https 远端）或本机已有该远端的凭据。";
  }
  if (/couldn't find remote ref/i.test(s)) {
    return "该远端上找不到这个 pull 引用：确认 remote 指向的正是 PR 所在仓库（refs/pull/<n>/head 是每个仓库各自的）。";
  }
  if (/Your local changes|would be overwritten/i.test(s)) {
    return "工作区有未提交改动、与要检出的分支冲突：请先提交或 git stash，再重试。";
  }
  return null;
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();
  if (!cwd) return label + " 参数错误：cwd 必填（检出要在本地 fetch 并切分支）。";

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
    return label + " 读取远端列表失败：\n" + (raw || remotesR.message) +
      (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
  }
  const remotes = String(remotesR.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    return (
      label + " 参数错误：cwd 里没有名为 " + remote + " 的远端（现有：" + (remotes.join(" / ") || "无") + "）。\n" +
      "请用 remote 参数指定正确的远端名，或先 git remote add。"
    );
  }

  const inferred = await repoFromCwd(cwd, remote);
  if (!inferred) {
    return (
      label + " 无法核对 cwd 的仓库：远端 " + remote + " 的 URL 不是可解析的 GitHub 地址。\n" +
      "检出要靠 refs/pull/<n>/head，它只在 PR 所在仓库上才是这个 PR——请确认 remote 指向正确。"
    );
  }
  const inferredFull = inferred.owner + "/" + inferred.repo;
  if (inferredFull.toLowerCase() !== String(repo).toLowerCase()) {
    return (
      label + " 参数错误：cwd 的远端 " + remote + " 指向 " + inferredFull + "，而本次要操作的仓库是 " + repo + "。\n" +
      "refs/pull/<n>/head 是每个仓库各自的引用，在别的仓库上取 n 会拿到另一个 PR。\n" +
      "请在对的仓库里执行（或显式传 repo 与 remote 来对齐）。"
    );
  }

  // —— 取 PR 本体：要源分支名 ——
  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " 执行失败：" + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + "：PR #" + num + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "";
  const headRepoFull = pr.head && pr.head.repo && pr.head.repo.full_name ? String(pr.head.repo.full_name) : "";
  const headSha = pr.head && pr.head.sha ? String(pr.head.sha) : "";
  if (!headRef) return label + "：PR #" + num + " 的响应里没有 head.ref，无法确定本地分支名。";

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
      return label + " 切换分支 " + branch + " 失败：\n" + (raw || checkoutR.message) +
        (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
    }
    const localR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutSec: 30 });
    const localSha = localR.ok ? localR.stdout.trim() : "";
    const out = [
      label + " 已切到本地已有分支 " + branch + "（PR #" + num + " · " + repoLabel + "）：",
      "本地 HEAD：" + (localSha || "?"),
    ];
    if (headSha) out.push("PR 源分支 HEAD：" + headSha.slice(0, 7));
    out.push(
      localSha && headSha && localSha !== headSha.slice(0, localSha.length)
        ? "注意：本地分支**未必**跟 PR 的最新提交一致——本动词默认不覆盖本地分支（以免丢本地提交）。要取 PR 最新状态请显式传 force=true。"
        : "本地分支与 PR 源分支 HEAD 一致。",
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
    return label + " fetch PR 源分支失败（" + remote + " refs/pull/" + num + "/head → " + branch + "）：\n" +
      (raw || fetchR.message) + (gitGuide(raw) ? "\n" + gitGuide(raw) : "");
  }

  const checkoutR = await runCli("git", ["checkout", branch], { cwd });
  if (!checkoutR.ok) {
    const raw = ((checkoutR.stderr || "") + "\n" + (checkoutR.stdout || "")).trim();
    return label + " fetch 成功但切换分支失败：\n" + (raw || checkoutR.message) +
      (gitGuide(raw) ? "\n" + gitGuide(raw) : "") +
      "\n本地分支 " + branch + " 已就位，可自行 git checkout " + branch + "。";
  }

  const out = [
    label + " 已检出（PR #" + num + " · " + repoLabel + "）：",
    "本地分支：" + branch + (branch === headRef ? "" : "（源分支为 " + headRef + "）"),
    (exists ? "覆盖了本地已有的同名分支（force=true）" : "新建本地分支") +
      (headRepoFull && headRepoFull.toLowerCase() !== String(repo).toLowerCase() ? " · 源分支来自 " + headRepoFull + "（fork）" : ""),
  ];
  if (headSha) out.push("HEAD：" + headSha.slice(0, 7));
  if (pr.html_url) out.push("URL：" + pr.html_url);
  return out.join("\n");
}
