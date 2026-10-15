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
export const summary = "删除发布里的一个资产（不可撤销，需 confirm=true）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetName,
  assetId: z.number().int().min(1).optional().describe("可选：按数字 id 指定资产（与 assetName 二选一；assetName 优先不用它）"),
  confirm: z
    .boolean()
    .optional()
    .describe("必须为 true 才真删：删除资产不可撤销（下载计数与直链一起失效），缺它会返回引导"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "**删除** GitHub 远端发布里的一个资产（发布对象与其余资产不受影响）：删除不可撤销，执行前请再次确认 repo、tag 与资产名",
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
      label + " 参数错误：" + found.error,
      "该 release（" + (rel.tag_name || input.tag || "?") + "）的资产：",
      assetListText(found.list),
    ].join("\n");
  }
  const asset = found.asset;
  const assetId = asset.id !== undefined ? String(asset.id) : "";
  if (!assetId) return label + "：资产响应里没有 id，无法走 REST 删除。";

  if (input?.confirm !== true) {
    return [
      label + " 需要确认（未执行删除）：",
      "将删除资产：" + (asset.name || "?") + "（" + repoLabel + " · " + (rel.tag_name || "?") + "）",
      "体积：" + (asset.size !== undefined ? formatSize(asset.size) : "?") +
        " · 下载次数：" + (asset.download_count !== undefined ? asset.download_count : "?") +
        (asset.state ? " · 状态：" + asset.state : ""),
      "删除**不可撤销**：文件内容与它的直链一起失效（浏览器直链、API 取字节地址都不再可用），GitHub 没有回收站。",
      "发布对象与其余资产不受影响；删掉之后可以用 githana_release(action=\"upload\") 重传同名资产。",
      "确认后请重发同一次调用并带上 confirm=true。",
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " 执行失败：" + describeFailure(res, repoLabel);

  return [
    label + " 已删除（" + repoLabel + " · " + (rel.tag_name || "?") + "）：",
    "资产：" + (asset.name || "?") + " · id " + assetId +
      (asset.size !== undefined ? " · " + formatSize(asset.size) : "") +
      (asset.download_count !== undefined ? " · 删除前下载 " + asset.download_count + " 次" : ""),
    "说明：只删了这个资产，发布对象与其余资产仍在。要重建同名资产用 githana_release(action=\"upload\")。",
  ].join("\n");
}
