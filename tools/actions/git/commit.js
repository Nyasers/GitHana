// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * git/commit：本地提交 + 自动 Co-authored-by 署名（githana_git 动词）。
 *
 * 核心语义（逐条保真）：
 * - message 用 stdin 传（git commit -F -），多行/中文无损；
 * - 本地提交的作者固定是隔离 gitconfig 里的用户；bot 作者只出现在 via="api"（GitHub API
 *   生成提交，GitHub 代签）；
 * - 署名来自设置页（作者 + 共同作者）。设置页用对外的名字：作者 "user" / "app"，
 *   共同作者 "user" / "app" / "agent"；这里映射回内部实体 key：
 *     "user" → 用户 gitconfig 身份，"app" → githana-bot，"agent" → hanaagent。
 *   可任意组合，[] 表示不写 trailer。
 *   各实体的 name/email 固定写死（对齐「直接写死」决策，无配置键）：
 *     Co-authored-by: HanaAgent <313794804+HanaAgent@users.noreply.github.com>（liliMozi 注册的官方账号，
 *       仅作协作署名实体，不承担登录/认证）
 *     Co-authored-by: githana-app[bot] <340878445+githana-app[bot]@users.noreply.github.com>
 *       （GitHana App 的 GitHub App bot；GitHub 据 email 把协作者归到该账号）
 *     Co-authored-by: <用户 gitconfig 里的 name/email>
 *   在 message 尾部补空行后按固定顺序追加；message 里已有的 Co-authored-by trailer
 *   由工具接管（抹掉后按所选组合重写）。
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
 *
 * via="api" 时不走本地 git：交给 tools/actions/git/api-commit.js 通过 Git Data API 生成
 * 提交，GitHub 用 web-flow 代签（Verified）；author 固定 bot，本地分支在其后快进。
 * 本地通道不再提供“bot 作者”选项：那样只能得到无签名 / Unverified 的提交，与 API 通道重复。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../../lib/exec.js";
import * as params from "../../lib/params.js";
import { getToolDataDir } from "../../lib/context.js";
import { runApiCommit } from "./api-commit.js";
import { getBotIdentity } from "../../../lib/app-auth.js";
import { readIdentity } from "../../../lib/prefs.js";

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
  repo: z
    .string()
    .optional()
    .describe('Optional when the commit channel is the App bot: owner/name or a github.com URL; defaults to the origin remote of cwd'),
  branch: z
    .string()
    .optional()
    .describe('Optional when the commit channel is the App bot: target branch; defaults to the current branch'),
};

export const sideEffect = {
  // 审批面按 sessionPermission.kind 统一走 external_side_effect，这里只声明动词本身的影响面；
  // via="api" 会移动远端分支，这一点写在 summary 里，不靠 kind 区分。
  kind: "git_local",
  summary:
    "Create a commit in the given repository (cwd): locally as the user (OpenPGP-signed), or through the GitHub API as the GitHana App bot (via=\"api\", Verified signature from GitHub). Co-authored-by trailers are selectable. A local commit only changes local history and does not push; an API commit moves the remote branch and fast-forwards the local branch.",
  ruleId: "github-toolkit-git-commit",
};

/** 固定实体表（user 与 bot 的身份都是运行时取的，不在这里）。 */
const CREDITS = {
  hanaagent: { name: "HanaAgent", email: "313794804+HanaAgent@users.noreply.github.com" },
};
/** 输出里的作者说明。 */
const AUTHOR_LABEL = "user (isolated gitconfig identity)";
/** API 通道的作者说明：签名由 GitHub 代做。 */
const AUTHOR_LABEL_API = "githana-app[bot] (GitHana App bot, signed by GitHub)";


/** 行首无缩进的 Co-authored-by：git 只把这种当 trailer，缩进的是正文。
 * 冒号前允许空格——`Co-authored-by :` 同样会被 git 当成 trailer。 */
const CO_AUTHOR_TRAILER_LINE = /^co-authored-by\s*:/i;

/** 由实体 key 生成规范 trailer 行。user 与 bot 用运行时读到的身份。 */
function canonicalLine(key, { userIdentity, botIdentity }) {
  if (key === "user") return "Co-authored-by: " + userIdentity.name + " <" + userIdentity.email + ">";
  if (key === "githana-bot") return "Co-authored-by: " + botIdentity.name + " <" + botIdentity.email + ">";
  const id = CREDITS[key];
  return "Co-authored-by: " + id.name + " <" + id.email + ">";
}

/**
 * 读仓库当前生效的用户身份（隔离 gitconfig + 仓库级配置的合并结果）。
 * coAuthors 含 "user" 时需要；读不到返回 null。
 */
