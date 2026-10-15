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
export const summary = "Delete a release (irreversible, requires confirm=true; does not delete the tag)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag.describe("Required: the release tag to delete (this verb offers no \"most recent\" default — an irreversible action does not get a dangerous default)"),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually delete: deleting a release is irreversible (its assets go too); without it you get guidance instead"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "**Delete** a release object in a remote GitHub repository (its assets disappear too, the tag is kept): deletion is irreversible, confirm repo and tag again before running",
  ruleId: "github-toolkit-release-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const tag = input?.tag !== undefined && input?.tag !== null ? String(input.tag).trim() : "";
  if (!tag) return label + " argument error: tag is required (which release to delete). This verb offers no default — an irreversible action does not get a dangerous default.";

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const total = assets.reduce((sum, a) => sum + (Number(a && a.size) || 0), 0);

  if (input?.confirm !== true) {
    const out = [
      label + " confirmation required (nothing deleted yet):",
      "Will delete release: " + (rel.tag_name || tag) + " (" + repoLabel + " · id " + (rel.id !== undefined ? rel.id : "?") + ")",
      "title: " + (rel.name || "(untitled)") +
        (releaseFlags(rel).length ? " · " + releaseFlags(rel).join(" · ") : ""),
    ];
    if (assets.length) {
      out.push("assets (" + assets.length + " · " + formatSize(total) + " total; they disappear too):");
      for (const a of assets) out.push(assetLine(a));
    } else {
      out.push("assets: none");
    }
    out.push("Deletion is **irreversible**: the release object and its assets are gone together, and GitHub has no recycle bin.");
    out.push("The **tag is not affected**: this verb deletes only the release (the ref is a git object). To delete the tag as well, that is a separate matter — use githana_git(action=\"exec\", args=[\"push\", \"origin\", \":refs/tags/" + tag + "\"]).");
    out.push("To confirm, resend the same call with confirm=true.");
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
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " execution failed: " + describeFailure(res, repoLabel);

  return [
    label + " deleted (" + repoLabel + "):",
    "release: " + (rel.tag_name || tag) + " · id " + (rel.id !== undefined ? rel.id : "?") + " · title " + (rel.name || "(untitled)"),
    "assets: " + (assets.length === 0 ? "none" : assets.length + " deleted along with the release (" + formatSize(total) + " total)"),
    "note: the tag " + (rel.tag_name || tag) + " still exists (this verb deletes only the release object). To recreate a same-named release use githana_release(action=\"create\"); to delete the tag use githana_git(action=\"exec\") and explicitly push a ref deletion.",
  ].join("\n");
}
