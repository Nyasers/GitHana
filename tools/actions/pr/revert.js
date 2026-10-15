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
import { GIT_CREDENTIAL_NOTE } from "../../lib/git-cred.js";

export const command = "revert";
export const summary = "回退已合并的 PR（本地 revert + 新分支 + 开回退 PR）";

export const schema = {
  repo: params.repo,
  // 与其它 pr_* 不同：回退要在本地仓库里做 git 操作，所以 cwd 是必填的。
  cwd: params.cwd.describe(
    "本地仓库绝对路径（必填）：回退要在本地切分支、跑 git revert 并推送，REST 没有对应端点",
  ),
  prNumber: params.prNumber.describe("要回退的 PR 编号（必须是已合并的 PR）"),
  branch: z.string().optional().describe("可选：回退分支名，默认 revert-<PR编号>-<原分支名>"),
  title: z.string().optional().describe("可选：回退 PR 的标题，默认 Revert \"<原 PR 标题>\""),
  body: z.string().optional().describe("可选：回退 PR 的正文，默认注明回退的是哪个 PR"),
  draft: z.boolean().optional().describe("可选：以草稿创建回退 PR"),
  remote: z.string().optional().describe("可选：远端名，默认 origin"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_remote",
  summary:
    "回退一个已合并的 PR：在本地仓库（cwd）从目标分支切出新分支、git revert 该合并提交并推送到远端，随后在 GitHub 上创建回退 PR——会修改本地仓库状态（新分支与新提交）并推送远端、创建远端 PR，执行前请确认 cwd、repo 与 prNumber",
  ruleId: "github-toolkit-pr-revert",
};

/** git 错误 → 中文引导。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/not a git repository/i.test(s)) return "当前目录不是 git 仓库：请在仓库目录内执行。";
  if (/could not read Username|Authentication failed|unable to access/i.test(s)) {
    return "远端认证失败：" + GIT_CREDENTIAL_NOTE + "。请确认已登录（github.com 的 https 远端）或本机已有该远端的凭据。";
  }
  if (/non-fast-forward|fetch first|rejected/i.test(s)) {
    return "远端拒绝了推送：先拉取合并远端变更再重试。";
  }
  if (/CONFLICT|conflict/i.test(s)) {
    return "git revert 遇到冲突：目标分支上那些行已经被改过。请手动解决（或对相关改动另开 PR），本动词不代为决策。";
  }
  return null;
}

/** 组装失败文案：git 原文 + 引导。 */
function gitFailure(label, what, r) {
  const raw = ((r.stderr || "") + "\n" + (r.stdout || "")).trim();
  const text = label + " " + what + "失败（exit code " + r.exitCode + "）：\n" + (raw || r.message || "未知错误");
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
  if (cwdErr) return label + " 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();
  if (!cwd) {
    return label + " 参数错误：cwd 必填（回退要在本地仓库切分支、revert 并推送）。";
  }

  const num = input.prNumber;
  const remote = input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
    ? String(input.remote).trim()
    : "origin";
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // —— 1) 读 PR：必须已合并 ——
  const prRes = await callRest([{ url: apiUrl(repo, "/pulls/" + num), timeoutMs }], { timeoutSec });
  if (!prRes.ok) return label + " 执行失败：" + prRes.message;
  const pres = prRes.results[0];
  if (!pres || !pres.ok) {
    if (pres && pres.status === 404) return label + "：PR #" + num + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(pres, repoLabel);
  }
  const pr = pres.json && typeof pres.json === "object" ? pres.json : {};
  if (pr.merged !== true) {
    return (
      label + "：PR #" + num + " 还没有合并（state=" + String(pr.state || "?") + "），没有可回退的合并提交。\n" +
      "回退只对已合并的 PR 有意义；如果只是要放弃这次改动，用 githana_pr(action=\"close\") 关闭它。"
    );
  }
  const mergeSha = pr.merge_commit_sha ? String(pr.merge_commit_sha) : "";
  const baseRef = pr.base && pr.base.ref ? String(pr.base.ref) : "";
  const headRef = pr.head && pr.head.ref ? String(pr.head.ref) : "";
  const prTitle = pr.title ? String(pr.title) : "";
  if (!mergeSha || !baseRef) {
    return label + "：PR #" + num + " 的响应里缺少 merge_commit_sha 或 base.ref，无法在本地回退。";
  }

  // —— 2) 工作区必须干净：切分支会打断正在进行的工作，所以宁可拒绝也不悄悄换分支 ——
  const statusR = await runCli("git", ["status", "--porcelain"], { cwd, timeoutSec: 30 });
  if (!statusR.ok) return gitFailure(label, "读取工作区状态", statusR);
  if (String(statusR.stdout || "").trim() !== "") {
    return (
      label + "：cwd 的工作区不干净（有未提交的改动），不能安全地切分支做回退。\n" +
      "请先提交或暂存（git stash）这些改动，再重试。回退会在本地切分支并产生一个新提交。"
    );
  }

  const branchName =
    input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== ""
      ? String(input.branch).trim()
      : "revert-" + num + (headRef ? "-" + headRef : "");

  const steps = [label + " 回退 PR #" + num + "（" + repoLabel + " · 合并提交 " + mergeSha.slice(0, 7) + "）："];

  // —— 3) fetch + 从远端目标分支切新分支 ——
  const fetchR = await runCli("git", ["fetch", remote, baseRef], { cwd });
  if (!fetchR.ok) return gitFailure(label, "fetch " + remote + " " + baseRef, fetchR);

  const checkoutR = await runCli("git", ["checkout", "-b", branchName, remote + "/" + baseRef], { cwd });
  if (!checkoutR.ok) {
    const raw = ((checkoutR.stderr || "") + "\n" + (checkoutR.stdout || "")).trim();
    if (/already exists/i.test(raw)) {
      return (
        label + "：分支 " + branchName + " 已存在，不能复用它做回退（避免覆盖已有工作）。\n" +
        "请用 branch 参数指定另一个名字，或先删掉那个分支。"
      );
    }
    return gitFailure(label, "从 " + remote + "/" + baseRef + " 切分支 " + branchName, checkoutR);
  }
  steps.push("  1. 已从 " + remote + "/" + baseRef + " 切出新分支 " + branchName);

  /** 回退失败时的收尾说明：新分支已经建出来了，得让调用方知道留下了什么。 */
  const leftover = "  留下的状态：本地已创建并停在新分支 " + branchName + "（未推送）。要丢弃请 git checkout " + baseRef + " && git branch -D " + branchName + "。";

  // —— 4) git revert：合并提交要带 -m 1，squash / rebase 出来的提交不带 ——
  // 先判父提交数（rev-list --parents -n 1 输出 "sha p1 [p2 ...]"），带错 -m 会直接失败。
  const parentsR = await runCli("git", ["rev-list", "--parents", "-n", "1", mergeSha], { cwd });
  if (!parentsR.ok) return gitFailure(label, "读取提交 " + mergeSha.slice(0, 7) + " 的父提交", parentsR);
  const parentCount = String(parentsR.stdout || "").trim().split(/\s+/).filter(Boolean).length - 1;
  if (parentCount < 1) {
    return label + "：在 cwd 里找不到提交 " + mergeSha.slice(0, 7) + "（该仓库可能还没有 fetch 到这个提交）。\n" + leftover;
  }
  const revertArgs = ["revert", "--no-edit"];
  if (parentCount >= 2) revertArgs.push("-m", "1");
  revertArgs.push(mergeSha);
  const revertR = await runCli("git", revertArgs, { cwd });
  if (!revertR.ok) {
    const text = gitFailure(label, "git revert " + mergeSha.slice(0, 7), revertR);
    // revert 冲突会留下冲突标记与进行中的 revert 状态，必须说清怎么退出来。
    if (/CONFLICT|conflict/i.test((revertR.stdout || "") + (revertR.stderr || ""))) {
      return text + "\n  要放弃并回到干净状态：git revert --abort && git checkout " + baseRef + " && git branch -D " + branchName + "。";
    }
    return text + "\n" + leftover;
  }
  steps.push("  2. git revert 完成（" + (parentCount >= 2 ? "合并提交，-m 1" : "非合并提交，无 -m") + "）");

  // —— 5) 推新分支 ——
  const pushR = await runCli("git", ["push", "-u", remote, branchName], { cwd });
  if (!pushR.ok) return gitFailure(label, "推送分支 " + branchName, pushR) + "\n" + leftover;
  steps.push("  3. 已推送新分支 " + branchName + "（-u 建立跟踪）");

  // —— 6) 开回退 PR ——
  const title =
    input?.title !== undefined && input?.title !== null && String(input.title).trim() !== ""
      ? String(input.title).trim()
      : 'Revert "' + prTitle + '"';
  const body =
    input?.body !== undefined && input?.body !== null
      ? String(input.body)
      : "回退 PR #" + num + "（合并提交 " + mergeSha + "）。\n\n由 GitHana 的 githana_pr(action=\"revert\") 生成。";

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
      label + " 部分完成：\n" + steps.join("\n") + "\n" +
      "  4. 创建回退 PR 失败——" + detail + "\n" +
      "分支 " + branchName + " 已在远端（本地也停在它上面），可稍后用 githana_pr(action=\"create\")（base=" + baseRef + "）补开 PR。"
    );
  }

  const created = cres.json && typeof cres.json === "object" ? cres.json : {};
  steps.push(
    "  4. 已创建回退 PR #" + (created.number !== undefined ? String(created.number) : "?") +
      (created.html_url ? "：" + String(created.html_url) : ""),
  );
  steps.push("回退 PR 标题：" + title + " · 分支：" + branchName + " → " + baseRef);
  steps.push("注意：本地仓库现停在分支 " + branchName + " 上（回退分支不会自动合回，仍走正常审查）。");
  return steps.join("\n");
}
