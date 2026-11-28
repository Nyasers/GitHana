// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/actions/git/api-commit.js — 通过 GitHub API 创建提交（bot 身份，GitHub 代签）。
 *
 * 为什么要有这条路：本地 `git commit` 的作者是 gitconfig 里的人，bot 账号没有可上传的
 * 签名公钥；只有「请求认证为 GitHub App / bot」且不带自定义 author/committer/签名的提交，
 * GitHub 才会用 web-flow 密钥代签并标成 Verified（官方文档 Signature verification for bots）。
 * 所以 bot 提交必须走 Git Data API，由 GitHub 生成提交对象。
 *
 * 与本地提交的分工：
 *   - 内容仍然取自本地工作树（或 index）：本模块把变更文件上传成 blob，再拼 tree / commit；
 *   - 本地分支必须与远端 tip 一致（否则拒绝，避免把远端历史覆盖成分叉）；
 *   - 提交成功后把本地分支快进到新提交（fetch + merge --ff-only），工作树内容不变。
 *
 * 不传 author / committer：这是 bot 获得自动签名的前提。用户只以 Co-authored-by trailer
 * 的形式出现在 message 里。
 */
import { runCli, MAX_OUTPUT_BYTES as MAX_CAPTURE_BYTES } from "../../lib/exec.js";
import { callRest } from "../../lib/rest.js";
import { getInstallationToken } from "../../../lib/app-auth.js";

/** 单文件上限（字节）：GitHub blob API 的请求体上限留出 base64 膨胀余量。 */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** 从 callRest 回执取第一条；失败抛出带 HTTP 状态的可读错误。 */
function firstResult(reply, what) {
  if (!reply.ok) throw new Error(what + " failed: " + (reply.message || "the GitHub request could not be sent"));
  const r = reply.results && reply.results[0];
  if (!r) throw new Error(what + " failed: GitHub returned no result");
  if (!r.ok) {
    const detail =
      r.json && (r.json.message || r.json.error)
        ? String(r.json.message || r.json.error)
        : String(r.text || "").slice(0, 400);
    const err = new Error(what + " failed (HTTP " + r.status + "): " + (detail || "no response body"));
    err.status = r.status;
    throw err;
  }
  return r;
}

/** 仓库名的一段：不能是 . / .. 或纯点。 */
function isRepoNameSegment(part) {
  return Boolean(part) && part !== "." && part !== ".." && !/^\.+$/.test(part);
}

/** `owner/name`、`git@github.com:owner/name.git` 或 GitHub URL → { owner, repo }。导出供自检脚本验证。 */
export function parseRepo(value) {
  const s = String(value || "").trim();
  if (!s) throw new Error("the repository is empty.");
  // scp 形式（origin 最常见）先拆，URL 解析吃不下它。
  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (scp && isRepoNameSegment(scp[1]) && isRepoNameSegment(scp[2])) {
    return { owner: scp[1], repo: scp[2].replace(/\.git$/i, "") };
  }
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (/^(www\.)?github\.com$/i.test(u.hostname)) {
      const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length >= 2 && isRepoNameSegment(parts[0]) && isRepoNameSegment(parts[1])) {
        return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
      }
    }
  } catch {
    /* 不是 URL：落到下面的 slug 分支 */
  }
  // 无协议的 `github.com/owner` 不能当 owner/repo：它少了一段，直接点名要怎么写。
  if (/^github\.com\//i.test(s)) {
    throw new Error('the repository "' + s + '" is missing the owner or the protocol: pass owner/name or https://github.com/owner/name.');
  }
  const slug = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (slug && isRepoNameSegment(slug[1]) && isRepoNameSegment(slug[2])) {
    return { owner: slug[1], repo: slug[2].replace(/\.git$/i, "") };
  }
  throw new Error('cannot parse the repository from "' + s + '": pass owner/name or a github.com URL.');
}

/** 从 origin 解析仓库；显式 repo 参数优先。 */
async function resolveRepo(cwd, explicit) {
  if (explicit) return parseRepo(explicit);
  const r = await runCli("git", ["remote", "get-url", "origin"], { cwd });
  if (!r.ok) {
    throw new Error(
      "the repository has no origin remote, so the GitHub API target cannot be determined: " +
        "add one, or pass repo=\"owner/name\" explicitly.",
    );
  }
  return parseRepo(r.stdout);
}

