// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/verify：核对一个发布的完整性（githana_release 动词）。
 *
 * ## 与 gh 的 `release verify` 差在哪，如实写在输出里
 *
 * gh 的 `gh release verify [<tag>]` 做的是**来源证明（attestation）校验**：取 sigstore 的
 * attestation，用公钥基础设施验证「这个发布确实由该仓库的 Actions 产出」。本 App 做不到，
 * 两个各自独立的原因：
 *   · `attestations` 权限**不在授权集里**（D7 实测的 permissions 里没有它），
 *     `GET /repos/{o}/{r}/attestations/{subject_digest}` 在私有仓库上会被 GitHub 直接拒；
 *   · sigstore 的验签与信任根校验不是「发一个请求」能完成的，它需要一个签名验证实现——
 *     而服务端零 npm 依赖是硬约束（现有依赖只有随包的 openpgp 与 zod，两者都不是 sigstore）。
 *
 * 所以本动词做的是**它做得到的那一层**：核对发布自身的完整性——每个资产在 GitHub 侧记录的
 * `digest`（`sha256:<hex>`）与实际体积，以及（可选的）与**本地文件**的逐字节摘要比对。
 * 这一层能回答的问题：「我手上这个包，是不是这个发布里那个资产」。它**不能**回答 gh 的
 * verify 回答的那个问题（「这个发布是不是该仓库产出的」）——那条在输出里明说，不假装。
 *
 * ## 两个动词的分工
 *
 *   · `verify`（本文件）——发布级别：资产的摘要清单 + 缺摘要的项 + 可选的本地文件批量比对；
 *   · `verify-asset`——一次比一个资产，报得更细（算法、体积一致性、比对结论）。
 *
 * 本地文件读取的权限边界见 tools/lib/transfer.js：许可根之外是可读的 ERR_ACCESS_DENIED 错误，
 * 不是「文件不存在」。
 */
import { z } from "zod";
import * as params from "../../lib/params.js";
import { resolveContext } from "../../lib/gh.js";
import { locateRelease, findAsset, assetLine, formatSize } from "../../lib/release.js";
import { normalizeLocalPath, sha256File, parseDigest } from "../../lib/transfer.js";

export const command = "verify";
export const summary = "核对发布的完整性（资产的 sha256 清单 + 可选与本地文件比对）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  files: z
    .array(z.string())
    .optional()
    .describe("可选：本地文件绝对路径列表；按**文件名**与资产名匹配，逐个算 sha256 与 GitHub 记录的摘要比对"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "读取 GitHub 远端发布的资产摘要清单，并（在给了 files 时）读取本地文件算 sha256 做比对：不修改远端状态，也不写本地磁盘",
  ruleId: "github-toolkit-release-verify",
};

/** 本动词做不到的那一层（gh release verify 的 attestation 校验）——统一文案，别处也要引用。 */
export const ATTESTATION_LIMIT =
  "来源证明（attestation）校验不在本动词上：`attestations` 权限不在本 App 的授权集里（D7），" +
  "且 sigstore 验签需要一个签名验证实现，与「服务端零 npm 依赖」冲突。要那一层请用 gh CLI：" +
  "gh attestation verify <file> --repo <owner/repo>。";

