// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/edit：改标签的名字 / 颜色 / 描述（githana_label 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/labels/{name}`（支撑权限 `issues: write`）。
 *
 * **改名要显式传 newName**：改名与"改原名下的颜色"是两件事，但端点用同一个 PATCH——
 * 如果只把 `name` 当"新名字"用，那么"我想改 bug 的颜色"就会变成"把 bug 改成别的名字"。
 * 所以这里 `name` 只作**定位**（要改哪个标签），新名字走 `newName`。gh `label edit` 的
 * `<name>` 与 `--name` 是同一个区分。
 *
 * 没给任何要改的字段就返回引导，不发一次注定 422 的请求。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { labelLine } from "../../lib/label.js";

export const command = "edit";
export const summary = "改标签的名字 / 颜色 / 描述";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  name: z.string().describe("要改的**现有**标签名（定位用；改名请同时传 newName）"),
  newName: z.string().optional().describe("可选：新名字（改名时用；不给则名字不变）"),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .optional()
    .describe("可选：新的六位十六进制颜色，可带前导 #（如 0e8a16）"),
  description: z.string().optional().describe("可选：新的描述（传空串即清空描述）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "修改 GitHub 远端仓库标签的名字 / 颜色 / 描述（改名会让所有已打该标签的 issue / PR 一起换名）：会改写该仓库的标签面，执行前请确认 repo、现有名与要改的字段",
  ruleId: "github-toolkit-label-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " 参数错误：name 必填（要改的现有标签名）。";

  const patch = {};
  const changed = [];
  if (input?.newName !== undefined && input?.newName !== null) {
    const v = String(input.newName).trim();
    if (!v) return label + " 参数错误：newName 不能为空串（标签名不允许为空）。";
    patch.new_name = v;
    changed.push("改名 → " + v);
  }
  if (input?.color !== undefined && input?.color !== null) {
    // 六位十六进制由 schema 的 regex 保证；这里只归一成 GitHub 的形态（不带 #、小写）。
    const v = String(input.color).trim().replace(/^#/, "").toLowerCase();
    patch.color = v;
    changed.push("颜色 → #" + v);
  }
  if (input?.description !== undefined && input?.description !== null) {
    // 描述允许空串——那是"清空描述"，是明确意图。
    patch.description = String(input.description);
    changed.push("描述 → " + (String(input.description) === "" ? "（清空）" : String(input.description)));
  }

  if (changed.length === 0) {
    return (
      label + " 参数错误：至少要给一个要改的字段（newName / color / description）。\n" +
      "只传 name 只是定位到那个标签，本身不构成一次改动（GitHub 会拒空 PATCH）。"
    );
  }

  const r = await callRest(
    [
      {
        method: "PATCH",
        url: apiUrl(repo, "/labels/" + encodeURIComponent(name)),
        json: patch,
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) return label + "：仓库 " + repoLabel + " 里没有名为 " + name + " 的标签。";
    if (res && res.status === 422) {
      return label + " 执行失败：GitHub 拒绝这次修改（422）。常见原因：newName 已被别的标签占用。\nGitHub 原文：" + errorDetail(res);
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const after = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已执行（" + repoLabel + "）：",
    "定位标签：" + name,
    "改动：" + changed.join(" · "),
    "现标签：" + labelLine(after).trim(),
  ];
  if (patch.new_name) out.push("说明：改名会让所有已打该标签的 issue / PR 一起换成新名字。");
  return out.join("\n");
}
