// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/download：把发布资产取到本地。
 *
 * ## 本期做不到「取到本地」——通道挡住了
 *
 * 定位与取址那一半是**实现好的**（也确实是 gh 那一半的语义）：按 tag 找到 release、按
 * assetName 找到资产、给出 API 地址与 browser_download_url。卡住的是最后一跳，三条硬限制见
 * tools/lib/transfer.js。其中一条值得单独点出：`GET /repos/{o}/{r}/tarball/{ref}` 的 302 目标
 * `codeload.github.com` **在白名单里**（`REDIRECT_HOSTS`），所以源码归档能过前两条——但它们
 * 仍然是二进制，过不了第三条（响应体按 UTF-8 有界读取，2MB 截断）。
 *
 * ## 为什么不声明 `dir`
 *
 * gh 的 `release download --dir <dir>` 指定落盘目录。本期写不了盘，声明一个只被忽略的参数等于
 * 对模型面撒谎（而且它会被 zod 的多余键判据拒掉，所以只能「声明了却不用」——那更糟）。
 * 写盘通道落地时再加，届时 `dir` 是它自己的参数。
 *
 * ## 取址是给调用方用的
 *
 * 回执里的 URL 可以直接粘给 `gh release download` / curl / 浏览器——**退给调用方**而不是自己
 * 硬塞一条通道，是本动词这一期的正确形态。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { locateRelease, findAsset, assetLine, formatSize } from "../../lib/release.js";
import { binaryUnavailableText } from "../../lib/transfer.js";

export const command = "download";
export const summary = "下载发布资产（本期只取址：二进制通道不存在）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  assetName: params.assetNameOptional.describe("可选：要下载的资产名；缺省 = 该 release 的全部资产"),
  assetId: z.number().int().min(1).optional().describe("可选：按数字 id 指定资产（与 assetName 二选一；assetName 优先不用它）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "读取 GitHub 远端发布资产的内容与地址（本期只回报地址，不写本地磁盘）：不修改远端状态，执行前请确认 repo 与 tag",
  ruleId: "github-toolkit-release-download",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel } = c;

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  const releaseId = rel.id !== undefined ? String(rel.id) : "";
  const assets = Array.isArray(rel.assets) ? rel.assets : [];

  // 目标集：点名一个资产，或该 release 的全部资产。
  let targets = assets;
  const named = input?.assetName !== undefined && input.assetName !== null && String(input.assetName).trim() !== "";
  const numbered = input?.assetId !== undefined && input.assetId !== null;
  if (named || numbered) {
    const found = findAsset(rel, input);
    if (found.error) {
      return [
        label + " 参数错误：" + found.error,
        "该 release 的资产：",
        (found.list.length ? found.list.map(assetLine).join("\n") : "  （没有任何资产）"),
      ].join("\n");
    }
    targets = [found.asset];
  }

  const out = [
    label + " 未写盘（本期不下载二进制）：" + repoLabel + " · tag " + (rel.tag_name || "?") +
    " · 目标 " + targets.length + " 个资产",
  ];
  if (targets.length === 0) {
    out.push("这个 release 没有任何资产。");
    return out.join("\n");
  }

  out.push("资产与取得地址：");
  for (const a of targets) {
    out.push(assetLine(a));
    if (releaseId && a.id !== undefined) {
      // octet-stream 是「取字节」的那条；不带它返回的是资产的 JSON 元数据。
      out.push("      取字节（需 Accept: application/octet-stream）：GET /repos/" + repo + "/releases/assets/" + a.id);
    }
    if (a.browser_download_url) out.push("      浏览器直链：" + String(a.browser_download_url));
    if (a.size !== undefined) out.push("      体积：" + formatSize(a.size) + "（" + a.size + " 字节）");
    if (a.digest) out.push("      摘要：" + String(a.digest) + "（可用 verify-asset 与本地文件比对）");
  }
  out.push("");
  out.push("本期不下载的原因（三条硬限制）：");
  out.push(binaryUnavailableText());
  out.push("其中源码归档（GET /repos/{o}/{r}/tarball/{ref}）的 302 目标 codeload.github.com 在白名单内，但仍过不了第三条。");
  out.push("本期可行的替代做法：");
  out.push("  · gh release download " + (rel.tag_name || "<tag>") + " --repo " + repoLabel + (named ? " --pattern \"" + String(input.assetName) + "\"" : "") + "（外部二进制，不受上述限制）；");
  out.push("  · 或用上面的浏览器直链在浏览器 / curl 里取。");
  out.push("githana_api 不是逃生门：它走同一条 worker、同一份主机白名单，且响应体同样按 UTF-8 截断读取。");
  return out.join("\n");
}
