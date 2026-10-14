// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/upload：把本地文件作为发布资产上传。
 *
 * ## 本期未实现——网络那一半的通道不存在
 *
 * 三条硬限制写在 tools/lib/transfer.js 的头注里，这里只摘要：载荷是 JSON 报文（不是
 * multipart）、`uploads.github.com` 不在 worker 的出站白名单、响应体按 UTF-8 有界读取。
 * 三者各自都足以挡住二进制上传，所以本动词**在入口就停**：连本地文件的 sha256 都不去算——
 * 算了也没有下一跳可交付（不会自己抡一套新上传通道，那要改 worker 的协议与白名单）。
 *
 * ## 为什么仍然入 enum（而不是像 edit / watch 那样只在保留位里）
 *
 * `createSurface` 的 `reserved` 只吃「不在 action 表里」的值（见 surface.js 的 execute：
 * 先查 byCommand，查不到才查 reserved）。所以两种留位形态各有用处：
 *   · 保留位（**入 enum**）：这个动词有真实的参数形态、只是本期跑不通时，让它出现在模型的
 *     `action` 候选里、调用时给出**具体**限制与替代路径。upload / download / verify /
 *     verify-asset / run download 走这一档。
 *   · 不入 enum（**只留 reserved 文案**）：连参数形态都还没定的能力空洞（`release edit` 的
 *     三状态位、`run watch` 的任务句柄）走那一档——它们属于阶段 2 的功能，现在进候选只是噪声。
 *
 * 这一档的收益是「受限原因可见」：调用方在候选里看到 upload，调一次就拿到三条限制与替代做法，
 * 而不是以为工具面根本没有上传这回事。
 *
 * ## 参数表描述的是**这个动词的形态**（= REST 上传端点收的那些），本期只用于校验
 *
 * `file` / `assetName` / `contentType` / `assetLabel` 都不是凭空来的：它们一一对应
 * `POST https://uploads.github.com/.../assets?name=<资产名>` 的路径参数与请求体字段（gh 的
 * `release upload` 也收这几个）。本期没有任何一个会被读进请求——因为根本没有那一跳——
 * 所以回报里也只用 `file` 与 `tag` 报「本来要上传什么」。留着的用处是让 stage 2 补通道时
 * 不必再定一遍形态，也让调用方现在就看得见这个动词长什么样。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { binaryUnavailableText } from "../../lib/transfer.js";

export const command = "upload";
export const summary = "上传发布资产（本期未实现：二进制通道不存在）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  file: z.string().describe("本地文件绝对路径（要上传的资产）"),
  assetName: z.string().optional().describe("可选：上传后的资产名（缺省取文件名）"),
  contentType: z.string().optional().describe("可选：Content-Type（缺省由 GitHub 判）"),
  // 叫 assetLabel 而不是 label：后者在本工具里已经是**路由层的报错前缀**（surface.js 拼的
  // "githana_release(upload)"，经 run() 的第三个参数进来），同一个词指两件事会让读的人先愣一下。
  // 它对应 gh 的 `--label` 与 REST 资产载荷里的 `label` 字段。
  assetLabel: z.string().optional().describe("可选：资产的展示标签（对应 gh 的 --label / REST 载荷的 label）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "上传发布资产到 GitHub 远端（新建一个资产对象）：修改 GitHub 远端状态，执行前请确认 repo、tag 与本地文件",
  ruleId: "github-toolkit-release-upload",
};

/** 资产上传端点是 uploads.github.com，不是 api.github.com——这一句是「该往哪补」的落点。 */
const UPLOAD_ENDPOINT_NOTE =
  "资产上传的正确端点是 POST https://uploads.github.com/repos/{owner}/{repo}/releases/{release_id}/assets?name=<资产名>" +
  "（不是 api.github.com；token 与 api 同一枚）。";

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel } = c;

  const file = input?.file !== undefined && input?.file !== null ? String(input.file).trim() : "";
  if (!file) return label + " 参数错误：file 必填（本地文件的绝对路径）。";

  return [
    label + " 未实现（本期不执行上传）：" + repoLabel + " · tag " + (input.tag || "?") + " · 本地文件 " + file,
    "原因：本 App 的 HTTP 通道只有 JSON 报文，二进制上传走不通。三条硬限制：",
    binaryUnavailableText(),
    UPLOAD_ENDPOINT_NOTE,
    "本期可行的替代做法：",
    "  · 用 gh CLI 上传：gh release upload <tag> <file> --repo " + repoLabel + "（外部二进制，不受上述限制）；",
    "  · 或在 GitHub 网页上把文件拖到该 release 的 Assets 区。",
    "githana_api 不是逃生门：它走同一条 worker、同一份主机白名单，POST 到 uploads.github.com 会在起请求前被拒。",
    "补这条通道要动 rest.worker.mjs 的协议（二进制载荷）与白名单（uploads.github.com），不在本批范围。",
  ].join("\n");
}
