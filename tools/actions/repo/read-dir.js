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
export const summary = "列远端仓库某目录的内容";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  path: z.string().optional().describe("可选：仓库内目录路径（相对仓库根，如 src/lib；缺省 = 仓库根）"),
  ref: z.string().optional().describe("可选：分支 / 标签 / 提交 SHA（缺省取默认分支）"),
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return (
        label + "：路径不存在或令牌不可见（" + repoLabel + (shownPath ? " · " + shownPath : " · 仓库根") + (ref ? " · ref=" + ref : "") + "）。\n" +
        "GitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  // contents 端点：目录回数组，文件回对象。收到对象说明 path 指到了文件——直接给引导，不假装成目录。
  if (!Array.isArray(res.json)) {
    const obj = res.json && typeof res.json === "object" ? res.json : {};
    return (
      label + "：path 指向的是一个**文件**，不是目录（" + (obj.name || shownPath) + "）。\n" +
      "要看它的内容请用 githana_repo(action=\"read-file\", path=\"" + (obj.path || shownPath) + "\"" + (ref ? ", ref=\"" + ref + "\"" : "") + ")。"
    );
  }

  const items = res.json;
  const head = label + "（" + repoLabel + " · " + (shownPath || "仓库根") + (ref ? " · ref=" + ref : "") + " · " + items.length + " 项）：";
  if (items.length === 0) return head + "\n（这个目录是空的。）";

  const out = [head];
  const dirs = items.filter((x) => x && x.type === "dir");
  const files = items.filter((x) => x && x.type !== "dir");
  // 目录在前、文件在后：目录是「往下走」的选项，先给它们。
  for (const it of [...dirs, ...files]) out.push(entryLine(it));

  let total = 0;
  for (const it of files) if (it && it.type === "file" && Number.isFinite(Number(it.size))) total += Number(it.size);
  out.push("本层文件合计：" + formatBytes(total) + "（" + files.length + " 个文件 · " + dirs.length + " 个子目录）");
  return out.join("\n");
}
