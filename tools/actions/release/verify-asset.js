// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/verify-asset：核对一个发布资产的摘要（githana_release 动词）。
 *
 * 与 `verify` 的分工：那是发布级别（全部资产的摘要清单 + 可选的批量本地比对），本动词是
 * **一个资产、报得更细**——算法、体积一致性、本地文件比对结论。两个动词都只做「发布自身的
 * 完整性」这一层，来源证明（attestation）那一层做不到，原因同 verify（那一条写在
 * actions/release/verify.js 的 ATTESTATION_LIMIT 里，这里引用同一句，不复述第二份）。
 *
 * 定位那一跳（tag → release → asset）在 tools/lib/release.js；本地读取的权限边界在
 * tools/lib/transfer.js（许可根之外报 ERR_ACCESS_DENIED，不是「文件不存在」）。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { locateRelease, findAsset, assetListText, formatSize } from "../../lib/release.js";
import { normalizeLocalPath, sha256File, parseDigest } from "../../lib/transfer.js";
import { ATTESTATION_LIMIT } from "./verify.js";

export const command = "verify-asset";
export const summary = "Verify one release asset's digest (optionally compared against a local file)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetName,
  assetId: z.number().int().min(1).optional().describe("Optional: identify the asset by numeric id (either this or assetName; assetName takes priority over it)"),
  file: z.string().optional().describe("Optional: absolute path to a local file (its sha256 is computed and compared against the digest recorded for the asset)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Read the digest and size of one release asset on remote GitHub and (when file is given) read a local file to compute sha256 for comparison: does not modify remote state and does not write to the local disk",
  ruleId: "github-toolkit-release-verify-asset",
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
  const listed = found.asset;

  // 摘要以**单个资产端点**（GET /releases/assets/{id}）为准：release 表示里内嵌的那份 assets
  // 不保证带 digest（那是个较新的字段）。所以这里按 id 再取一次；取不到就退回列表里那份
  // （并把"缺摘要"这件事如实说出来，不假装核对过了）。
  let asset = listed;
  let detailError = null;
  if (listed.id !== undefined) {
    const r = await callRest(
      [
        {
          url: apiUrl(repo, "/releases/assets/" + encodeURIComponent(String(listed.id))),
          timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
        },
      ],
      { timeoutSec },
    );
    if (!r.ok) detailError = r.message;
    else {
      const res = r.results[0];
      if (!res || !res.ok) detailError = describeFailure(res, repoLabel);
      else if (res.json && typeof res.json === "object") asset = res.json;
    }
  }

  const name = asset.name || listed.name || "?";
  const remote = parseDigest(asset.digest);
  const out = [
    label + " (" + repoLabel + " · " + (rel.tag_name || "?") + " · " + name + "):",
    "asset id: " + (asset.id !== undefined ? asset.id : "?"),
    "size: " + (asset.size !== undefined ? formatSize(asset.size) + " (" + asset.size + " bytes)" : "?"),
    "state: " + (asset.state || "?"),
    "downloads: " + (asset.download_count !== undefined ? asset.download_count : "?"),
  ];
  if (asset.created_at) out.push("uploaded: " + String(asset.created_at));
  if (asset.content_type) out.push("type: " + String(asset.content_type));
  if (asset.label) out.push("label: " + String(asset.label));

  out.push("");
  if (remote) {
    out.push("digest recorded by GitHub: " + remote.algorithm + ":" + remote.hex);
    if (remote.algorithm !== "sha256") {
      out.push("note: the recorded algorithm is " + remote.algorithm + " while this verb only computes sha256, so they cannot be compared directly — below only the locally computed value is reported.");
    }
  } else {
    out.push("digest recorded by GitHub: none");
    out.push(
      "note: GitHub only records a digest for assets **uploaded with a digest** (older assets, or ones uploaded by other tools, may not have one). " +
      "A missing digest is not an error, but this item simply cannot be compared." +
      (detailError ? "\n(also: fetching this asset's details separately failed — " + detailError + "; the copy above came from the release's asset list.)" : ""),
    );
  }

  const fileIn = input?.file !== undefined && input?.file !== null ? String(input.file).trim() : "";
  if (!fileIn) {
    out.push("");
    out.push("no file given: only the remote record is reported. To compare a local copy, pass file=\"<absolute path to local file>\".");
    out.push("");
    out.push("note: " + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  const norm = normalizeLocalPath(fileIn, "file");
  if (norm.error) {
    out.push("");
    out.push("local file: " + norm.error);
    return out.join("\n");
  }
  const sum = await sha256File(norm.path, "local file");
  out.push("");
  if (sum.error) {
    out.push("local file: " + norm.path);
    out.push("read failed: " + sum.error);
    out.push("");
    out.push("note: " + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  out.push("local file: " + norm.path);
  out.push("local sha256: " + sum.hex + " (" + formatSize(sum.size) + ")");
  out.push("");
  if (!remote) {
    out.push("conclusion: **cannot compare** — GitHub has no sha256 recorded. The local digest has been computed, so you can check it against whatever digest the publisher published.");
  } else if (remote.algorithm !== "sha256") {
    out.push("conclusion: **cannot compare** — GitHub records " + remote.algorithm + " while the local computation is sha256 (this App computes only that one).");
  } else if (remote.hex === sum.hex) {
    const sizeMismatch =
      asset.size !== undefined && Number(asset.size) !== sum.size
        ? " (note: the sizes differ — remote " + formatSize(asset.size) + " vs local " + formatSize(sum.size) + " — yet the digests match, which is impossible; please double-check the byte count that was fetched)"
        : "";
    out.push("conclusion: **they match** — the local file is the content of this asset." + sizeMismatch);
  } else {
    out.push("conclusion: **they differ** — the remote and local digests differ, so the local file is not this asset (or it has been modified).");
    if (asset.size !== undefined && Number(asset.size) !== sum.size) {
      out.push("      the sizes differ too: remote " + formatSize(asset.size) + " vs local " + formatSize(sum.size) + ".");
    }
    out.push("      remote sha256: " + remote.hex);
    out.push("      local sha256: " + sum.hex);
  }
  out.push("");
  out.push("note: " + ATTESTATION_LIMIT);
  out.push("note: local files outside the permission root cannot be read (AppHost's Node permission model); that case reports ERR_ACCESS_DENIED, not \"file not found\".");
  return out.join("\n");
}
