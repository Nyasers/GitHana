// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_repo — GitHub 仓库工具（gh `repo` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_repo` 行（gh 手册原文）：create · list · view ·
 * clone · fork · sync · gitignore · license · read-dir · read-file。支撑权限
 * `repository_creation`（create，只建不改）+ `metadata` + `contents`，都在 D7 的已授权集里。
 *
 * ## 那 8 个动词为什么不在定义里（本批最要紧的一条）
 *
 * gh `repo` 组的 edit / delete / rename / archive / unarchive / set-default / autolink /
 * deploy-key 都靠 `administration`，而该权限**未授权**（D7）。它们**从 zod 定义里删除**：
 * zod 是模型面 `action` 候选与运行期校验的同一来源，删掉即两边同时消失——模型的候选里根本
 * 没有这些值，不可能去调，比"声明了但调用时报 403"少一次注定失败的调用（AC3）。
 * 「要补哪个权限」登记在随包手册 skills/githana/SKILL.md 的权限缺口一节（AC3b）。
 *
 * ## 两个动词不是 REST 端点
 *
 * `clone` 与 `sync` 是**本地 git 语义**，没有对应的 REST 端点（`GET /tarball` 给的是归档，
 * 没有 .git）。两者都走 tools/lib/exec.js 的 git 子进程：clone 跑 `git clone`，
 * sync 先问 GitHub 上游是谁（`parent` 字段，权威）再在本机 fetch + 合并。理由写在各自文件的
 * 头注里。
 *
 * 权限：external_side_effect——create / fork / clone / sync 都会改状态（远端或本地磁盘），
 * 整体只能按写面声明，只读的 list / view / read-dir / read-file 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as create from "./actions/repo/create.js";
import * as list from "./actions/repo/list.js";
import * as view from "./actions/repo/view.js";
import * as clone from "./actions/repo/clone.js";
import * as fork from "./actions/repo/fork.js";
import * as sync from "./actions/repo/sync.js";
import * as gitignore from "./actions/repo/gitignore.js";
import * as license from "./actions/repo/license.js";
import * as readDir from "./actions/repo/read-dir.js";
import * as readFile from "./actions/repo/read-file.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_repo";

export const description = [
  "GitHana GitHub repositories: query, create, fork, and read remote content.",
  "action=create / list / view / clone / fork / sync / gitignore / license / read-dir / read-file.",
  "clone and sync are local git semantics (they run git clone / fetch+merge), the rest go through REST;",
  "PRs are in githana_pr, issues in githana_issue, releases in githana_release, CI in githana_run / githana_workflow / githana_cache,",
  "labels in githana_label, local git in githana_git, and other endpoints go through githana_api.",
  "Editing or deleting repositories (EDIT / DELETE / rename / archive etc.) needs the administration permission, which this App is not granted, so it is not offered.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: create },
  { module: list },
  { module: view },
  { module: clone },
  { module: fork },
  { module: sync },
  { module: gitignore },
  { module: license },
  { module: readDir },
  { module: readFile },
];

/** 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana repository actions (create / list / view / clone / fork / sync / gitignore / license / read-dir / read-file): create and fork create remote repositories, clone and sync write to local disk or change local branches — confirm action and parameters before executing",
  ruleId: "github-toolkit-githana-repo",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * 模型面的平表是各 action 字段的并集，同键**取先出现的那份**（surface.js）。这三个键在各
 * action 上的含义 / 要求不同，沿用先出现那份会让摘要对另一半场景撒谎：
 *   · `repo`——create 没有这个参数（新建的仓库还不存在）；clone 上它**必填且不从 cwd 推断**
 *     （cwd 在那一处是落盘位置）；其余动作上它可选、缺省从 cwd 推断；
 *   · `branch`——clone 是**检出哪个分支**，sync 是**同步哪个分支**；
 *   · `path`——read-dir 是**目录**（也接受缺省 = 仓库根），read-file 是**文件**（必填）。
 * 取值域与必填仍以各 action 的 schema / run() 为准，这里只说清"按 action 取义"。
 */
export const modelFields = {
  repo: z
    .string()
    .optional()
    .describe("repository owner/repo: optional on most actions (omitted = inferred from the cwd's git remote), required on clone and not inferred from cwd, not present on create"),
  branch: z.string().optional().describe("branch, by action: on clone it is the branch to check out, on sync the branch to sync"),
  path: z.string().optional().describe("path inside the repository (relative to the repository root): for read-dir it is a directory (omitted = repository root), for read-file it is a file (required)"),
};

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  verbs: otherVerbs(name),
  modelFields,
});

export const parameters = surface.parameters;
export const execute = surface.execute;
