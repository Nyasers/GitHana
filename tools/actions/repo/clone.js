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
 * 凭据：clone 是取远端动作，与 push 走同一条路——GitHub App 令牌由**本 App 自写的
 * remote helper** 使用（tools/lib/remote-helper-shim.js 在 spawn git 时注入 insteadOf 与 PATH）。
 * helper 自己从 dataDir 解 DPAPI 密文、自己发 HTTPS，所以令牌不进命令行、不进远端 URL、
 * 不进 gitconfig、**不进 git 子进程的 env**，也不会出现在返回值里。
 */
import { z } from "zod";
import path from "node:path";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { parseRepo } from "../../lib/gh.js";
import { GIT_FETCH_AUTH_NOTE } from "../../lib/remote-helper-shim.js";

export const command = "clone";
export const summary = "Clone a repository locally (runs git clone)";

export const schema = {
  repo: params.repo.describe("Required: the repository to clone, in owner/repo form (this verb does not infer it from cwd)"),
  cwd: params.cwd.describe("Absolute path of the local **parent directory**: the clone lands under cwd/<repository name> (must already exist)"),
  directory: z.string().optional().describe("Optional: target directory name (defaults to the repository name); it is only ever created under cwd"),
  branch: z.string().optional().describe("Optional: branch to check out after cloning (git clone --branch)"),
  depth: z.number().int().min(1).optional().describe("Optional: shallow clone depth (git clone --depth, only the most recent N commits)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "Create a repository directory on the local disk and write the full history into it (runs git clone, needs network; a shallow clone is limited by depth): occupies disk space and writes under cwd — confirm repo and cwd before running",
  ruleId: "github-toolkit-repo-clone",
};

/** git 错误 → 中文引导（与 pr/checkout 同一份口径）。 */
function gitGuide(text) {
  const s = String(text || "");
  if (/destination path .* already exists|already exists and is not an empty directory/i.test(s)) {
    return "The target directory already exists and is not empty: git clone will not overwrite it. Use another directory, or deal with that directory yourself first.";
  }
  if (/could not read Username|Authentication failed|Repository not found|unable to access/i.test(s)) {
    return (
      "Remote authentication failed or the repository is not visible: " + GIT_FETCH_AUTH_NOTE + ".\n" +
      "If you have not signed in to the App yet, go to the GitHana settings page and click \"Sign in with GitHub\"; " +
      "if the repository really does exist and is public, check whether owner/repo is misspelled."
    );
  }
  if (/not found|Could not resolve host/i.test(s)) {
    return "The remote is unreachable or the repository does not exist: check the network and owner/repo.";
  }
  return null;
}

export async function run(input, ctx, { label }) {
  // repo 必填且**不做 cwd 推断**：clone 的目标就是 repo 本身，cwd 在这里是落盘位置，
  // 拿它去反推仓库会把两件事混成一件事。
  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return label + " argument error: " + repoRes.error;
  if (!repoRes) {
    return (
      label + " argument error: repo is required (owner/repo form).\n" +
      "For this verb cwd is the **destination on disk**, not something used to infer the repository; to infer a repository from the current directory use githana_repo(action=\"view\")."
    );
  }
  const repo = repoRes.owner + "/" + repoRes.repo;

  const cwdErr = checkCwd(input?.cwd);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = input?.cwd !== undefined && input?.cwd !== null ? String(input.cwd).trim() : "";
  if (!cwd) {
    return (
      label + " argument error: cwd is required (the absolute path of the local **parent directory**; the clone lands under cwd/<repository name>).\n" +
      "This App does not infer a working directory implicitly, and it will not put anything in the system temp directory."
    );
  }

  const dirName =
    input?.directory !== undefined && input?.directory !== null && String(input.directory).trim() !== ""
      ? String(input.directory).trim()
      : repoRes.repo;
  // 目录名必须是**单层**：带分隔符就跑到 cwd 之外了，那不是这个参数的意思（要别的落点请改 cwd）。
  if (dirName.includes("/") || dirName.includes("\\") || dirName === "." || dirName === "..") {
    return label + " argument error: directory can only be a single-level directory name (received: " + dirName + "). To change the destination, change cwd.";
  }

  const args = ["clone"];
  if (input?.depth !== undefined && input?.depth !== null) args.push("--depth", String(input.depth));
  if (input?.branch !== undefined && input?.branch !== null && String(input.branch).trim() !== "") {
    args.push("--branch", String(input.branch).trim());
  }
  // 用 https 形态：凭据由 App 自写的 remote helper 处理（不是 URL 形态）——
  // 令牌不进命令行，也不进远端 URL。
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
      label + " clone failed (" + repo + " → " + dest + "):\n" +
      (raw || r.message) + (guide ? "\n" + guide : "")
    );
  }

  const out = [
    label + " done:",
    "repository: " + repo,
    "local path: " + dest,
  ];
  if (input?.depth) out.push("shallow clone: --depth " + input.depth);
  if (input?.branch) out.push("branch: " + String(input.branch).trim());
  out.push("next step: githana_git(action=\"exec\", cwd=\"" + dest + "\", args=[\"status\"]) to see the working tree.");
  return out.join("\n");
}
