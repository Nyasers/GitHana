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
  "GitHana GitHub REST / GraphQL 端点透传（逃生门）：api.github.com 之后的任意 path。",
  "method=GET / POST / PATCH / PUT / DELETE（缺省 GET）；repo 传了就替换 path 里的 {owner}/{repo} 占位符。",
  "越出 App 权限面的端点会被 GitHub 直接拒（403）。二进制的进出走类型化动词：资产上传用",
  "githana_release(action=\"upload\")、下载用 release / run 的 download；本逃生门只收 JSON / 文本载荷。",
  "类型化能力在 githana_repo / githana_pr / githana_issue / githana_release / githana_run /",
  "githana_workflow / githana_cache / githana_label，本地 git 在 githana_git。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  description:
    "向 api.github.com 发任意请求：GET 只读，POST / PATCH / PUT / DELETE 会修改 GitHub 远端状态，执行前请确认 path、method 与 body",
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
