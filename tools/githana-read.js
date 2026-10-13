// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_read — 只读面工具（不改动本地仓库与 GitHub 远端状态的查询动作）。
 *
 * sessionPermission 为 { readOnly: true }：这些动作在模型循环里**不过审**。收敛前 gh_pr 把
 * list / view 与 create / merge 放在一个工具里，整体只能声明 external_side_effect，读也要过审
 * ——那是现存的真实倒退，本入口把它修回来（见 spec D1）。
 *
 * ## 面的边界（见 spec D7）
 *
 * - **api 进只读面，但只接受 GET / HEAD**：HTTP method 是可靠的读写判据，GET / HEAD 按语义是
 *   安全动词。长尾只读查询（issue 列表、release 列表、仓库元数据）不该每次过审。其它方法当场
 *   拒绝并指向 githana(action="api")。
 * - **exec 不进只读面**：git 子命令白名单挡不住 flag——diff --output=<file> 写文件、config 改
 *   配置、branch -D 删分支，透传层是风险面，过审合理。需要任意只读 git 命令时走 githana。
 * - **status / log 保留在只读面**：它们不是治理层，是翻译层——把 git 输出解析成结构化字段，
 *   给模型省 token。这是唯一价值，但确实是真价值。
 */
import * as status from "./actions/status.js";
import * as log from "./actions/log.js";
import * as prList from "./actions/pr-list.js";
import * as prView from "./actions/pr-view.js";
import * as api from "./actions/api.js";
import { createSurface } from "./lib/surface.js";
import * as params from "./lib/params.js";

export const name = "githana_read";

export const description = [
  "GitHana 只读面：查询本地仓库与 GitHub 远端状态，不改变任何状态（免审）。",
  "action=status（工作区/分支速览）/ log（最近提交速览）/ pr_list（PR 列表）/ pr_view（PR 详情，含 reviews）",
  "/ api（任意 GitHub REST 端点，仅 GET / HEAD）。",
  "写操作（exec / commit / push / pr_create / pr_merge）在 githana。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序。 */
const ACTIONS = [
  { module: status },
  { module: log },
  { module: prList },
  { module: prView },
  // 只读面的 api 只收安全动词；其它方法在 run() 里当场拒绝并指向 githana。
  { module: api, options: { allowMethods: ["GET", "HEAD"], writeFaceName: "githana" } },
];

/** 保留位：本期只在 action 表与手册里留位置，不实现（见 spec D8）。 */
const RESERVED = {
  ci_status: "CI 运行状态查询本期未实现；当前可用 githana_read(action=\"api\") 直接查 GitHub 的 check-runs / workflow-runs 端点。",
};

export const sessionPermission = { readOnly: true };

const surface = createSurface({
  name,
  description,
  permission: sessionPermission,
  actions: ACTIONS,
  reserved: RESERVED,
  other: { name: "githana", commands: ["exec", "commit", "push", "pr_create", "pr_merge", "api", "ci_watch"] },
  sharedFields: {
    cwd: params.cwd,
    repo: params.repo,
    timeoutSec: params.timeoutSec,
    prNumber: params.prNumber,
  },
});

export const parameters = surface.parameters;
export const execute = surface.execute;