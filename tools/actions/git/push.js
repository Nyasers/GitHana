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
 * 凭据：GitHub App 令牌经 credential helper 注入 git 子进程（tools/lib/git-cred.js，只在
 * github.com 的 https 远端生效，走 buildBinEnv 的 GIT_CONFIG_* 机制）。令牌不进命令行、
 * 不进 gitconfig、不进远端 URL——所以 `git remote -v` 里看不到它，git 的 stderr 里也不会回显。
 * 未登录（无令牌）时不注入，git 回落系统 Git 凭据（Git Credential Manager），与登录前一致。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { getToolSecretToken } from "../../lib/context.js";
import { isGitHubHttpsUrl, GIT_CREDENTIAL_NOTE } from "../../lib/git-cred.js";

export const command = "push";
export const summary = "推送到远端";

export const schema = {
  cwd: params.cwd,
  branch: z.string().optional().describe("可选：要推送的分支名；缺省 = 当前分支（git rev-parse --abbrev-ref HEAD）"),
  remote: z.string().optional().describe("可选：远端名，默认 origin"),
  setUpstream: z.boolean().optional().describe("可选：带 -u 建立上游跟踪分支（首次推送推荐）"),
  force: z
    .boolean()
    .optional()
    .describe("可选：强制推送——映射 --force-with-lease（安全 force，拒绝覆盖他人新提交）；裸 --force 请走 githana_git(action=\"exec\")"),
  dryRun: z.boolean().optional().describe("可选：只做 --dry-run 演练，验证可推送性，不真正更新远端"),
};

export const sideEffect = {
  kind: "git_remote",
  summary:
    "把本地提交推送到远端仓库（默认 origin，更新远端分支引用；dryRun 仅验证不真推；force 仅映射 --force-with-lease 安全强推），执行前请确认 cwd、remote、branch",
  ruleId: "github-toolkit-git-push",
};

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " 参数错误：" + cwdErr;
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
        return label + "：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
      }
      if (/HEAD|ambiguous/i.test(raw)) {
        return label + "：无法确定当前分支（游离 HEAD 或仓库尚无提交）：请显式传 branch 参数，或先检出分支。";
      }
      return label + " 读取分支失败：\n" + (brR.message || raw);
    }
    branch = brR.stdout.trim();
    if (!branch || branch === "HEAD") {
      return label + "：当前处于游离 HEAD 或分支未命名，无法推送。请先检出/创建分支（githana_git(action=\"exec\")：checkout -b <branch>）或显式传 branch。";
    }
  }

  // 远端 URL：只用来判定这次推送走哪条凭据路径（github.com 的 https 才注入 App 令牌），
  // 以及让「远端不存在」在推送前就说清楚。remote 也可能直接写成 URL（那时 get-url 会失败），
  // 所以取不到就退回 remote 本身——探测失败不拦推送，注入与否由 git-cred 按子命令判定。
  const token = getToolSecretToken();
  const urlR = await runCli("git", ["remote", "get-url", remote], { cwd, timeoutSec: 30 });
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
        "推送成功（dryRun=" + dryRun + "）：" + remote + " " + branch +
          (setUpstream ? "（-u 已建立上游跟踪）" : "") + (force ? "（--force-with-lease）" : ""),
      ]
    : [
        "推送失败（exit code " + r.exitCode + "）：" + remote + " " + branch + "",
      ];
  if (r.ok && githubTarget && token) {
    text.push("凭据：已用本 App 的 GitHub App 令牌认证（credential helper，只对 github.com 的 https 远端）。");
  }
  const rawOut = (r.stdout || "").trim();
  const rawErr = (r.stderr || "").trim();
  if (rawOut) text.push("—— stdout ——\n" + rawOut);
  if (rawErr) text.push("—— stderr ——\n" + rawErr);
  if (r.ok) {
    if (/Everything up-to-date/.test(rawOut + rawErr)) {
      text.push("远端已是最新（Everything up-to-date），无新提交需要推送。");
    } else if (/->/.test(rawOut + rawErr)) {
      text.push("远端引用已更新（见上方 -> 行）。");
    }
  } else {
    const s = rawOut + "\n" + rawErr;
    // 顺序要紧：GitHub 拒带 .github/workflows 改动的推送时，文案里同时含 "remote rejected"，
    // 所以「缺 workflows 权限」这一条必须排在通用的 non-fast-forward / rejected 之前。
    if (/refusing to allow .*workflow|workflows? permission|without `workflows` permission/i.test(s)) {
      // App 令牌在位但授权范围不含 workflows：GitHub 会拒带 .github/workflows/* 改动的推送。
      text.push(
        "提示：这次推送带了 .github/workflows/ 下的改动，而当前授权里没有 `workflows: write`。\n" +
        "请到 GitHana 设置页重新点「用 GitHub 登录」拿到新范围；或先把 workflow 改动拆成另一次提交（不含它的推送不受影响）。",
      );
    } else if (/not a git repository/i.test(s)) {
      text.push("提示：当前目录不是 git 仓库，请在仓库目录内执行。");
    } else if (/does not appear to be a git repository|repository .* not found/i.test(s)) {
      text.push("提示：远端 " + remote + " 不存在或不可达：请检查 remote 配置（git remote -v）或 URL。");
    } else if (/non-fast-forward|fetch first|rejected/i.test(s)) {
      text.push("提示：远端拒绝了快进推送（non-fast-forward）：先拉取合并远端变更，或用 githana_git(action=\"push\") 的 force=true（--force-with-lease）安全覆盖。");
    } else if (/Authentication failed|could not read Username|fatal: unable to access|Invalid username or password|HTTP 403|403 Forbidden/i.test(s)) {
      text.push("提示：远端认证失败。" + gitAuthGuide(githubTarget, token));
    }
  }
  return text.join("\n");
}

/**
 * 认证失败时的引导：按「这次有没有注入 App 令牌」分流——两种情况的可修之处不同，
 * 给同一句话等于让调用方去试一个不对的方向。
 */
function gitAuthGuide(githubTarget, token) {
  if (githubTarget && token) {
    return (
      "已注入 App 令牌但 GitHub 仍拒绝：多半是令牌授权范围不覆盖这次操作（如带 .github/workflows 改动需要 `workflows: write`），" +
      "或令牌已失效——请到 GitHana 设置页重新点「用 GitHub 登录」后重试。"
    );
  }
  if (githubTarget && !token) {
    return (
      "本次推送没有可用的 App 令牌（尚未登录），已回落系统 Git 凭据。" + GIT_CREDENTIAL_NOTE + "。\n" +
      "要让换台机器也能推送，请到 GitHana 设置页点「用 GitHub 登录」；" +
      "或先确认本机 Git Credential Manager 里已有该远端的凭据。"
    );
  }
  return (
    "远端不是 github.com 的 https 地址，本 App 的令牌只对 github.com 生效，这条路走系统 Git 凭据。" +
    "请确认本机已有该远端的凭据，或检查远端 URL 协议。"
  );
}

