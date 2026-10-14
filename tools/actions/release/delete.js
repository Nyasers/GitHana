// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/delete：删除发布（githana_release 动词，不可撤销）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/releases/{release_id}`，支撑权限 `contents: write`（D7 已授权）。
 *
 * ## 删发布与删 tag 是两件事
 *
 * `DELETE /releases/{id}` **只删发布对象**（附带它的资产），**tag 还在**——ref 属于 git 对象，
 * 要删它得 `DELETE /repos/{o}/{r}/git/refs/tags/{tag}`。gh 的 `release delete --cleanup-tag`
 * 就是把两步做在一起。本动词不复刻那个开关：删 ref 的影响面比删发布大一档（远端 tag 一旦删掉，
 * 依赖它的 CI / 版本解析当场失效），值得单独一次审批。要删 tag 请用
 * `githana_git(action="exec", args=["push", "origin", ":refs/tags/<tag>"])`——那是一条显式的 git 命令。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { locateRelease, releaseFlags, assetLine, formatSize } from "../../lib/release.js";

export const command = "delete";
export const summary = "删除发布（不可撤销，需 confirm=true；不删 tag）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag.describe("必填：要删的发布 tag（本动词不给「最近一个」的缺省——不可撤销的动作不吃危险默认值）"),
  confirm: z
    .boolean()
    .optional()
    .describe("必须为 true 才真删：删除发布不可撤销（资产一起没），缺它会返回引导"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "**删除** GitHub 远端仓库的发布对象（资产一起消失，tag 保留）：删除不可撤销，执行前请再次确认 repo 与 tag",
  ruleId: "github-toolkit-release-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const tag = input?.tag !== undefined && input?.tag !== null ? String(input.tag).trim() : "";
  if (!tag) return label + " 参数错误：tag 必填（要删哪个发布）。本动词不给缺省——不可撤销的动作不吃危险默认值。";

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const total = assets.reduce((sum, a) => sum + (Number(a && a.size) || 0), 0);

  if (input?.confirm !== true) {
    const out = [
      label + " 需要确认（未执行删除）：",
      "将删除发布：" + (rel.tag_name || tag) + "（" + repoLabel + " · id " + (rel.id !== undefined ? rel.id : "?") + "）",
      "标题：" + (rel.name || "（无标题）") +
        (releaseFlags(rel).length ? " · " + releaseFlags(rel).join(" · ") : ""),
    ];
    if (assets.length) {
      out.push("资产（" + assets.length + " 个 · 合计 " + formatSize(total) + "，会一起消失）：");
      for (const a of assets) out.push(assetLine(a));
    } else {
      out.push("资产：无");
    }
    out.push("删除**不可撤销**：发布对象与它的资产一起没，GitHub 没有回收站。");
    out.push("**tag 不受影响**：本动词只删发布（ref 是 git 对象）。要连 tag 一起删，那是另一件事，用 githana_git(action=\"exec\", args=[\"push\", \"origin\", \":refs/tags/" + tag + "\"])。");
    out.push("确认后请重发同一次调用并带上 confirm=true。");
    return out.join("\n");
  }

  const r = await callRest(
    [
      {
        method: "DELETE",
        url: apiUrl(repo, "/releases/" + encodeURIComponent(String(rel.id))),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " 执行失败：" + describeFailure(res, repoLabel);

  return [
    label + " 已删除（" + repoLabel + "）：",
    "发布：" + (rel.tag_name || tag) + " · id " + (rel.id !== undefined ? rel.id : "?") + " · 标题 " + (rel.name || "（无标题）"),
    "资产：" + (assets.length === 0 ? "无" : assets.length + " 个已随发布一起删除（合计 " + formatSize(total) + "）"),
    "说明：tag " + (rel.tag_name || tag) + " 仍在（本动词只删发布对象）。要重建同名发布用 githana_release(action=\"create\")；要删 tag 用 githana_git(action=\"exec\") 显式推一条删除 ref。",
  ].join("\n");
}
