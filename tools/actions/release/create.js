// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/create：新建一个发布（githana_release 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/releases`，支撑权限 `contents: write`（D7 已授权）。
 *
 * ## 两处与 gh 的差别，如实写在输出里
 *
 *   1. **不带资产**：gh 的 `gh release create <tag> <files>...` 会顺手把文件作为资产上传，
 *      而上传通道本期不可用（见 tools/lib/transfer.js 的三条硬限制）。所以本动词只建 release
 *      本体，`upload` 是独立一步——合成一次调用会让「建了但资产没上去」变成半途状态。
 *   2. **`--verify-tag` 不声明**：那个开关是「tag 不存在就拒绝」，判据在 GitHub 侧
 *      （`POST /releases` 对不存在的 tag 本就按 `target_commitish` 建 tag），在本地再判一次
 *      等于把同一条规则实现两遍，且两遍可能不一致。
 *
 * `make_latest` 是三值（true / false / legacy），且**草稿与预发布不能设为 latest**——
 * 这一点由 GitHub 判，原文如实回报（见 lib/release.js 的 makeLatestText / MAKE_LATEST_VALUES）。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { MAKE_LATEST_VALUES, makeLatestText } from "../../lib/release.js";

export const command = "create";
export const summary = "新建发布（tag + 标题 + 说明）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag.describe("必填：发布的 tag 名（如 v1.2.0）；tag 不存在时 GitHub 会按 target 新建"),
  name: z.string().optional().describe("可选：发布标题（缺省取 tag 名）"),
  body: z.string().optional().describe("可选：发布说明（Markdown）"),
  draft: z.boolean().optional().describe("可选：建为草稿（草稿不能设为 latest，也不出现在 /releases/latest）"),
  prerelease: z.boolean().optional().describe("可选：标为预发布（不能设为 latest）"),
  target: z.string().optional().describe("可选：tag 从哪个提交/分支建（缺省取仓库默认分支）"),
  generateNotes: z.boolean().optional().describe("可选：让 GitHub 自动生成发布说明（会覆盖 body）"),
  latest: z.enum(MAKE_LATEST_VALUES).optional().describe("可选：是否设为 latest（true / false / legacy=旧式算法）；缺省由 GitHub 决定"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "在 GitHub 远端仓库新建一个发布（tag 不存在时还会建出该 tag）：修改 GitHub 远端状态，执行前请确认 repo、tag 与 draft / prerelease 状态位",
  ruleId: "github-toolkit-release-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const tag = input?.tag !== undefined && input?.tag !== null ? String(input.tag).trim() : "";
  if (!tag) return label + " 参数错误：tag 必填（发布的 tag 名，如 v1.2.0）。";

  const payload = { tag_name: tag };
  if (input?.name !== undefined && input?.name !== null && String(input.name).trim() !== "") {
    payload.name = String(input.name).trim();
  }
  if (input?.body !== undefined && input?.body !== null) payload.body = String(input.body);
  if (input?.draft === true) payload.draft = true;
  if (input?.prerelease === true) payload.prerelease = true;
  if (input?.target !== undefined && input?.target !== null && String(input.target).trim() !== "") {
    payload.target_commitish = String(input.target).trim();
  }
  if (input?.generateNotes === true) payload.generate_release_notes = true;
  if (input?.latest !== undefined && input?.latest !== null) payload.make_latest = String(input.latest);

  const r = await callRest(
    [{ method: "POST", url: apiUrl(repo, "/releases"), json: payload, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次创建（422）。最常见的原因是**同 tag 的发布已存在**" +
        "（一个 tag 只能有一个发布；要改它用 githana_release(action=\"view\") 看现状）。\n" +
        "GitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const rel = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " 已创建（" + repoLabel + "）：",
    "tag：" + (rel.tag_name || tag),
    "标题：" + (rel.name || "（无标题）"),
    "状态：" + (rel.draft ? "草稿 draft" : "已发布") + (rel.prerelease ? " · 预发布 prerelease" : "") +
      (rel.latest === true ? " · latest" : ""),
  ];
  if (input?.latest !== undefined && input.latest !== null) {
    out.push("make_latest 请求值：" + makeLatestText(input.latest) + "（草稿与预发布不能设为 latest，以 GitHub 的实际结果为准）");
  }
  if (rel.target_commitish) out.push("目标：" + rel.target_commitish);
  if (rel.published_at) out.push("发布于：" + fmtTime(rel.published_at));
  if (rel.html_url) out.push("URL：" + rel.html_url);
  out.push("说明：不带资产。资产上传通道本期不可用（见 githana_release(action=\"upload\") 的回报）。");
  return out.join("\n");
}
