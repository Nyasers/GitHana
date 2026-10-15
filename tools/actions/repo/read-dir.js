// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/read-dir：列仓库里某个目录的内容（githana_repo 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/contents/<path>`（支撑权限 `contents: read`）。响应是**目录项
 * 数组**（file / dir / symlink / submodule 各带 size 与 sha）；本动词把它渲染成一列，
 * 顺带报每项类型与体积——这是「远端仓库里现在有什么」的最省 token 问法，不必先克隆。
 *
 * 与 githana_git(action="exec") 的分工：那个读**本地**工作区，这里读**远端**（GitHub 上的那份）。
 * 两者内容常常不同（本地有未推的改动），所以不复用彼此的语义。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { contentsUrl, entryLine, formatBytes } from "../../lib/repo.js";

export const command = "read-dir";
export const summary = "List the contents of a directory in a remote repository";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  path: z.string().optional().describe("Optional: directory path inside the repository (relative to the repository root, e.g. src/lib; default = repository root)"),
  ref: z.string().optional().describe("Optional: branch / tag / commit SHA (defaults to the default branch)"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const path = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  const ref = input?.ref !== undefined && input?.ref !== null ? String(input.ref).trim() : "";
  const shownPath = path.replace(/^\/+/, "").replace(/\/+$/, "");

  const r = await callRest(
    [{ url: contentsUrl(repo, path, ref), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return (
        label + ": the path does not exist or is not visible to the token (" + repoLabel + (shownPath ? " · " + shownPath : " · repository root") + (ref ? " · ref=" + ref : "") + ").\n" +
        "GitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  // contents 端点：目录回数组，文件回对象。收到对象说明 path 指到了文件——直接给引导，不假装成目录。
  if (!Array.isArray(res.json)) {
    const obj = res.json && typeof res.json === "object" ? res.json : {};
    return (
      label + ": path points at a **file**, not a directory (" + (obj.name || shownPath) + ").\n" +
      "To see its content use githana_repo(action=\"read-file\", path=\"" + (obj.path || shownPath) + "\"" + (ref ? ", ref=\"" + ref + "\"" : "") + ")."
    );
  }

  const items = res.json;
  const head = label + " (" + repoLabel + " · " + (shownPath || "repository root") + (ref ? " · ref=" + ref : "") + " · " + items.length + " items):";
  if (items.length === 0) return head + "\n(this directory is empty.)";

  const out = [head];
  const dirs = items.filter((x) => x && x.type === "dir");
  const files = items.filter((x) => x && x.type !== "dir");
  // 目录在前、文件在后：目录是「往下走」的选项，先给它们。
  for (const it of [...dirs, ...files]) out.push(entryLine(it));

  let total = 0;
  for (const it of files) if (it && it.type === "file" && Number.isFinite(Number(it.size))) total += Number(it.size);
  out.push("files at this level total: " + formatBytes(total) + " (" + files.length + " files · " + dirs.length + " subdirectories)");
  return out.join("\n");
}
