// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_api — GitHub REST / GraphQL 逃生门（单动词工具）。
 *
 * `gh api` 的对应物（gh 自己也留着它）：类型化动词覆盖不到的长尾能力从这里走。它是**单动词**
 * 工具，所以按 spec gh-cli-parity D3 / D4 不声明 `action`——单数时 `action` 只是占位（填了等于
 * 没填），删掉；`required` 随之换成真正必填的 `path`（收敛前 `path` 只在 run() 里校验，模型面
 * 看不见它必填）。装配走 tools/lib/surface.js 的 createSingleSurface，不经 dispatch。
 *
 * 权限：external_side_effect——它收全量 HTTP 方法（GET / POST / PATCH / PUT / DELETE），
 * 其中写方法会改 GitHub 远端状态，整体只能按写面声明。只读的长尾查询也因此要过审：这是单动词
 * 逃生门的代价，读专用路径是各名词工具里的只读动词（repo 的 list / view / read-dir / read-file、
 * pr 的 view / status / diff / checks、issue 的 list / view / status）——它们属于各自的写面工具，
 * 无法单独免审。
 *
 * 越过 App 权限面的调用由 GitHub 直接拒（403）——手册的「能力边界」一节点明这件事。
 */
import * as api from "./actions/api.js";
import { createSingleSurface } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_api";

export const description = [
  "GitHana GitHub REST / GraphQL endpoint passthrough (escape hatch): any path after api.github.com.",
  "method=GET / POST / PATCH / PUT / DELETE (GET by default); passing repo substitutes the {owner}/{repo} placeholders in path.",
  "Endpoints beyond the App's permission surface are rejected directly by GitHub (403). Binary in/out goes through the typed verbs: for asset upload use",
  "githana_release(action=\"upload\"), for downloads use release / run's download; this escape hatch only accepts JSON / text payloads.",
  "Typed capabilities live in githana_repo / githana_pr / githana_issue / githana_release / githana_run /",
  "githana_workflow / githana_cache / githana_label, and local git in githana_git.",
  "Parameters, examples and boundaries are in the bundled manual skills/githana/SKILL.md.",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  description:
    "send an arbitrary request to api.github.com: GET is read-only, POST / PATCH / PUT / DELETE modify remote GitHub state — confirm path, method and body before executing",
};

/** 其它名词工具的动词表：走错工具时报错指名正确的那一个（见 surface.js 的 misroutedMessage）。 */
const OTHER_VERBS = otherVerbs(name);

const surface = createSingleSurface({
  name,
  description,
  permission: sessionPermission,
  module: api,
  // 真正必填的是 path（见 actions/api.js 的 run() 与 AC2）。
  required: ["path"],
  verbs: OTHER_VERBS,
});

export const parameters = surface.parameters;
export const execute = surface.execute;
