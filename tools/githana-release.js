// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * githana_release — GitHub 发布工具（gh `release` 组的对应物）。
 *
 * 动词表取自 spec gh-cli-parity D2 的 `githana_release` 行（gh 手册原文）：create · list ·
 * view · edit · delete · upload · download · delete-asset · verify · verify-asset（**10 个**）。
 * 支撑权限 `contents: write`（D7 已授权的那一条；release 全组都靠它）。
 *
 * ## `edit` 只改状态位（AC7）
 *
 * `edit` 改的是 `draft` / `prerelease` / `latest` 三个状态位，走 REST
 * `PATCH /repos/{o}/{r}/releases/{id}`。`latest` 取三值 `true|false|legacy`（REST 的
 * `make_latest`）——`legacy` 不是「取消 latest」，它是「用旧式算法决定哪个 release 是 latest」
 * （见 tools/lib/release.js 的 MAKE_LATEST_VALUES）。标题 / 正文 / 移动 tag 不属这个动词。
 *
 * ## 两个动词进 enum，但「字节进出」那一半做不到
 *
 * `upload` / `download` 的参数形态是清楚的，跑不通的是**网络那一半**（二进制通道不存在，三条
 * 硬限制见 tools/lib/transfer.js）：载荷是 JSON 报文（不是 multipart）、`uploads.github.com`
 * 不在 worker 的出站白名单、响应体按 UTF-8 有界读取。两者进 action 表、进候选，调用时给出
 * **具体**的限制与替代路径，而不是让调用方以为工具面根本没有这回事。
 *
 * `verify` / `verify-asset` **不受这条限制**（它们只算摘要，不搬字节），但口径与 gh 的同名命令
 * 不同：做的是**发布自身的完整性**核对（GitHub 记录的 `digest` 与本地文件的 sha256），
 * 而「来源证明（attestation）」校验做不到——缺 `attestations` 权限，且 sigstore 验签与
 * 「服务端零 npm 依赖」冲突。这一层差别在回执里明说。
 *
 * 权限：external_side_effect——create / edit / delete / delete-asset / upload 都会改远端状态，
 * 整体按写面声明，只读的 list / view / download / verify / verify-asset 因此也要过审。
 *
 * 路由与边界（缺少 action / 未知 action / 走错名词）在 tools/lib/surface.js。
 */
import { z } from "zod";
import * as create from "./actions/release/create.js";
import * as list from "./actions/release/list.js";
import * as view from "./actions/release/view.js";
import * as edit from "./actions/release/edit.js";
import * as del from "./actions/release/delete.js";
import * as upload from "./actions/release/upload.js";
import * as download from "./actions/release/download.js";
import * as deleteAsset from "./actions/release/delete-asset.js";
import * as verify from "./actions/release/verify.js";
import * as verifyAsset from "./actions/release/verify-asset.js";
import { createSurface, sideEffectDescriber } from "./lib/surface.js";
import { otherVerbs } from "./lib/verbs.js";

export const name = "githana_release";

export const description = [
  "GitHana GitHub 发布：查 / 建 / 删 release 与它的资产。",
  "action=create / list / view / edit / delete / upload / download / delete-asset / verify / verify-asset。",
  "upload 与 download 本期做不到（二进制通道不存在，回执里给限制与替代做法）；",
  "verify / verify-asset 做的是发布自身的摘要核对，不做来源证明；",
  "edit 只改状态位（draft / prerelease / latest），改标题与正文走 githana_api。",
  "仓库在 githana_repo，PR 在 githana_pr，issue 在 githana_issue，标签在 githana_label，",
  "CI 在 githana_run / githana_workflow / githana_cache，本地 git 在 githana_git，其余端点走 githana_api。",
  "参数、示例与边界见随包手册 skills/githana/SKILL.md。",
].join(" ");

/** action 表：顺序即 action 字段的 enum 顺序（与 D2 的动词顺序一致）。 */
const ACTIONS = [
  { module: create },
  { module: list },
  { module: view },
  { module: edit },
  { module: del },
  { module: upload },
  { module: download },
  { module: deleteAsset },
  { module: verify },
  { module: verifyAsset },
];

/**
 * 缺 action / 未知 action 时的兜底摘要（覆盖整面，偏保守）。
 */
const FALLBACK_SIDE_EFFECT = {
  kind: "external_side_effect",
  summary:
    "GitHana 发布动作（create / list / view / edit / delete / upload / download / delete-asset / verify / verify-asset）：create 会新建发布与 tag，edit 会改状态位（非草稿 = 发布出去），delete 会删掉发布与它的资产（不可撤销），执行前请确认 action 与参数",
  ruleId: "github-toolkit-githana-release",
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: sideEffectDescriber(ACTIONS, FALLBACK_SIDE_EFFECT),
};

/**
 * 面级的模型面专属字段：**只改模型面那份摘要的措辞**，运行期校验仍用各 action 自己的 schema。
 *
 * 模型面的平表是各 action 字段的并集，同键**取先出现的那份**（surface.js）。这三个键在各 action
 * 上的要求不同，沿用先出现那份会让摘要对另一半场景撒谎：
 *   · `tag`——create / delete / upload / download / delete-asset / verify / verify-asset 上**必填**
 *     （要操作哪个发布），view 上可缺省（缺省 = 最近一次发布的）；edit 上也可缺省，但只在给了
 *     `releaseId` 时才允许都不给（见 actions/release/edit.js 的校验）。平表先出现的是 create 那份。
 *   · `assetName`——delete-asset / verify-asset 上**必填**（要删 / 要核对哪一个），download 与
 *     upload 上可缺省（download 缺省 = 该 release 的全部资产；upload 缺省 = 取文件名）。
 *   · `file`——upload 上是**要上传的文件**（必填），verify-asset 上是**要比对的本地文件**（可选）；
 *     平表先出现的是 upload 那份。
 * 取值域与必填仍以各 action 的 schema / run() 为准，这里只说清"按 action 取义"。
 */
export const modelFields = {
  tag: z
    .string()
    .optional()
    .describe("release 的 tag（如 v1.2.0）：create / delete / upload / download / delete-asset / verify / verify-asset 上必填，view 上可缺省（缺省 = 最近一次发布的 release），edit 上可缺省（只与 releaseId 二选一）"),
  assetName: z
    .string()
    .optional()
    .describe("资产文件名：delete-asset / verify-asset 上必填（要操作哪一个），download 上可缺省（缺省 = 该 release 的全部资产）"),
  file: z
    .string()
    .optional()
    .describe("本地文件绝对路径，按 action 取义：upload 上是要上传的那个文件（必填），verify-asset 上是要比对的本地副本（可选）"),
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
