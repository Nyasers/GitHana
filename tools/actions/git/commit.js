// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * git/commit：本地提交 + 自动 Co-authored-by 署名（githana_git 动词）。
 *
 * 核心语义（逐条保真）：
 * - message 用 stdin 传（git commit -F -），多行/中文无损；
 * - 自动 Co-authored-by trailer：固定写死（对齐「直接写死」决策，无配置键）——
 *   Co-authored-by: HanaAgent <313794804+HanaAgent@users.noreply.github.com>
 *   （@HanaAgent 为 liliMozi 注册的官方账号，仅作协作署名实体，不承担登录/认证；
 *   GitHub 据 email 把协作者归到 @HanaAgent）。
 *   在 message 尾部补空行后追加；message 已含 /^Co-authored-by:/mi 行则跳过（去重）。
 * - amend=true 且 message 为空：读 HEAD 完整 message（git log -1 --format=%B）作为基底，
 *   再按上述规则拼 trailer（既有 trailer 已含时自动去重，不重复追加）；
 * - 提交前检查：paths 缺省且无已暂存内容（git diff --cached --quiet 非零即无）→ 返回提示
 *   引导 git add 或传 paths，不空提交；allowEmpty=true 才允许空提交（--allow-empty）。
 * - paths：相对 cwd 的可选文件列表（缺省提交全部已 staged 内容；提供则只提交这些文件，
 *   文件未暂存也会按其工作区内容提交——git commit <paths> 语义）；与 amend 不能同用（git 限制）。
 * - 返回：短 hash + 首行 + 文件数统计（含署名是否追加的说明）。
 *
 * 签名由隔离 gitconfig 的 user.signingkey + commit.gpgsign=true 驱动，gpg.program 由
 * buildBinEnv 每次 spawn 注入随包的签名 shim（见 tools/lib/sign-shim.js）。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";

export const command = "commit";
export const summary = "Commit (automatic CoA + signing)";