/** 解析 `git diff --name-status -z` 的输出。 */
function parseNameStatus(raw) {
  const parts = String(raw || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (!status) {
      i += 1;
      continue;
    }
    const code = status.charAt(0).toUpperCase();
    if (code === "R" || code === "C") {
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 3;
      // 只有 rename 会让源文件消失；copy 两边都在，多推一个 D 会把源文件删掉。
      if (from && code === "R") out.push({ status: "D", path: from });
      if (to) out.push({ status: to === from ? "M" : "A", path: to });
      continue;
    }
    const file = parts[i + 1];
    i += 2;
    if (file) out.push({ status: code, path: file });
  }
  return out;
}

/**
 * 从 index 取文件内容与 mode。
 *
 * 为什么不读文件系统：App 运行在宿主的权限模型下，只能读 App 自己的目录，用户仓库
 * 不一定在里面（实测读仓库文件会 EACCES）。git 子进程不受这个限制，所以内容一律从
 * index 取——调用前先 `git add` 过 paths，index 就是待提交的内容。
 * 符号链接在 index 里是 mode 120000，blob 内容就是链接目标，不会跟随到仓库外。
 */
/** pathspec 按字面量解释（相对 cwd）：用户传进来的路径与 git add 用这个。 */
function literalPath(p) {
  return ":(literal)" + p;
}

/** git 输出的路径总是相对仓库根：读 index、比对工作区用这个。 */
function rootPath(p) {
  return ":(top,literal)" + p;
}

export async function readStagedFile(cwd, rel) {
  const ls = await runCli("git", ["ls-files", "-s", "-z", "--", rootPath(rel)], { cwd });
  if (!ls.ok) throw new Error("reading the index failed for " + rel + ": " + (ls.message || ""));
  const first = String(ls.stdout || "").split("\0").find((x) => x);
  if (!first) return null;
  const tab = first.indexOf("\t");
  const head = tab >= 0 ? first.slice(0, tab) : first;
  const [mode, sha] = head.split(" ");
  if (!mode || !sha) return null;
  if (mode === "160000") {
    throw new Error(
      "cannot upload " + rel + " through the API: submodule/gitlink changes are not supported by an API commit.",
    );
  }
  if (/^0+$/.test(sha)) return null; // intent-to-add：内容还没进 index
  const blob = await runCli("git", ["cat-file", "blob", sha], { cwd });
  if (!blob.ok) {
    throw new Error("reading blob " + sha.slice(0, 7) + " for " + rel + " failed: " + (blob.message || ""));
  }
  // 输出捕获有 200KB 上限：截断时拿到的只是前缀，绝不能当完整内容传上去。
  if (blob.stdoutTruncated) {
    throw new Error(
      "file too large for an API commit: " + rel + " (the blob exceeds the " + Math.round(MAX_CAPTURE_BYTES / 1024) + " KB capture limit).",
    );
  }
  const content = blob.stdoutBytes && blob.stdoutBytes.length ? blob.stdoutBytes : Buffer.from(blob.stdout || "", "utf8");
  if (content.length > MAX_FILE_BYTES) {
    throw new Error("file too large for an API commit: " + rel + " (" + content.length + " bytes; limit " + MAX_FILE_BYTES + ").");
  }
  return { content, mode };
}

