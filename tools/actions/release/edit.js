// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/edit：改发布的状态位（githana_release 动词）。
 *
 * 走 REST `PATCH /repos/{o}/{r}/releases/{release_id}`，支撑权限 `contents: write`（D7 已授权）。
 * 能改的是三个状态位（AC7）：
 *
 *   · `draft`——草稿 / 已发布；
 *   · `prerelease`——预发布；
 *   · `latest`——**三值** `true` / `false` / `legacy`（REST 的 `make_latest`）。`legacy` 不是
 *     「取消 latest」：它的原文含义是「用旧式算法决定哪个 release 是 latest」，把它当 `false`
 *     处理就改了语义（见 tools/lib/release.js 的 MAKE_LATEST_VALUES / makeLatestText）。
 *
 * ## 定位：tag 或 releaseId，且**不给缺省**
 *
 * 与 view 不同，本动词不吃「最近一次发布」这个缺省——改状态位的动作不该拿一个危险默认值
 * （同 delete 的口径）。
 *
 * ## 与 gh 的差别：gh 还能改标题与正文，本动词不能
 *
 * `PATCH /releases/{id}` 也收 `name` / `body` / `tag_name` / `target_commitish`，但那些是
 * **内容**而不是状态位，且改 `tag_name` 等于移动发布的主键（影响所有按 tag 定位它的东西）。
 * 本动词按 AC7 只改三个状态位；要改标题 / 正文 / 移动 tag，用 `githana_api` 打同一个端点
 * （端点在能力面上，写法自担），或到 GitHub 网页的 releases 页。
 *
 * ## 一处需要留意的前置条件
 *
 * GitHub 不接受把**草稿或预发布**设为 latest（`make_latest=true` 与 `draft=true` /
 * `prerelease=true` 冲突）。同一次调用里既设 latest=true 又设 draft/prerelease=true 时，
 * 本动词在发请求前就明确报错，不把「GitHub 会挑其中一个生效」当成可以接受的语义。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { locateRelease, releaseFlags, makeLatestText, MAKE_LATEST_VALUES } from "../../lib/release.js";

export const command = "edit";
export const summary = "改发布的状态位（draft / prerelease / latest）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag
    .optional()
    .describe("要改的发布 tag（如 v1.2.0）。本动词不给「最近一个」的缺省——改状态位要不点名一个（tag 或 releaseId）"),
  releaseId: z.number().int().min(1).optional().describe("可选：按数字 id 定位（与 tag 二选一；tag 优先）"),
  draft: z.boolean().optional().describe("可选：true = 转成草稿，false = 发布出去（草稿不能设为 latest）"),
  prerelease: z.boolean().optional().describe("可选：true = 标为预发布，false = 取消预发布（预发布不能设为 latest）"),
  latest: z
    .enum(MAKE_LATEST_VALUES)
    .optional()
    .describe("可选：是否设为 latest——true / false / legacy（旧式算法决定哪个是 latest；legacy 不等于 false）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "修改 GitHub 远端发布的状态位（draft / prerelease / latest）：改成非草稿等于发布出去（会出现在 releases 页与 latest 判定里），改 latest 会影响仓库「最新发布」的指向，执行前请确认 repo 与要改的发布",
  ruleId: "github-toolkit-release-edit",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const hasTag = input?.tag !== undefined && input?.tag !== null && String(input.tag).trim() !== "";
  const hasId = input?.releaseId !== undefined && input?.releaseId !== null;
  if (!hasTag && !hasId) {
    return (
      label + " 参数错误：要改哪个发布（tag 或 releaseId 二选一）。本动词不给「最近一个」的缺省——" +
      "改状态位不吃危险默认值。\n先看有哪些：githana_release(action=\"list\")。"
    );
  }

  const patch = {};
  const changed = [];
  if (input?.draft !== undefined && input?.draft !== null) {
    patch.draft = input.draft === true;
    changed.push("draft=" + String(patch.draft));
  }
  if (input?.prerelease !== undefined && input?.prerelease !== null) {
    patch.prerelease = input.prerelease === true;
    changed.push("prerelease=" + String(patch.prerelease));
  }
  if (input?.latest !== undefined && input?.latest !== null) {
    patch.make_latest = String(input.latest);
    changed.push("latest=" + makeLatestText(input.latest));
  }

  if (changed.length === 0) {
    return (
      label + " 参数错误：至少要给一个状态位（draft / prerelease / latest）。\n" +
      "要改标题 / 正文 / 移动 tag 不属本动词（那是发布内容，不是状态位）：用 githana_api 打 " +
      "PATCH /repos/{owner}/{repo}/releases/{id}，或到 GitHub 网页的 releases 页改。"
    );
  }

  // 只在同一次调用里同时要求「设 latest」与「是草稿 / 预发布」时拦下来：那是自相矛盾的
  // 请求，GitHub 只会挑一个生效。分成两次调用是明确的（先把 draft/prerelease 定下来，
  // 再单独设 latest）——顺带说清那一步该怎么做。
  if (patch.make_latest === "true" && (patch.draft === true || patch.prerelease === true)) {
    return (
      label + " 参数错误：同一次调用里不能既把发布设为 latest、又把它设成草稿 / 预发布。\n" +
      "GitHub 不接受草稿或预发布作为 latest。请分两次：先调本动词把 draft / prerelease 定下来，" +
      "再单独调一次设 latest（那时它已经不是草稿 / 预发布了）。"
    );
  }

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  const relId = rel.id !== undefined && rel.id !== null ? String(rel.id) : "";
  if (!relId) return label + "：定位到的发布没有数字 id，无法走 PATCH /releases/{id}。";

  const before = releaseFlags(rel);

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/releases/" + encodeURIComponent(relId)), json: patch, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + "：仓库 " + repoLabel + " 里没有那个发布（可能在定位之后被删了）。";
    }
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次修改（422）。常见原因：把草稿 / 预发布设为 latest" +
        "（GitHub 不接受），或 tag 与已有发布冲突。\nGitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const after = res.json && typeof res.json === "object" ? res.json : {};
  const afterFlags = releaseFlags(after);
  const out = [
    label + " 已执行（" + repoLabel + " · " + (after.tag_name || rel.tag_name || input.tag || relId) + "）：",
    "改动：" + changed.join(" · "),
    "状态位：" + (before.length ? before.join(" · ") : "无") + " → " + (afterFlags.length ? afterFlags.join(" · ") : "无"),
    "现状态：" + (after.draft ? "草稿 draft" : "已发布") +
      (after.prerelease ? " · 预发布 prerelease" : "") +
      (after.latest === true ? " · latest" : ""),
  ];
  if (patch.make_latest !== undefined && after.latest === undefined) {
    out.push("make_latest 请求值：" + makeLatestText(patch.make_latest) + "（以 GitHub 的实际结果为准）");
  }
  if (after.published_at) out.push("发布于：" + fmtTime(after.published_at) + (after.draft === false && !rel.published_at ? "（这次转成了已发布）" : ""));
  if (after.html_url) out.push("URL：" + after.html_url);
  if (after.draft === true) out.push("说明：草稿不会出现在 /releases/latest 与公开的 releases 页；要发布出去再用 draft=false。");
  return out.join("\n");
}
