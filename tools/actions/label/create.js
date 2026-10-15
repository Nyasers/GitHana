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
export const summary = "Create a label";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("Label name (required; returns 422 if a same-named label already exists)"),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Optional: six-digit hexadecimal color, an optional leading # is allowed (e.g. d73a4a); defaults to the neutral gray " + DEFAULT_LABEL_COLOR),
  description: z.string().optional().describe("Optional: label description (shown when hovering on the issue page)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Create a label in a remote GitHub repository (it appears among the label suggestions for all issues / PRs in that repository): modifies remote GitHub state, confirm repo and label name before running",
  ruleId: "github-toolkit-label-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " argument error: name is required (the label name cannot be empty).";

  // 颜色的"六位十六进制"由 schema 的 regex 保证；这里只做归一与缺省。
  const given = input?.color !== undefined && input?.color !== null ? String(input.color).trim() : "";
  const color = given === "" ? DEFAULT_LABEL_COLOR : given.replace(/^#/, "").toLowerCase();

  const body = { name, color };
  if (input?.description !== undefined && input?.description !== null) body.description = String(input.description);

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/labels"), json: body, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this creation (422). The most common cause is that **a same-named label already exists** —\n" +
        "to change its color / description use githana_label(action=\"edit\", name=\"" + name + "\"),\n" +
        "and only recreate it with githana_label(action=\"delete\") if you really mean to (note: deleting briefly leaves issues carrying that label with no label at all).\n" +
        "GitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const created = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " created (" + repoLabel + "):",
    "label: " + name + " · color #" + (created.color || color) + (given === "" ? " (default neutral gray)" : ""),
  ];
  if (created.description) out.push("description: " + created.description);
  if (created.url) out.push("API: " + created.url);
  return out.join("\n");
}