/** 变更集：paths 给定则按工作区相对 HEAD，否则按 index（已暂存）。 */
async function collectChanges(cwd, paths) {
  const args = paths.length
    ? ["diff", "HEAD", "--name-status", "-z", "--", ...paths.map(literalPath)]
    : ["diff", "--cached", "--name-status", "-z"];
  const r = await runCli("git", args, { cwd });
  if (!r.ok) throw new Error("reading local changes failed (git " + args.join(" ") + "):\n" + (r.message || ""));

  const changes = parseNameStatus(r.stdout);

  if (paths.length) {
    // paths 模式允许未跟踪文件（git commit <path> 也会收它们），diff HEAD 看不到。
    const u = await runCli("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths.map(literalPath)], { cwd });
    if (!u.ok) throw new Error("reading untracked files failed: " + (u.message || ""));
    for (const p of String(u.stdout || "").split("\0")) {
      if (p && !changes.some((c) => c.path === p)) changes.push({ status: "A", path: p });
    }
  }

  // 去重（同一路径只保留最后一条）
  const seen = new Map();
  for (const c of changes) seen.set(c.path, c);
  return [...seen.values()];
}

/**
 * 用 API 创建一次提交。
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string} args.message 已组装好的 message（含 Co-authored-by trailer）
 * @param {string[]} args.paths 相对 cwd 的路径；空数组 = 已暂存内容
 * @param {string} [args.repo] owner/name；缺省从 origin 解析
 * @param {string} [args.branch] 目标分支；缺省当前分支
 * @param {string} args.dataDir App 数据目录（读签发服务地址与 secret）
 * @returns {Promise<{ hash: string, branch: string, owner: string, repo: string, files: string[], verified: boolean|null }>}
 */
export async function runApiCommit({ cwd, message, paths, repo, branch, dataDir }) {
  const { owner, repo: name } = await resolveRepo(cwd, repo);
  const repoLabel = owner + "/" + name;

  // 本地快进只能快进到本 clone 的 origin：显式指定了另一个仓库（例如 fork）时，
  // fetch origin 取到的是上游，跟这次提交无关。只有能明确解析出 origin 且与目标不同
  // 才判定为「另一个仓库」；解析不出（自定义 remote helper）就照常尝试。
  let sameAsOrigin = true;
  try {
    const o = await resolveRepo(cwd, undefined);
    if (o && o.owner && o.name) {
      sameAsOrigin = String(o.owner + "/" + o.name).toLowerCase() === repoLabel.toLowerCase();
    }
  } catch {
    sameAsOrigin = true;
  }

  const headR = await runCli("git", ["rev-parse", "HEAD"], { cwd });
  if (!headR.ok) {
    throw new Error("an API commit needs an existing HEAD commit (the repository has no commits yet): create the first commit locally and push it.");
  }
  const headSha = headR.stdout.trim();

  let targetBranch = String(branch || "").trim();
  if (!targetBranch) {
    const b = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    targetBranch = b.ok ? b.stdout.trim() : "";
  }
  if (!targetBranch || targetBranch === "HEAD") {
    throw new Error("the current checkout is detached; pass branch explicitly for an API commit.");
  }

  const tokenInfo = await getInstallationToken({ dataDir, owner, repo: name });
  const token = tokenInfo.token;
  const apiBase = "https://api.github.com/repos/" + owner + "/" + name;
  const branchPath = targetBranch.split("/").map(encodeURIComponent).join("/");

  // 远端 tip 必须等于本地 HEAD：否则这次 API 提交会把远端历史改成基于旧 tip 的分叉。
  const refReply = await callRest(
    [{ method: "GET", url: apiBase + "/git/ref/heads/" + branchPath }],
    { token },
  );
  let ref;
  try {
    ref = firstResult(refReply, "reading the remote branch");
  } catch (e) {
    if (e.status === 404) {
      throw new Error(
        "branch " + targetBranch + " does not exist on " + repoLabel + ": push the local branch first, then retry the API commit.",
      );
    }
    throw e;
  }
  const remoteSha = ref.json && ref.json.object && ref.json.object.sha ? String(ref.json.object.sha) : "";
  if (remoteSha !== headSha) {
    throw new Error(
      "local HEAD (" + headSha.slice(0, 7) + ") is not at the remote tip of " + targetBranch + " (" + (remoteSha || "?") + "): " +
        "push or pull first. An API commit is built on the remote tip, so a mismatch would fork the branch.",
    );
  }

  // paths 模式先入 index：内容从 index 取（见 readStagedFile），不读文件系统。
  if (paths.length) {
    const addR = await runCli("git", ["add", "--", ...paths.map(literalPath)], { cwd });
    if (!addR.ok) {
      throw new Error("staging the given paths failed (git add):\n" + ((addR.stderr || "") + "\n" + (addR.stdout || "")).trim());
    }
  }

  const changes = await collectChanges(cwd, paths);
  if (changes.length === 0) {
    throw new Error("nothing to commit: no staged files and no changes under the given paths.");
  }

  // staged 模式要求 index 与工作树一致：本模块读的是工作区内容，部分暂存会让提交内容和 index 不同。
  if (paths.length === 0) {
    for (const c of changes) {
      if (c.status === "D") continue;
      const dirty = await runCli("git", ["diff", "--name-only", "-z", "--", rootPath(c.path)], { cwd });
      if (dirty.ok && String(dirty.stdout || "").trim() !== "") {
        throw new Error(
          "the staged content of " + c.path + " differs from the working tree. " +
            "Run git add on it (or commit locally) so the API commit can take the exact content you reviewed.",
        );
      }
    }
  }

  // 1) 上传 blob（删除项不需要内容）
  const uploadable = [];
  for (const c of changes) {
    if (c.status === "D") continue;
    const file = await readStagedFile(cwd, c.path);
    if (!file) {
      throw new Error("cannot read " + c.path + " from the index (deleted after the change set was computed?).");
    }
    uploadable.push({ path: c.path, ...file });
  }

  const blobShas = new Map();
  if (uploadable.length > 0) {
    const blobReply = await callRest(
      uploadable.map((f, i) => ({
        id: i,
        method: "POST",
        url: apiBase + "/git/blobs",
        json: { content: f.content.toString("base64"), encoding: "base64" },
      })),
      { token },
    );
    if (!blobReply.ok) throw new Error("uploading blobs failed: " + (blobReply.message || ""));
    for (const r of blobReply.results) {
      if (!r.ok) {
        const detail = r.json && r.json.message ? String(r.json.message) : String(r.text || "").slice(0, 300);
        throw new Error("uploading blob for " + (uploadable[r.id] ? uploadable[r.id].path : "?") + " failed (HTTP " + r.status + "): " + detail);
      }
      blobShas.set(uploadable[r.id].path, r.json.sha);
    }
  }

  // 2) 父提交的 tree
  const parentReply = await callRest(
    [{ method: "GET", url: apiBase + "/git/commits/" + encodeURIComponent(headSha) }],
    { token },
  );
  const parent = firstResult(parentReply, "reading the parent commit");
  const baseTree = parent.json && parent.json.tree && parent.json.tree.sha ? String(parent.json.tree.sha) : "";
  if (!baseTree) throw new Error("GitHub did not return the parent tree for " + headSha.slice(0, 7) + ".");

  const entries = changes.map((c) => {
    if (c.status === "D") return { path: c.path, mode: "100644", type: "blob", sha: null };
    const f = uploadable.find((x) => x.path === c.path);
    return { path: c.path, mode: f ? f.mode : "100644", type: "blob", sha: blobShas.get(c.path) };
  });

  const treeReply = await callRest(
    [{ method: "POST", url: apiBase + "/git/trees", json: { base_tree: baseTree, tree: entries } }],
    { token },
  );
  const tree = firstResult(treeReply, "creating the tree");
  const treeSha = tree.json && tree.json.sha ? String(tree.json.sha) : "";
  if (!treeSha) throw new Error("GitHub did not return a tree sha.");

  // 3) 提交对象：不传 author / committer / signature，GitHub 用 App bot 身份并代签。
  const commitReply = await callRest(
    [{
      method: "POST",
      url: apiBase + "/git/commits",
      json: { message, tree: treeSha, parents: [headSha] },
    }],
    { token },
  );
  const commit = firstResult(commitReply, "creating the commit");
  const newSha = commit.json && commit.json.sha ? String(commit.json.sha) : "";
  if (!newSha) throw new Error("GitHub did not return the new commit sha.");

  // 4) 快进远端分支
  const updateReply = await callRest(
    [{
      method: "PATCH",
      url: apiBase + "/git/refs/heads/" + branchPath,
      json: { sha: newSha, force: false },
    }],
    { token },
  );
  try {
    firstResult(updateReply, "updating the remote branch");
  } catch (e) {
    throw new Error(
      e.message +
        "\nThe commit object " + newSha + " exists but the branch was not moved (it may have advanced concurrently). Re-run after fetching.",
    );
  }

  // 5) 本地快进到新提交；内容与工作树一致，正常不会碰工作区文件。
  let synced = false;
  let syncNote = null;
  if (!sameAsOrigin) {
    syncNote =
      "the commit went to " +
      repoLabel +
      ", which is not this clone's origin, so the local branch was not fast-forwarded.";
  } else {
    const fetchR = await runCli("git", ["fetch", "origin", targetBranch], { cwd, timeoutSec: 120 });
    if (fetchR.ok) {
      const mergeR = await runCli("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd });
      synced = mergeR.ok;
    }
  }

  // 6) 读回验证状态（Verified 是这条路的目的，必须确认而不是假定）。
  // REST 的 GET /commits/{sha} 对 bot 提交不返回 verification；GraphQL 的 Commit.signature
  // 才是稳定来源（即使提交尚未被分支引用也能查）。
  let verified = null;
  try {
    const gqlReply = await callRest(
      [{
        method: "POST",
        url: "https://api.github.com/graphql",
        json: {
          query:
            "query($owner:String!,$name:String!,$oid:GitObjectID!){ repository(owner:$owner,name:$name){ object(oid:$oid){ ... on Commit { signature { isValid state } } } } }",
          variables: { owner, name, oid: newSha },
        },
      }],
      { token },
    );
    const g = gqlReply.results && gqlReply.results[0];
    const sig = g && g.ok && g.json && g.json.data && g.json.data.repository && g.json.data.repository.object
      ? g.json.data.repository.object.signature
      : null;
    if (sig && typeof sig.isValid === "boolean") verified = sig.isValid;
  } catch {
    /* 读不回验证状态不影响提交本身 */
  }

  return {
    hash: newSha,
    branch: targetBranch,
    owner,
    repo: name,
    files: changes.map((c) => (c.status === "D" ? "- " + c.path : c.path)),
    verified,
    synced,
    syncNote,
  };
}
