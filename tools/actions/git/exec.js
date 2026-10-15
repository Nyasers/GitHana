// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * git/exec：通用 git CLI 透传（githana_git 动词）。
 *
 * 把任意 git 子命令以参数数组透传给本地 git CLI：args 全量透传（首元素为子命令，
 * 如 ["status", "--porcelain"]、["add", "src/a.js"]、["log", "--oneline", "-3"]），
 * 无 shell 拼接（spawn 参数数组），适用于透传层覆盖不到的长尾操作
 * （rebase 等需交互 TTY 的流程除外——本动词非交互参数化执行）。
 *
 * 语义：
 * - cwd 必填（绝对路径），仓库上下文一律显式传参，不做工作目录隐式推断；
 * - 超时缺省 120s、上限 600s；stdout/stderr 分通道截断 200KB、CRLF 归一 LF；
 * - 返回可读摘要：命令、exit code、stdout、stderr；
 * - 非零退出保留 git 原始输出（stderr/stdout 原样呈现）；
 * - cwd 不存在/非目录、git 不在 PATH、超时 → 中文可读错误；
 * - cwd 非 git 仓库时透传 git 原始错误并附中文引导。
 *
 * 本动词是纯净透传（无隐式 Co-authored-by），提交自动署名请走 githana_git(action="commit")。
 * 可执行文件经 lib/bin.js 解析（内嵌 MinGit 优先，见 lib/exec.js runCli）。
 */
import { z } from "zod";
import { runCli, formatCliResult, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";

export const command = "exec";
export const summary = "Passthrough for any git subcommand";

export const schema = {
  cwd: params.cwd,
  args: z
    .array(z.string())
    .min(1)
    .describe(
      "Complete git argument list (array, no shell concatenation): the first element is the subcommand, e.g. [\"status\",\"--porcelain\"], [\"add\",\"src/a.js\"], [\"log\",\"--oneline\",\"-5\"]",
    ),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "Run any git subcommand in the given repository (cwd absolute path) (arguments passed through as an array): may change local repository state (working tree / index / commits / branches / tags / config, depending on the subcommand; push-like subcommands may also push to the remote) — confirm cwd and the command arguments before running",
  ruleId: "github-toolkit-git-exec",
};

/** git 提示 → 中文引导（边界条件映射） */
function gitGuidance(stderr) {
  const s = String(stderr || "");
  if (/not a git repository|not our repo|does not appear to be a git repository/i.test(s)) {
    return "The directory is not a git repository: git cannot run here. Run it inside a repository directory (or git init first and retry).";
  }
  if (/Please tell me who you are|unable to auto-detect email|user\.name|user\.email/i.test(s)) {
    return "git has no committer identity configured: configure git config user.name / user.email first (you can use githana_git(action=\"exec\") to configure it).";
  }
  return null;
}

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;

  const cwd = String(cwdParam).trim();
  // args 的"非空字符串数组"由 schema 保证（见上方 schema）；这里只做透传。
  const args = input.args.map((a) => String(a));
  const timeoutSec = input?.timeoutSec;

  const result = await runCli("git", args, { cwd, timeoutSec });
  const text = formatCliResult("git", args, result);
  // 非零退出时附加中文引导（如非 git 仓库 / 身份未配置）
  if (!result.ok && result.exitCode !== null && result.message) {
    const guide = gitGuidance(result.stderr || result.stdout);
    return guide ? text + "\n" + guide : text;
  }
  return text;
}