export const schema = {
  cwd: params.cwd,
  // message 声明为可选：amend 且需沿用上一条提交说明时**整个键可以不给**（run() 会去读 HEAD），
  // "非 amend 时必须有内容"是业务判断（空串与缺省都要给出引导），留给 run()，schema 只管类型。
  message: z
    .string()
    .optional()
    .describe(
      "Commit message (required when not amending; for amend with the original message reused, pass an empty string or omit it): supports multiple lines (title and body separated by a blank line) and Chinese; passed losslessly via stdin",
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe("Optional: list of relative paths to commit (relative to cwd, e.g. [\"src/a.js\"]); by default all staged content is committed"),
  amend: z
    .boolean()
    .optional()
    .describe("Optional: rewrite the most recent commit (--amend); when message is empty the full HEAD message is reused and the signature is merged in automatically (an existing Co-authored-by is not duplicated)"),
  allowEmpty: z
    .boolean()
    .optional()
    .describe("Optional: allow an empty commit (--allow-empty); default false — with no paths and nothing staged it does not create an empty commit but returns guidance"),
};

export const sideEffect = {
  kind: "git_local",
  summary:
    "Create a local commit in the given repository (cwd) and automatically append a Co-authored-by signature: changes local git history (creates a new commit; with amend it rewrites the most recent one) and does not push to the remote — confirm cwd, message and paths before running",
  ruleId: "github-toolkit-git-commit",
};

/** 固定署名：@HanaAgent（liliMozi 注册的官方账号，仅作 Co-authored-by 协作署名实体，不承担登录/认证）。
 * name/email 写死（对齐「直接写死」决策），GitHub 据 email 把协作者归到 @HanaAgent。 */
const CO_AUTHOR_NAME = "HanaAgent";
const CO_AUTHOR_EMAIL = "313794804+HanaAgent@users.noreply.github.com";
/** 去重检测：消息任一行以 Co-authored-by: 开头（大小写不敏感、multiline） */
const CO_AUTHOR_LINE = /^Co-authored-by\s*:/im;

/** CRLF → LF（message 内部归一，避免 git 告警/不一致） */
function toLf(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/** git 错误 → 中文引导（提交相关边界） */
function commitGuidance(stderr, stdout) {
  const s = String(stderr || "");
  if (/not a git repository|does not appear to be a git repository|not our repo/i.test(s)) {
    return "The current directory is not a git repository: run this inside a repository directory (or git init first).";
  }
  if (/Please tell me who you are|unable to auto-detect email|user\.name|user\.email/i.test(s)) {
    return "git has no committer identity configured: configure git config user.name / user.email first (you can use githana_git(action=\"exec\") to configure it).";
  }
  if (/pathspec|does not match any|unable to resolve/i.test(s)) {
    return "The paths do not match: the pathspec did not hit anything — the file may not exist, may not be inside the repository, or may be ignored by .gitignore (git's raw output is above).";
  }
  return null;
}

/**
 * 组装最终 message：基底 + Co-authored-by 署名（固定写死）。
 * @returns {{ final: string, note: string }} note 说明署名动作（供返回展示/冒烟验证）
 */
function assembleMessage(base) {
  const body = toLf(base).replace(/\s+$/, "");
  if (CO_AUTHOR_LINE.test(body)) {
    return { final: body, note: "the message already contains a Co-authored-by line, so automatic signing was skipped (deduplication in effect)" };
  }
  const line = "Co-authored-by: " + CO_AUTHOR_NAME + " <" + CO_AUTHOR_EMAIL + ">";
  return { final: body + "\n\n" + line, note: "signature appended automatically: " + line };
}

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = String(cwdParam).trim();

  const amend = input?.amend === true;
  const allowEmpty = input?.allowEmpty === true;
  const userMessage = toLf(input?.message ?? "").trimEnd();

  // paths："字符串数组"由 schema 保证；这里只做逐项的语义规则（空项、必须相对 cwd）。
  let paths = [];
  if (input?.paths !== undefined && input?.paths !== null) {
    for (const p of input.paths) {
      const s = String(p ?? "").trim();
      if (!s) return label + " argument error: paths contains an empty path entry.";
      if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(s)) {
        return label + " argument error: paths entries must be relative paths (received an absolute path: " + s + "); pass them relative to cwd.";
      }
      paths.push(s);
    }
  }

  if (!amend && !userMessage) {
    return label + " argument error: message is required (a non-amend commit needs a commit message); or use amend=true to reuse the previous commit message.";
  }
  if (amend && paths.length > 0) {
    return label + " argument error: amend cannot be combined with paths (git commit --amend only rewrites the index and does not support a file list). Drop paths or drop amend.";
  }

  // 提交前检查：无 paths 且无已暂存内容 → 引导（allowEmpty / amend 除外——
  // amend 只改写最近提交的 message，不需要 staged 内容；allowEmpty 允许空提交）
  if (paths.length === 0 && !allowEmpty && !amend) {
    const stagedR = await runCli("git", ["diff", "--cached", "--quiet"], { cwd });
    if (!stagedR.ok) {
      const raw = (stagedR.stderr || "").trim();
      if (/not a git repository|does not appear to be a git repository/i.test(raw)) {
        return label + ": the current directory is not a git repository (git says: " + (raw.split("\n")[0] || raw) + "). Run this inside a repository directory.";
      }
      // exit 1 = 有已暂存内容，正常继续；其他非零按错误透传
      if (stagedR.exitCode !== 1) {
        return label + " pre-check failed (git diff --cached --quiet):\n" + (stagedR.message || raw);
      }
    } else {
      // exit 0 = 无任何已暂存内容
      return [
        label + ": nothing to commit — neither paths was given nor are there any staged files.",
        "Start with git add on the target files (you can use githana_git(action=\"exec\")) or pass paths to name the relative paths to commit;",
        "if you really need an empty commit, pass allowEmpty=true explicitly.",
      ].join("\n");
    }
  }

  // 基底 message：amend 且用户未给说明 → 读 HEAD 完整 message（git log -1 --format=%B）
  let base = userMessage;
  if (amend && !base) {
    const headR = await runCli("git", ["log", "-1", "--format=%B"], { cwd });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet|bad default revision|ambiguous argument/i.test(raw)) {
        return label + ": amend needs an existing commit (HEAD does not exist: the repository has no commits yet; use a normal commit rather than amend).";
      }
      if (/not a git repository/i.test(raw)) {
        return label + ": the current directory is not a git repository (git says: " + (raw.split("\n")[0] || raw) + "). Run this inside a repository directory.";
      }
      return label + " failed to read the HEAD message (git log -1 --format=%B):\n" + (headR.message || raw);
    }
    base = toLf(headR.stdout).trimEnd();
  }

  const assembled = assembleMessage(base);

  // paths 模式：先 git add -- <paths>（git commit <paths> 只能提交 git 已知路径——
  // 未跟踪文件必须先暂存；add 后仍按 pathspec 提交，其他已暂存内容不受影响、不会被带入本次提交）
  if (paths.length > 0) {
    const addR = await runCli("git", ["add", "--", ...paths], { cwd });
    if (!addR.ok) {
      const raw = ((addR.stderr || "") + "\n" + (addR.stdout || "")).trim();
      const guide = commitGuidance(addR.stderr, addR.stdout);
      const text = label + " staging the paths failed (git add):\n" + (raw || addR.message || "unknown error");
      return guide ? text + "\n" + guide : text;
    }
  }

  // git commit -F -（stdin 传 message，多行/中文无损）
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  if (allowEmpty) args.push("--allow-empty");
  if (paths.length > 0) args.push("--", ...paths);

  const commitR = await runCli("git", args, { cwd, input: assembled.final + "\n" });
  if (!commitR.ok) {
    const raw = ((commitR.stderr || "") + "\n" + (commitR.stdout || "")).trim();
    const guide = commitGuidance(commitR.stderr, commitR.stdout);
    const text =
      label + " execution failed (exit code " + commitR.exitCode + "):\n" +
      (raw || commitR.message || "unknown error");
    return guide ? text + "\n" + guide : text;
  }

  // —— 成功：取短 hash + 首行 + 文件数 ——
  const hashR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd });
  const hash = hashR.ok ? hashR.stdout.trim() : "";
  const subjR = await runCli("git", ["log", "-1", "--format=%s"], { cwd });
  const subject = subjR.ok ? subjR.stdout.trim() : "";

  const filesR = await runCli("git", ["show", "--format=", "--name-only", "HEAD"], { cwd });
  const fileLines = filesR.ok
    ? filesR.stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "")
    : [];
  const fileCount = allowEmpty && fileLines.length === 0 ? 0 : fileLines.length;

  const out = [
    "commit created: " + (hash || "?") + (subject ? "  " + subject : ""),
    "files: " + fileCount + (fileLines.length ? "\n  " + fileLines.map((f) => "· " + f).join("\n  ") : ""),
    assembled.note,
  ];
  return out.join("\n");
}
