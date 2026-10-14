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
export const summary = "核对一个发布资产的摘要（可选与本地文件比对）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetName,
  assetId: z.number().int().min(1).optional().describe("可选：按数字 id 指定资产（与 assetName 二选一；assetName 优先不用它）"),
  file: z.string().optional().describe("可选：本地文件绝对路径（算它的 sha256 与资产记录的摘要比对）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "读取 GitHub 远端某个发布资产的摘要与体积，并（在给了 file 时）读取本地文件算 sha256 做比对：不修改远端状态，也不写本地磁盘",
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
      label + " 参数错误：" + found.error,
      "该 release（" + (rel.tag_name || input.tag || "?") + "）的资产：",
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
    label + "（" + repoLabel + " · " + (rel.tag_name || "?") + " · " + name + "）：",
    "资产 id：" + (asset.id !== undefined ? asset.id : "?"),
    "体积：" + (asset.size !== undefined ? formatSize(asset.size) + "（" + asset.size + " 字节）" : "?"),
    "状态：" + (asset.state || "?"),
    "下载次数：" + (asset.download_count !== undefined ? asset.download_count : "?"),
  ];
  if (asset.created_at) out.push("上传于：" + String(asset.created_at));
  if (asset.content_type) out.push("类型：" + String(asset.content_type));
  if (asset.label) out.push("标签：" + String(asset.label));

  out.push("");
  if (remote) {
    out.push("GitHub 记录的摘要：" + remote.algorithm + ":" + remote.hex);
    if (remote.algorithm !== "sha256") {
      out.push("说明：记录的是 " + remote.algorithm + "，本动词只算 sha256，无法直接比对——下面只报本地算出的值。");
    }
  } else {
    out.push("GitHub 记录的摘要：无");
    out.push(
      "说明：GitHub 只为**上传时带摘要**的资产记录 digest（较老的、或经其它工具上传的资产可能没有）。" +
      "缺失不是错误，但这一项就无从比对。" +
      (detailError ? "\n（另：单独取该资产的详情失败了——" + detailError + "，上面这份来自 release 的资产列表。）" : ""),
    );
  }

  const fileIn = input?.file !== undefined && input?.file !== null ? String(input.file).trim() : "";
  if (!fileIn) {
    out.push("");
    out.push("没有给 file：只报远端记录。要比对本地副本，传 file=\"<本地文件绝对路径>\"。");
    out.push("");
    out.push("说明：" + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  const norm = normalizeLocalPath(fileIn, "file");
  if (norm.error) {
    out.push("");
    out.push("本地文件：" + norm.error);
    return out.join("\n");
  }
  const sum = await sha256File(norm.path, "本地文件");
  out.push("");
  if (sum.error) {
    out.push("本地文件：" + norm.path);
    out.push("读取失败：" + sum.error);
    out.push("");
    out.push("说明：" + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  out.push("本地文件：" + norm.path);
  out.push("本地 sha256：" + sum.hex + "（" + formatSize(sum.size) + "）");
  out.push("");
  if (!remote) {
    out.push("结论：**无法比对**——GitHub 侧没有记录 sha256。本地摘要已算出，可自行与发布方公布的摘要核对。");
  } else if (remote.algorithm !== "sha256") {
    out.push("结论：**无法比对**——GitHub 记的是 " + remote.algorithm + "，本地算的是 sha256（本 App 只算这一种）。");
  } else if (remote.hex === sum.hex) {
    const sizeMismatch =
      asset.size !== undefined && Number(asset.size) !== sum.size
        ? "（注意：体积不一致——远端 " + formatSize(asset.size) + " vs 本地 " + formatSize(sum.size) + "，摘要却相同，这不可能，请复核取到的字节数）"
        : "";
    out.push("结论：**一致**——本地文件就是这个资产的内容。" + sizeMismatch);
  } else {
    out.push("结论：**不一致**——远端与本地摘要不同，本地文件不是这个资产（或已被改动）。");
    if (asset.size !== undefined && Number(asset.size) !== sum.size) {
      out.push("      体积也不符：远端 " + formatSize(asset.size) + " vs 本地 " + formatSize(sum.size) + "。");
    }
    out.push("      远端 sha256：" + remote.hex);
    out.push("      本地 sha256：" + sum.hex);
  }
  out.push("");
  out.push("说明：" + ATTESTATION_LIMIT);
  out.push("说明：许可根之外的本地文件读不到（AppHost 的 Node 权限模型），那种情况报的是 ERR_ACCESS_DENIED，不是「文件不存在」。");
  return out.join("\n");
}
