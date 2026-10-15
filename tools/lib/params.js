// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/params.js — 跨 action 共用的字段定义（zod）。
 *
 * 被两个以上 action 用到的键在这里定义一次，各 action 只 import，避免同一个键在几处各写一份
 * 后各自漂移。字段的**形状**（类型 / 枚举 / 范围）在这里与各 action 的 schema 里是唯一来源：
 * 工具的 `parameters` 由 `z.toJSONSchema` 从同一份定义生成，运行期校验也用同一份
 * （见 tools/lib/surface.js）。
 *
 * 名词分家后，同一个键在不同工具里有不同含义的情形消失了：`method` 只属于 `githana_api`
 * 的 HTTP 方法，`body` 在 `githana_api` 上是 JSON 对象、在 `githana_pr` 的 create / comment /
 * review 上是 Markdown 正文字符串——两者已不在同一个参数表里，各自的取值域写在各自 action 的
 * schema 上（那才是运行期生效的那份），不必再在这里合并成一份中性描述。
 *
 * 必填与否**不在这里一刀切**：同一个键在不同 action 上要求不同（cwd 对 git 动作必填、对
 * `githana_pr` 的多数动词可选；prNumber 对 merge / revert 必填、对 view 可缺省）。所以同一个键
 * 给出两个变体，名字表明形态，各 action 取自己要的那个——必填这件事写在用它的地方，不靠合并
 * 顺序去猜。
 */
import { z } from "zod";

/** 工作目录（仓库绝对路径）：仓库上下文一律显式传参，不做工作目录隐式推断。 */
export const cwd = z
  .string()
  .describe(
    "absolute path of the local repository (e.g. E:\\workspace\\my-repo). Repository context is always passed explicitly, never inferred implicitly; which verbs require it is documented with each action's parameters",
  );

/** 工作目录：只作兜底的 GitHub 动作可选（不用它取缺省值；见各 action 的 run()）。 */
export const cwdOptional = cwd.optional();

/** 仓库上下文（githana_repo / pr / issue / label 的各动词共用）。 */
export const repo = z
  .string()
  .optional()
  .describe("optional: repository in owner/repo format (e.g. liliMozi/openhanako); when omitted it is inferred from the cwd's git remote");

/** 超时（git 动作默认 120 秒，GitHub 动作默认 60 秒）。 */
export const timeoutSec = z
  .number()
  .int()
  .min(1)
  .max(600)
  .optional()
  .describe("timeout in seconds (optional): 120 by default for git actions, 60 for GitHub actions; maximum 600");

/** PR 编号：正整数（merge / revert 等不可撤销的动词必填）。 */
export const prNumber = z.number().int().min(1).describe("PR number (positive integer)");

/** PR 编号：可缺省 = 当前分支关联 PR（需要 cwd）。 */
export const prNumberOptional = prNumber
  .optional()
  .describe("PR number (positive integer); when omitted = the PR associated with the current branch (needs cwd)");

/**
 * issue 编号：正整数，**必填**。
 *
 * 与 prNumber 不同，issue 没有「当前分支关联 issue」这回事——那个概念只对 PR 成立。所以这里
 * 只有必填一个变体：`prNumberOptional` 的缺省逻辑（按 head 分支过滤）在 issue 上无对应物，
 * 照搬会造出一个语义不成立的参数。
 */
export const issueNumber = z.number().int().min(1).describe("issue number (positive integer)");

/**
 * release 的 tag：定位 release 的主键（`GET /releases/tags/{tag}`）。
 *
 * `GET /releases/{id}` 与 `GET /releases/tags/{tag}` 返回同一形状，所以也有 `releaseId` 那条路
 * （在各 action 的 schema 上单独声明）；但 tag 才是人手上的那个键，报错文案统一指向它。
 *
 * 两个变体与 cwd 同理，必填与否按动词不同：只有 view 允许缺省（缺省 = 最近一次发布的 release）；
 * create / delete / upload / download / delete-asset / verify / verify-asset 都要求点名一个——
 * 「最近一个」在删改类的动作上是个危险的默认值。
 */
export const releaseTag = z.string().describe("release tag (e.g. v1.2.0)");

/** release 的 tag：可缺省 = 最近一次发布的 release（latest 只算非草稿、非预发布的）。 */
export const releaseTagOptional = releaseTag
  .optional()
  .describe("release tag (e.g. v1.2.0); when omitted = the most recently published release (latest counts only non-draft, non-prerelease ones)");

/** release 资产名：release 内唯一定位一个资产（不额外发请求，release 表示里内嵌了 assets）。 */
export const assetName = z.string().describe("asset file name (uniquely identifies one asset within a release, e.g. app-v1.2.0-win32-x64.zip)");

/** release 资产名：可缺省 = 该 release 的全部资产（download 用；其余动词必须点名）。 */
export const assetNameOptional = assetName
  .optional()
  .describe("asset file name; when omitted = every asset of that release");

/**
 * Actions 工作流定位：数字 ID 或文件名，**必填**（只有 list 不需要它——那是列全部工作流）。
 *
 * GitHub 的 `/actions/workflows/{workflow_id}` 两种都收（文档：You can also pass the workflow
 * file name as a string），所以这里不做「先列表再匹配」的翻译——直接把收到的值放进路径。
 * 路径**逐段编码**（见 tools/lib/ci.js 的 workflowPath）：`release.yml` 与 `ci/build.yml`
 * 都合法，整串 encodeURIComponent 会把分隔用的 `/` 也编掉。
 */
export const workflowRef = z
  .string()
  .describe("required: workflow, either a numeric ID (e.g. 161335) or a file name (e.g. ci.yml, ci/build.yml); get it from githana_workflow(action=\"list\")");

/** Actions run 编号：正整数（GitHub 的 run id 远小于 2^53，用 number 表达无精度问题）。 */
export const runId = z.number().int().min(1).describe("run number (positive integer; take it from after the # in githana_run(action=\"list\"))");

/** Actions run 编号：可缺省 = 最近一次 run（可按 branch 过滤，branch 缺省取 cwd 的当前分支）。 */
export const runIdOptional = runId
  .optional()
  .describe("run number; when omitted = the most recent run (can be filtered by branch; branch defaults to the cwd's current branch)");
