// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/create：新建标签（githana_label 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/labels`（支撑权限 `issues: write`）。颜色是 GitHub 的六位
 * 十六进制（不带 #）；不给就用中性灰 `ededed`，**不随机**——随机色会让同一个动作每次产出
 * 不同的结果，对"重跑一次"是噪声（见 lib/label.js）。
 *
 * 同名标签已存在时 GitHub 报 422，本动词如实回报并指向 edit（改颜色 / 描述比"删了重建"更对，
 * 后者会把已打上该标签的 issue 短暂地变成无标签）。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { DEFAULT_LABEL_COLOR } from "../../lib/label.js";

export const command = "create";
export const summary = "新建标签";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("标签名（必填；同名标签已存在会返回 422）"),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .optional()
    .describe("可选：六位十六进制颜色，可带前导 #（如 d73a4a）；缺省用中性灰 " + DEFAULT_LABEL_COLOR),
  description: z.string().optional().describe("可选：标签描述（会显示在 issue 页面上悬停处）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "在 GitHub 远端仓库新建一个标签（会出现在该仓库所有 issue / PR 的标签候选里）：修改 GitHub 远端状态，执行前请确认 repo 与标签名",
  ruleId: "github-toolkit-label-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " 参数错误：name 必填（标签名不能为空）。";

  // 颜色的"六位十六进制"由 schema 的 regex 保证；这里只做归一与缺省。
  const given = input?.color !== undefined && input?.color !== null ? String(input.color).trim() : "";
  const color = given === "" ? DEFAULT_LABEL_COLOR : given.replace(/^#/, "").toLowerCase();

  const body = { name, color };
  if (input?.description !== undefined && input?.description !== null) body.description = String(input.description);

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/labels"), json: body, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次创建（422）。最常见的原因是**同名标签已存在**——\n" +
        "改它的颜色 / 描述请用 githana_label(action=\"edit\", name=\"" + name + "\")，\n" +
        "确要重建才用 githana_label(action=\"delete\")（注意：删掉会让已打该标签的 issue 短暂变成无标签）。\n" +
        "GitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const created = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已创建（" + repoLabel + "）：",
    "标签：" + name + " · 颜色 #" + (created.color || color) + (given === "" ? "（缺省中性灰）" : ""),
  ];
  if (created.description) out.push("描述：" + created.description);
  if (created.url) out.push("API：" + created.url);
  return out.join("\n");
}