async function readUserIdentity(cwd) {
  const nameR = await runCli("git", ["config", "--get", "user.name"], { cwd });
  const emailR = await runCli("git", ["config", "--get", "user.email"], { cwd });
  const name = nameR.ok ? nameR.stdout.trim() : "";
  const email = emailR.ok ? emailR.stdout.trim() : "";
  return name && email ? { name, email } : null;
}

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
 * 组装最终 message：拿掉所有 trailer 形式的 Co-authored-by，按所选组合重写规范行。
 *
 * 以前的去重是 `/^Co-authored-by\s*:/im` 一命中就跳过。它只看前缀、不看内容，
 * 于是手写一行格式合法但地址错的 trailer 会把自动追加顶掉：错地址进永久历史，
 * GitHub 按 email 归属协作者，直接在仓库页上多一个陌生的灰头像 contributor。
 *
 * 现在的规矩：Co-authored-by 归工具写。message 里所有这类行（不管地址对不对、
 * 谁写的）一律抹掉，末尾按 coAuthors 补上规范行；coAuthors 为空则一行不留。
 *
 * 抹掉但不静默：与所选组合不一致的行原样回传，调用方以 warning 形式展示。
 * 与规范行完全一致的不列——amend 从 HEAD 读回 message 时会走过同一条路，
 * 那是重写不是丢弃，不该每次 amend 都报一次 warning。
 *
 * 也不报错：那行本就不该由人写，修法完全确定（抹掉再补），没必要让人为一步机械
 * 操作多跑一轮。保持原行也是错的：地址不对就多一个假 contributor，地址对了也是重复。
 *
 * 只认行首无缩进的（不 trim 判断前）：git 也只把这种当 trailer。正文里缩进的例句
 * （如文档里“    Co-authored-by: ...”这种）trim 后与真 trailer 长得一样，不能误抹。
 *
 * 侧面好处：amend 重放不用特例。从 HEAD 读回的 message 里若有旧的错地址，
 * 走同一条路就修好了。
 *
 * @param {string} base 用户给的（或 amend 从 HEAD 读回的）message
 * @param {string[]} coAuthors 已校验、已去重、已按固定顺序排好的实体 key
 * @param {{ userIdentity: {name:string,email:string}|null, botIdentity: {name:string,email:string}|null }} identities
 * @returns {{ final: string, note: string, replaced: string[], appended: string[] }}
 *   replaced 是被丢弃的非规范行；appended 是末尾写进去的规范行（可能为空）。
 */
