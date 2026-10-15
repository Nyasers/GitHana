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
 *      本动词只建 release 本体，上传是独立的一步（`upload`）。合成一次调用会让「建了但资产没上去」
 *      变成半途状态，而这里没有回滚可做。
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
export const summary = "Create a release (tag + title + notes)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag.describe("Required: the release tag name (e.g. v1.2.0); if the tag does not exist GitHub creates it from target"),
  name: z.string().optional().describe("Optional: release title (defaults to the tag name)"),
  body: z.string().optional().describe("Optional: release notes (Markdown)"),
  draft: z.boolean().optional().describe("Optional: create as a draft (drafts cannot be made latest and do not appear under /releases/latest)"),
  prerelease: z.boolean().optional().describe("Optional: mark as a prerelease (cannot be made latest)"),
  target: z.string().optional().describe("Optional: which commit/branch to create the tag from (defaults to the repository default branch)"),
  generateNotes: z.boolean().optional().describe("Optional: let GitHub generate the release notes automatically (overrides body)"),
  latest: z.enum(MAKE_LATEST_VALUES).optional().describe("Optional: whether to make it latest (true / false / legacy = the old algorithm); by default GitHub decides"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Create a release in a remote GitHub repository (the tag is created too if it does not exist): modifies remote GitHub state, confirm repo, tag and the draft / prerelease flags before running",
  ruleId: "github-toolkit-release-create",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const tag = input?.tag !== undefined && input?.tag !== null ? String(input.tag).trim() : "";
  if (!tag) return label + " argument error: tag is required (the release tag name, e.g. v1.2.0).";

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
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this creation (422). The most common cause is that **a release for the same tag already exists**" +
        " (a tag can only have one release; to change it, look at the current state with githana_release(action=\"view\")).\n" +
        "GitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const rel = res.json && typeof res.json === "object" ? res.json : {};
  const out = [
    label + " created (" + repoLabel + "):",
    "tag: " + (rel.tag_name || tag),
    "title: " + (rel.name || "(untitled)"),
    "state: " + (rel.draft ? "draft" : "published") + (rel.prerelease ? " · prerelease" : "") +
      (rel.latest === true ? " · latest" : ""),
  ];
  if (input?.latest !== undefined && input.latest !== null) {
    out.push("make_latest requested: " + makeLatestText(input.latest) + " (drafts and prereleases cannot be made latest; GitHub's actual result is authoritative)");
  }
  if (rel.target_commitish) out.push("target: " + rel.target_commitish);
  if (rel.published_at) out.push("published: " + fmtTime(rel.published_at));
  if (rel.html_url) out.push("URL: " + rel.html_url);
  out.push("note: no assets are attached. To attach build outputs, follow up with githana_release(action=\"upload\", tag=\"" + (rel.tag_name || tag) + "\", file=\"<absolute path to the local file>\").");
  return out.join("\n");
}
