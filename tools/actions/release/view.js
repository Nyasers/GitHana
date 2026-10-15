// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/view：看一个发布（githana_release 动词）。
 *
 * 定位逻辑（releaseId → tag → 最近一次发布）在 tools/lib/release.js 的 locateRelease；
 * 这里只做渲染：状态位、说明正文（截断）、资产清单、URL。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext, fmtTime } from "../../lib/gh.js";
import { locateRelease, releaseFlags, assetLine, formatSize } from "../../lib/release.js";

export const command = "view";
export const summary = "看一个发布（含资产清单）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTagOptional,
  releaseId: z.number().int().min(1).optional().describe("可选：按数字 id 定位（与 tag 二选一；两个都给时 releaseId 优先）"),
  timeoutSec: params.timeoutSec,
};

/** 说明正文的展示上限（字符）：超过只截断展示，不改变已取到的数据。 */
const BODY_MAX = 4000;

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repoLabel } = c;

  const located = await locateRelease(input, c, label);
  if (located.error) return located.error;
  const rel = located.release;

  const flags = releaseFlags(rel);
  const out = [];
  out.push("发布：" + (rel.tag_name || "?") + (rel.name && rel.name !== rel.tag_name ? "（" + rel.name + "）" : ""));
  out.push(
    "仓库：" + repoLabel +
    " · 状态：" + (rel.draft ? "草稿 draft" : "已发布") +
    (rel.prerelease ? " · 预发布 prerelease" : "") +
    (rel.latest === true ? " · latest" : "") +
    (rel.id !== undefined ? " · id " + rel.id : ""),
  );
  if (flags.length === 0) out.push("状态位：无（非草稿、非预发布、非 latest）");
  if (rel.target_commitish) out.push("目标：" + rel.target_commitish);
  if (rel.author && rel.author.login) out.push("作者：@" + rel.author.login);
  if (rel.created_at) out.push("创建于：" + fmtTime(rel.created_at) + (rel.published_at ? " · 发布于 " + fmtTime(rel.published_at) : "（尚未发布）"));
  if (rel.html_url) out.push("URL：" + rel.html_url);

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const total = assets.reduce((sum, a) => sum + (Number(a && a.size) || 0), 0);
  out.push("");
  out.push("—— 资产（" + assets.length + " 个 · 合计 " + formatSize(total) + "）——");
  if (assets.length === 0) out.push("  （没有资产）");
  else for (const a of assets) out.push(assetLine(a));

  const body = rel.body !== null && rel.body !== undefined ? String(rel.body) : "";
  out.push("");
  out.push("—— 说明" + (body.length > BODY_MAX ? "（截断，共 " + body.length + " 字符）" : "") + " ——");
  out.push(body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body) : "（无说明）");
  return out.join("\n");
}
