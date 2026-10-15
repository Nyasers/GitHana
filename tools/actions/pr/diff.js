// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * pr/diff：查看 PR 的 diff（githana_pr 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/pulls/{n}` 的 `Accept: application/vnd.github.diff`（打补丁文本）
 * 或 `...vnd.github.patch`（带提交头的补丁）。两条都是同一个 PR 端点的**表示**差异，不是两个
 * 端点：REST 的 JSON 表示给文件与行数统计，diff/patch 表示给可读的补丁文本。
 *
 * 输出有上限：diff 可能几万行，全量塞进上下文会吃掉整个窗口。`maxBytes` 控制截断（缺省 20000
 * 字符），截断时明确说明并给出可按文件取的路子（`githana_api` 加 files 表示）。
 *
 * 只读：不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, resolvePrNumber, describeFailure } from "../../lib/pr.js";

export const command = "diff";
export const summary = "查看 PR 的 diff（补丁文本，可截断）";

/** 缺省截断长度（字符）：够看一轮改动，又不至于把上下文窗口吃掉。 */
const DEFAULT_MAX_BYTES = 20000;

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  prNumber: params.prNumberOptional,
  // 取值域确定（两种补丁表示），写成 enum。
  format: z.enum(["diff", "patch"]).optional().describe("diff（默认，纯补丁）/ patch（带提交头的补丁）"),
  maxBytes: z
    .number()
    .int()
    .min(500)
    .optional()
    .describe("补丁文本的展示上限（字符），默认 20000；超过则截断并说明"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numRes = await resolvePrNumber(input, label, c);
  if (numRes.error) return numRes.error;
  const numStr = numRes.prNumber;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const format = input?.format !== undefined && input?.format !== null ? String(input.format) : "diff";
  const accept = format === "patch" ? "application/vnd.github.patch" : "application/vnd.github.diff";
  const maxBytes =
    input?.maxBytes !== undefined && input?.maxBytes !== null ? Math.max(500, Math.floor(input.maxBytes)) : DEFAULT_MAX_BYTES;

  const r = await callRest(
    [{ url: apiUrl(repo, "/pulls/" + numStr), headers: { Accept: accept }, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：PR #" + numStr + " 不存在或不可见（" + repoLabel + "）。";
    if (res && res.status === 406) {
      return label + "：PR #" + numStr + " 的 diff 过大（GitHub 返回 406）。请改用 githana_api 的 files 表示分文件看。";
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  // diff 表示是**文本**不是 JSON：worker 会把非 JSON 响应放进 text（json 为 null）。
  const text = typeof res.text === "string" ? res.text : "";
  if (text.trim() === "") {
    return label + "：PR #" + numStr + " 没有 diff 内容（可能还没有提交，或已被合并/关闭且无差别）。";
  }

  const truncated = text.length > maxBytes;
  const body = truncated ? text.slice(0, maxBytes) : text;
  const out = [
    label + " PR #" + numStr + " · " + repoLabel + " · format=" + format,
    truncated
      ? "（补丁共 " + text.length + " 字符，已截断到 " + maxBytes + "；要分文件看请用 githana_api 的 files 表示）"
      : "（补丁共 " + text.length + " 字符，未截断）",
    "",
    body,
  ];
  return out.join("\n");
}
