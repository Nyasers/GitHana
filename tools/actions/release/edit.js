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
export const summary = "Edit a release's status flags (draft / prerelease / latest)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag
    .optional()
    .describe("The release tag to edit (e.g. v1.2.0). This verb offers no \"most recent\" default — changing status flags requires naming one (tag or releaseId)"),
  releaseId: z.number().int().min(1).optional().describe("Optional: locate by numeric id (either this or tag; when both are given releaseId wins)"),
  draft: z.boolean().optional().describe("Optional: true = turn into a draft, false = publish it (drafts cannot be made latest)"),
  prerelease: z.boolean().optional().describe("Optional: true = mark as prerelease, false = unmark it (prereleases cannot be made latest)"),
  latest: z
    .enum(MAKE_LATEST_VALUES)
    .optional()
    .describe("Optional: whether to make it latest — true / false / legacy (the old algorithm decides which one is latest; legacy is not the same as false)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Modify a remote GitHub release's status flags (draft / prerelease / latest): making it non-draft publishes it (it then appears on the releases page and in latest determination), and changing latest affects which release the repository points to as \"latest\" — confirm repo and the release to edit before running",
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
      label + " argument error: which release to edit (tag or releaseId, pick one). This verb offers no \"most recent\" default —" +
      "changing status flags does not get a dangerous default.\nTo see what exists: githana_release(action=\"list\")."
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
      label + " argument error: at least one status flag is required (draft / prerelease / latest).\n" +
      "Changing the title / body / moving the tag is not this verb (that is release content, not a status flag): use githana_api against " +
      "PATCH /repos/{owner}/{repo}/releases/{id}, or edit it on the releases page of the GitHub website."
    );
  }

  // 只在同一次调用里同时要求「设 latest」与「是草稿 / 预发布」时拦下来：那是自相矛盾的
  // 请求，GitHub 只会挑一个生效。分成两次调用是明确的（先把 draft/prerelease 定下来，
  // 再单独设 latest）——顺带说清那一步该怎么做。
  if (patch.make_latest === "true" && (patch.draft === true || patch.prerelease === true)) {
    return (
      label + " argument error: the same call cannot both make the release latest and set it as a draft / prerelease.\n" +
      "GitHub does not accept a draft or prerelease as latest. Split it into two calls: first call this verb to settle draft / prerelease, " +
      "then call it again on its own to set latest (by then it is no longer a draft / prerelease)."
    );
  }

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  const relId = rel.id !== undefined && rel.id !== null ? String(rel.id) : "";
  if (!relId) return label + ": the located release has no numeric id, so it cannot go through PATCH /releases/{id}.";

  const before = releaseFlags(rel);

  const r = await callRest(
    [{ method: "PATCH", url: apiUrl(repo, "/releases/" + encodeURIComponent(relId)), json: patch, timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + ": repository " + repoLabel + " has no such release (it may have been deleted after being located).";
    }
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this edit (422). Common causes: setting a draft / prerelease as latest" +
        " (GitHub does not accept that), or the tag conflicting with an existing release.\nGitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const after = res.json && typeof res.json === "object" ? res.json : {};
  const afterFlags = releaseFlags(after);
  const out = [
    label + " done (" + repoLabel + " · " + (after.tag_name || rel.tag_name || input.tag || relId) + "):",
    "changes: " + changed.join(" · "),
    "flags: " + (before.length ? before.join(" · ") : "none") + " → " + (afterFlags.length ? afterFlags.join(" · ") : "none"),
    "current state: " + (after.draft ? "draft" : "published") +
      (after.prerelease ? " · prerelease" : "") +
      (after.latest === true ? " · latest" : ""),
  ];
  if (patch.make_latest !== undefined && after.latest === undefined) {
    out.push("make_latest requested: " + makeLatestText(patch.make_latest) + " (GitHub's actual result is authoritative)");
  }
  if (after.published_at) out.push("published: " + fmtTime(after.published_at) + (after.draft === false && !rel.published_at ? " (turned into published by this call)" : ""));
  if (after.html_url) out.push("URL: " + after.html_url);
  if (after.draft === true) out.push("note: drafts do not appear under /releases/latest or on the public releases page; to publish it use draft=false.");
  return out.join("\n");
}