function assembleMessage(base, coAuthors, identities) {
  const appended = coAuthors.map((key) => canonicalLine(key, identities));
  const canonical = new Set(appended);
  const body = toLf(base).replace(/\s+$/, "");

  const replaced = [];
  const kept = body
    .split("\n")
    .filter((line) => {
      if (CO_AUTHOR_TRAILER_LINE.test(line)) {
        const trimmed = line.trim();
        if (!canonical.has(trimmed)) replaced.push(trimmed);
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\s+$/, "");

  let note;
  if (appended.length === 0) {
    note = "no Co-authored-by trailer written: this commit is credited to the author only";
  } else if (appended.length === 1) {
    note = "signature appended: " + appended[0];
  } else {
    note = "signatures appended:\n" + appended.map((l) => "  · " + l).join("\n");
  }

  return {
    final: appended.length ? (kept ? kept + "\n\n" : "") + appended.join("\n") : kept,
    note,
    replaced,
    appended,
  };
}

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " argument error: " + cwdErr;
  const cwd = String(cwdParam).trim();

  const amend = input?.amend === true;
  const allowEmpty = input?.allowEmpty === true;
  const userMessage = toLf(input?.message ?? "").trimEnd();

  // 提交通道与署名组合都按设置页的设定，不接受工具参数覆盖。
  if (input?.via !== undefined || input?.coAuthors !== undefined) {
    return (
      label +
      ' argument error: the commit channel (local / App bot) and the Co-authored-by set come from the GitHana settings page; do not pass "via" or "coAuthors" here.'
    );
  }
  const identity = readIdentity(getToolDataDir());
  // 服务面（跨 App 调用）只能做本地提交：它没有 Approval 闸门，绝不能借设置里的 App 通道
  // 去动远端分支。
  const forcedLocal = input?.__forceLocal === true;
  const via = forcedLocal ? "local" : identity.commitAuthor === "app" ? "api" : "local";
  if (via === "api") {
    if (amend) return label + ' argument error: the settings page selects App-bot commits, which do not support amend (an API commit is built on the remote tip). Switch the channel in the GitHana settings page to commit locally.';
    if (allowEmpty) return label + ' argument error: the settings page selects App-bot commits, which do not support allowEmpty. Switch the channel in the GitHana settings page to commit locally.';
  }

  // 本地通道的作者恒为用户；bot 作者只存在于 API 通道。
  const author = via === "api" ? "githana-bot" : "user";

  // 设置页按身份存署名，这里映射回内部实体 key。
  const CREDIT_IDENTITY = { user: "user", app: "githana-bot", agent: "hanaagent" };
  const coAuthors = identity.coAuthors
    .map((k) => CREDIT_IDENTITY[k] || k)
    .filter((k) => k !== author);

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

  // 读一次用户 identity：coAuthors 含 user 时写进 trailer；本地提交也用它填回执。
  // bot 的 name/email 是常量，不依赖用户 gitconfig。
  const userIdentity = await readUserIdentity(cwd);
  if (!userIdentity && coAuthors.includes("user")) {
    return [
      label + ": the git user identity is not configured, so the user cannot be named as a co-author.",
      "Configure git config user.name / user.email first (you can use githana_git(action=\"exec\")), or drop the \"user\" entry from coAuthors.",
    ].join("\n");
  }

  const botIdentity =
    via === "api" || coAuthors.includes("githana-bot") ? await getBotIdentity(getToolDataDir()) : null;

  const assembled = assembleMessage(base, coAuthors, { userIdentity, botIdentity });

  // —— API 通道：GitHub 生成提交并代签，用户只以 Co-authored-by 出现 ——
  if (via === "api") {
    let result;
    try {
      result = await runApiCommit({
        cwd,
        message: assembled.final,
        paths,
        repo: input?.repo,
        branch: input?.branch,
        dataDir: getToolDataDir(),
      });
    } catch (e) {
      return label + " API commit failed: " + String((e && e.message) || e);
    }

    const subject = (assembled.final.split("\n")[0] || "").trim();
    const authorLabel = botIdentity
      ? botIdentity.login + " (GitHana App bot, signed by GitHub)"
      : AUTHOR_LABEL_API;
    const out = [
      "commit created (API, " + authorLabel + "): " + (result.hash ? result.hash.slice(0, 7) : "?") + (subject ? "  " + subject : ""),
      "branch: " + result.branch + " @ " + result.owner + "/" + result.repo +
        (result.synced
        ? " (local branch fast-forwarded)"
        : " (local branch NOT synced: " +
          (result.syncNote || "run git fetch and git merge --ff-only manually") +
          ")"),
      "files: " + result.files.length + (result.files.length ? "\n  " + result.files.map((f) => "· " + f).join("\n  ") : ""),
      assembled.note,
      result.verified === true
        ? "signature: Verified (signed by GitHub web-flow)"
        : result.verified === false
          ? "signature: GitHub reports NOT verified (check that the App installation has Contents: write and that no custom author was sent)"
          : "signature: verification status could not be read back; check the commit on GitHub",
    ];
    if (assembled.replaced && assembled.replaced.length) {
      out.push("warning: these Co-authored-by line(s) in your message were discarded and replaced by the coAuthor selection above:");
      out.push(...assembled.replaced.map((l) => "  · " + l));
    }
    return {
      content: [{ type: "text", text: out.join("\n") }],
      details: {
        ok: true,
        action: "commit",
        via: "api",
        cwd,
        hash: result.hash,
        shortHash: result.hash ? result.hash.slice(0, 7) : "",
        subject,
        fileCount: result.files.length,
        files: result.files,
        author: "githana-bot",
        authorIdentity: botIdentity,
        signed: result.verified === true,
        verified: result.verified,
        credits: ["githana-bot", ...coAuthors],
        coAuthors,
        coAuthorAppended: assembled.appended.length > 0,
        coAuthorReplaced: assembled.replaced || [],
        branch: result.branch,
        repo: result.owner + "/" + result.repo,
        synced: result.synced,
      },
    };
  }

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

  // 签名状态读真实的 %G?，不假定隔离 gitconfig 一定签了：没配 user.signingkey 时也能提交，
  // 但那时 signed 必须说 false。
  const sigR = await runCli("git", ["log", "-1", "--format=%G?"], { cwd });
  const sigStatus = sigR.ok ? sigR.stdout.trim() : "";
  // signed 只说「提交里有没有签名对象」：N = 无签名，E = 签名在但 git 无法校验（仍算带了签名）。
  const signed = sigStatus !== "" && sigStatus !== "N";

  const out = [
    "commit created: " + (hash || "?") + (subject ? "  " + subject : ""),
    "author: " + AUTHOR_LABEL,
    "signature: " +
      (sigStatus === "G"
        ? "valid OpenPGP signature"
        : sigStatus === "" || sigStatus === "N"
          ? "none (the isolated gitconfig has no signing key: set user.signingkey / commit.gpgsign to sign local commits)"
          : "status " + sigStatus + " (a signature is present, but git could not verify it)"),
    "files: " + fileCount + (fileLines.length ? "\n  " + fileLines.map((f) => "· " + f).join("\n  ") : ""),
    assembled.note,
  ];
  // 被丢弃的行原样打出来：Co-authored-by 由本工具写，但换了什么不该只我们知道。
  if (assembled.replaced && assembled.replaced.length) {
    out.push("warning: these Co-authored-by line(s) in your message were discarded and replaced by the coAuthor selection above:");
    out.push(...assembled.replaced.map((l) => "  · " + l));
  }
  // 结构化结果：调用方（编排脚本 / 后续步骤）拿得到 hash 与文件列表，不必去解上面那段给人读的文本。
  return {
    content: [{ type: "text", text: out.join("\n") }],
    details: {
      ok: true,
      action: "commit",
      cwd,
      hash,
      shortHash: hash,
      subject,
      fileCount,
      files: fileLines,
      amended: amend,
      author,
      authorIdentity: userIdentity,
      signed,
      signatureStatus: sigStatus,
      credits: coAuthors.length ? [author, ...coAuthors] : [author],
      coAuthors,
      coAuthorAppended: assembled.appended.length > 0,
      coAuthorReplaced: assembled.replaced || [],
    },
  };
}
