// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/clone：把远端仓库取到本地（githana_repo 动词）。
 *
 * ## 为什么它靠本地 git 而不是 REST
 *
 * gh `repo clone` 不是 REST 端点的对应物：`gh repo clone` 的正文就是「跑一次 git clone」，
 * GitHub 的 API 也没有「把仓库放到本机某个目录」这种端点（`GET /repos/{o}/{r}/tarball` 给的是
 * 归档，没有 .git、没有分支与历史，取下来推不回去）。所以本动词走 **本地 git 子进程**
 * （tools/lib/exec.js 的 runCli），与 `pr checkout` 同一条路——那也是本工具面里唯一能产生一个
 * 「可继续 commit / push 的本地仓库」的手段。
 *
 * 目录约定与 gh 一致但更严：`cwd` 是**父目录**（克隆落在 `cwd/<仓库名>`），必须显式给、必须存在；
 * 目标目录已存在就拒绝——不做「克隆进非空目录」这种半途状态，也不覆盖。
 *
 * 凭据：与 githana_git 的 push 同一口径（本 App 不注入 git 凭据，走系统 Git Credential Manager），
 * 私有仓库要求本机已有该远端的凭据。令牌不会出现在命令行、日志或返回值里。
 */
import { z } from "zod";
import path from "node:path";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { parseRepo } from "../../lib/gh.js";

export const command = "clone";
export const summary = "克隆仓库到本地（跑 git clone）";

export const schema = {
  repo: params.repo.describe("必填：要克隆的仓库，格式 owner/repo（本动词不从 cwd 推断）"),
  cwd: params.cwd.describe("本地**父目录**的绝对路径：克隆落在 cwd/<仓库名> 下（必须已存在）"),
  directory: z.string().optional().describe("可选：目标目录名（默认取仓库名）；只会建在 cwd 之下"),
  branch: z.string().optional().describe("可选：克隆后检出的分支（git clone --branch）"),
  depth: z.number().int().min(1).optional().describe("可选：浅克隆深度（git clone --depth，只取最近 N 个提交）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "在本地磁盘上新建一个仓库目录并写入完整历史（跑 git clone，需要网络；浅克隆受 depth 限制）：会占用磁盘并写入 cwd，执行前请确认 repo 与 cwd",
  ruleId: "github-toolkit-repo-clone",
};

/** git 错误 → 中文引导（与 pr/checkout 同一份口径）。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/destination path .* already exists|already exists and is not an empty directory/i.test(s)) {
    return "目标目录已存在且非空：git clone 不会覆盖它。请换 directory，或先自己处理那个目录。";
  }
  if (/could not read Username|Authentication failed|Repository not found|unable to access/i.test(s)) {
    return (
      "远端认证失败或仓库不可见：私有仓库需要本机已有该远端的凭据（本 App 不注入 git 凭据，走系统 Git Credential Manager）。\n" +
      "若仓库确实存在且公开，请检查 owner/repo 是否写错。"
    );
  }
  if (/not found|Could not resolve host/i.test(s)) {
    return "远端不可达或仓库不存在：检查网络与 owner/repo。";
  }
  return null;
}

export async function run(input, ctx, { label }) {
  // repo 必填且**不做 cwd 推断**：clone 的目标就是 repo 本身，cwd 在这里是落盘位置，
  // 拿它去反推仓库会把两件事混成一件事。
  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return label + " 参数错误：" + repoRes.error;
  if (!repoRes) {
    return (
      label + " 参数错误：repo 必填（格式 owner/repo）。\n" +
      "本动词的 cwd 是**落盘位置**，不用来推断仓库；要从当前目录反推仓库请用 githana_repo(action=\"view\")。"
    );
  }
  const repo = repoRes.owner + "/" + repoRes.repo;

  const cwdErr = checkCwd(input?.cwd);
  if (cwdErr) return label + " 参数错误：" + cwdErr;
  const cwd = input?.cwd !== undefined && input?.cwd !== null ? String(input.cwd).trim() : "";
  if (!cwd) {
    return (
      label + " 参数错误：cwd 必填（本地**父目录**的绝对路径，克隆落在 cwd/<仓库名> 下）。\n" +
      "本 App 不做工作目录隐式推断，也不接受往系统临时目录里放。"
    );
  }

  const dirName =
    input?.directory !== undefined && input?.directory !== null && String(input.directory).trim() !== ""
      ? String(input.directory).trim()
      : repoRes.repo;
  // 目录名必须是**单层**：带分隔符就跑到 cwd 之外了，那不是这个参数的意思（要别的落点请改 cwd）。
  if (dirName.includes("/") || dirName.includes("\\") || dirName === "." || dirName === "..") {
    return label + " 参数错误：directory 只能是单层目录名（收到：" + dirName + "）。要换落点请改 cwd。";
  }

  const args = ["clone"];
  if (input?.depth !== undefined && input?.depth !== null) args.push("--depth", String(input.depth));
  if (input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== "") {
    args.push("--branch", String(input.branch).trim());
  }
  // `--`：URL 与目录名都是**位置参数**，直接拼进去时 `-` 开头的目录名会被 git 当选项
  // （`git clone <url> -evil-dir` → `error: unknown switch 'e'`）。分隔符之后的 token 一律按位置参数解释。
  // 选项（--depth / --branch）必须留在 `--` 之前：`--branch` 之后的 token 由 git 自己吸收为分支名
  // （实测 `--branch '-x'` 被当分支名而非注入），挪到 `--` 之后就变成位置参数了。
  args.push("--", "https://github.com/" + repo + ".git", dirName);

  const r = await runCli("git", args, { cwd, timeoutSec: input?.timeoutSec });
  const dest = path.join(cwd, dirName);
  if (!r.ok) {
    const raw = ((r.stderr || "") + "\n" + (r.stdout || "")).trim();
    const guide = gitGuide(raw);
    return (
      label + " 克隆失败（" + repo + " → " + dest + "）：\n" +
      (raw || r.message) + (guide ? "\n" + guide : "")
    );
  }

  const out = [
    label + " 完成：",
    "仓库：" + repo,
    "本地路径：" + dest,
  ];
  if (input?.depth) out.push("浅克隆：--depth " + input.depth);
  if (input?.branch) out.push("分支：" + String(input.branch).trim());
  out.push("下一步：githana_git(action=\"exec\", cwd=\"" + dest + "\", args=[\"status\"]) 看工作区。");
  return out.join("\n");
}