/** 摘要比对一行。 */
function compareLine(asset, localHex) {
  const remote = parseDigest(asset && asset.digest);
  if (!remote) {
    return "  ? " + (asset && asset.name ? asset.name : "?") + "：GitHub 侧没有记录 digest，无法比对（见下方说明）";
  }
  if (remote.algorithm !== "sha256") {
    return "  ? " + (asset && asset.name ? asset.name : "?") + "：GitHub 记的是 " + remote.algorithm + "，本地算的是 sha256，无法比";
  }
  if (remote.hex === localHex) return "  ✓ " + asset.name + "：一致（sha256 " + localHex.slice(0, 16) + "…）";
  return (
    "  ✗ " + asset.name + "：**不一致**——远端 sha256 " + remote.hex.slice(0, 16) +
    "…，本地 sha256 " + localHex.slice(0, 16) + "…"
  );
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repoLabel } = c;

  const located = await locateRelease(input, c, label, { required: true });
  if (located.error) return located.error;
  const rel = located.release;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];

  const out = [
    label + "（" + repoLabel + " · " + (rel.tag_name || "?") + "）：",
    "资产 " + assets.length + " 个" +
      (rel.id !== undefined ? " · release id " + rel.id : "") +
      (rel.draft ? " · 草稿 draft" : "") +
      (rel.prerelease ? " · 预发布 prerelease" : ""),
  ];

  if (assets.length === 0) {
    out.push("（没有任何资产，没有可核对的摘要）");
    out.push("");
    out.push("说明：" + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  // 远端侧的摘要清单：这一层只读 API，不碰本地文件。
  const withDigest = assets.filter((a) => parseDigest(a && a.digest));
  out.push("");
  out.push("—— GitHub 侧记录的摘要（" + withDigest.length + " / " + assets.length + " 个资产有）——");
  for (const a of assets) {
    const d = parseDigest(a && a.digest);
    out.push(assetLine(a) + (d ? "  " + d.algorithm + ":" + d.hex.slice(0, 16) + "…" : "  （无 digest）"));
  }
  if (withDigest.length < assets.length) {
    out.push(
      "说明：" + (assets.length - withDigest.length) + " 个资产在这一份表示里没有 digest。" +
      "两个原因都可能：GitHub 只为**上传时带摘要**的资产记录它（较老的、或经其它工具上传的可能没有），" +
      "或这条 release 表示没有内联该字段——`verify-asset` 会单独取一次该资产、拿权威的那一份。",
    );
  }

  // 本地侧：只有显式给了 files 才读盘（读不到不改变上面那一层的结论，只多一行失败说明）。
  const files = Array.isArray(input?.files) ? input.files : [];
  if (files.length === 0) {
    out.push("");
    out.push("没有给 files：只核对远端清单。要核对本地副本，传 files=[\"<本地文件绝对路径>\", …]（按文件名与资产名匹配）。");
    out.push("");
    out.push("说明：" + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  out.push("");
  out.push("—— 与本地文件比对（" + files.length + " 个）——");
  for (const raw of files) {
    const norm = normalizeLocalPath(raw, "files 里的路径");
    if (norm.error) {
      out.push("  ! " + String(raw) + "：" + norm.error);
      continue;
    }
    const p = norm.path;
    const base = p.split(/[\\/]/).pop() || p;

    // 按**文件名**匹配资产：这是本地副本与远端资产之间唯一稳定的对应关系（路径在不同机器上不同）。
    const found = findAsset(rel, { assetName: base });
    if (found.error) {
      out.push("  ! " + base + "：这个发布里没有同名资产（比对无从进行）。");
      continue;
    }
    const sum = await sha256File(p, "本地文件 " + base);
    if (sum.error) {
      out.push("  ! " + base + "：" + sum.error);
      continue;
    }
    // 体积先在远端说明里报一次：体积不符本身就是一个独立信号（不必等到摘要比对）。
    const remoteSize = Number(found.asset && found.asset.size);
    const sizeNote =
      Number.isFinite(remoteSize) && remoteSize !== sum.size
        ? "（体积也不符：远端 " + formatSize(remoteSize) + " vs 本地 " + formatSize(sum.size) + "）"
        : "";
    out.push(compareLine(found.asset, sum.hex) + sizeNote);
  }
  out.push("");
  out.push("说明：" + ATTESTATION_LIMIT);
  out.push("说明：许可根之外的本地文件读不到（AppHost 的 Node 权限模型），那种情况报的是 ERR_ACCESS_DENIED，不是「文件不存在」。");
  return out.join("\n");
}
