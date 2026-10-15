// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/delete-asset：删除发布里的一个资产（githana_release 动词，不可撤销）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/releases/assets/{asset_id}`，支撑权限 `contents: write`
 * （D7 已授权）。定位那一跳（tag → release → asset）在 tools/lib/release.js：release 表示里
 * 内嵌了 assets 数组，所以按 assetName 找资产**不额外发请求**，删的时候才用它的 id。
 *
 * 与 release/delete 的分界：本动词只动一个资产，发布对象与其余资产、tag 都不受影响。
 * 与 upload 的分界：删除是纯 JSON 的 DELETE，没有载荷；上传是二进制体（走同一条 worker 的
 * 二进制通道，见 tools/lib/transfer.js）。这是同一个 release 的两个相反动作，不是两条通道。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { locateRelease, findAsset, assetListText, formatSize } from "../../lib/release.js";

export const command = "delete-asset";
export const summary = "Delete one asset from a release (irreversible, requires confirm=true)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetName,
  assetId: z.number().int().min(1).optional().describe("Optional: identify the asset by numeric id (either this or assetName; assetName takes priority over it)"),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually delete: deleting an asset is irreversible (the download count and the direct link stop working); without it you get guidance instead"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "**Delete** one asset from a remote GitHub release (the release object and the other assets are unaffected): deletion is irreversible, confirm repo, tag and asset name again before running",
  ruleId: "github-toolkit-release-delete-asset",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;

  const found = findAsset(rel, input);
  if (found.error) {
    return [
      label + " argument error: " + found.error,
      "assets of that release (" + (rel.tag_name || input.tag || "?") + "):",
      assetListText(found.list),
    ].join("\n");
  }
  const asset = found.asset;
  const assetId = asset.id !== undefined ? String(asset.id) : "";
  if (!assetId) return label + ": the asset response has no id, so it cannot be deleted via REST.";

  if (input?.confirm !== true) {
    return [
      label + " confirmation required (nothing deleted yet):",
      "Will delete asset: " + (asset.name || "?") + " (" + repoLabel + " · " + (rel.tag_name || "?") + ")",
      "size: " + (asset.size !== undefined ? formatSize(asset.size) : "?") +
        " · downloads: " + (asset.download_count !== undefined ? asset.download_count : "?") +
        (asset.state ? " · state: " + asset.state : ""),
      "Deletion is **irreversible**: the file content and its direct link stop working together (browser direct links and API byte addresses are both no longer usable), and GitHub has no recycle bin.",
      "The release object and the other assets are unaffected; after deleting you can re-upload an asset with the same name using githana_release(action=\"upload\").",
      "To confirm, resend the same call with confirm=true.",
    ].join("\n");
  }

  const r = await callRest(
    [
      {
        method: "DELETE",
        url: apiUrl(repo, "/releases/assets/" + encodeURIComponent(assetId)),
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
    label + " deleted (" + repoLabel + " · " + (rel.tag_name || "?") + "):",
    "asset: " + (asset.name || "?") + " · id " + assetId +
      (asset.size !== undefined ? " · " + formatSize(asset.size) : "") +
      (asset.download_count !== undefined ? " · " + asset.download_count + " downloads before deletion" : ""),
    "note: only this asset was deleted; the release object and the other assets remain. To recreate a same-named asset use githana_release(action=\"upload\").",
  ].join("\n");
}
