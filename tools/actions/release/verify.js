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
export const summary = "Verify a release's integrity (sha256 manifest of assets + optional comparison with local files)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  tag: params.releaseTag,
  files: z
    .array(z.string())
    .optional()
    .describe("Optional: list of absolute paths to local files; matched to asset names by **file name**, each hashed with sha256 and compared against the digest GitHub recorded"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_release",
  summary:
    "Read the asset digest manifest of a remote GitHub release and (when files are given) read local files to compute sha256 for comparison: does not modify remote state and does not write to the local disk",
  ruleId: "github-toolkit-release-verify",
};

/** 本动词做不到的那一层（gh release verify 的 attestation 校验）——统一文案，别处也要引用。 */
export const ATTESTATION_LIMIT =
  "Attestation verification is not on this verb: the `attestations` permission is not in this App's authorization set (D7), " +
  "and sigstore signature checking needs a signature verification implementation, which conflicts with \"zero npm dependencies on the server side\". For that layer use the gh CLI: " +
  "gh attestation verify <file> --repo <owner/repo>.";

/** 摘要比对一行。 */
function compareLine(asset, localHex) {
  const remote = parseDigest(asset && asset.digest);
  if (!remote) {
    return "  ? " + (asset && asset.name ? asset.name : "?") + ": GitHub has no digest recorded, so it cannot be compared (see the note below)";
  }
  if (remote.algorithm !== "sha256") {
    return "  ? " + (asset && asset.name ? asset.name : "?") + ": GitHub records " + remote.algorithm + " while the local computation is sha256, so they cannot be compared";
  }
  if (remote.hex === localHex) return "  ✓ " + asset.name + ": match (sha256 " + localHex.slice(0, 16) + "…)";
  return (
    "  ✗ " + asset.name + ": **mismatch** — remote sha256 " + remote.hex.slice(0, 16) +
    "…, local sha256 " + localHex.slice(0, 16) + "…"
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
    label + " (" + repoLabel + " · " + (rel.tag_name || "?") + "):",
    "assets: " + assets.length +
      (rel.id !== undefined ? " · release id " + rel.id : "") +
      (rel.draft ? " · draft" : "") +
      (rel.prerelease ? " · prerelease" : ""),
  ];

  if (assets.length === 0) {
    out.push("(no assets at all, so there are no digests to check)");
    out.push("");
    out.push("note: " + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  // 远端侧的摘要清单：这一层只读 API，不碰本地文件。
  const withDigest = assets.filter((a) => parseDigest(a && a.digest));
  out.push("");
  out.push("—— digests recorded on the GitHub side (" + withDigest.length + " / " + assets.length + " assets have one) ——");
  for (const a of assets) {
    const d = parseDigest(a && a.digest);
    out.push(assetLine(a) + (d ? "  " + d.algorithm + ":" + d.hex.slice(0, 16) + "…" : "  (no digest)"));
  }
  if (withDigest.length < assets.length) {
    out.push(
      "note: " + (assets.length - withDigest.length) + " assets have no digest in this representation. " +
      "Either cause is possible: GitHub only records it for assets **uploaded with a digest** (older ones, or ones uploaded by other tools, may not have it), " +
      "or this release representation does not inline the field — `verify-asset` fetches that asset separately and gets the authoritative copy.",
    );
  }

  // 本地侧：只有显式给了 files 才读盘（读不到不改变上面那一层的结论，只多一行失败说明）。
  const files = Array.isArray(input?.files) ? input.files : [];
  if (files.length === 0) {
    out.push("");
    out.push("no files given: only the remote manifest was checked. To check local copies, pass files=[\"<absolute path to local file>\", …] (matched to asset names by file name).");
    out.push("");
    out.push("note: " + ATTESTATION_LIMIT);
    return out.join("\n");
  }

  out.push("");
  out.push("—— compared against local files (" + files.length + ") ——");
  for (const raw of files) {
    const norm = normalizeLocalPath(raw, "path in files");
    if (norm.error) {
      out.push("  ! " + String(raw) + ": " + norm.error);
      continue;
    }
    const p = norm.path;
    const base = p.split(/[\\/]/).pop() || p;

    // 按**文件名**匹配资产：这是本地副本与远端资产之间唯一稳定的对应关系（路径在不同机器上不同）。
    const found = findAsset(rel, { assetName: base });
    if (found.error) {
      out.push("  ! " + base + ": this release has no same-named asset (nothing to compare against).");
      continue;
    }
    const sum = await sha256File(p, "local file " + base);
    if (sum.error) {
      out.push("  ! " + base + ": " + sum.error);
      continue;
    }
    // 体积先在远端说明里报一次：体积不符本身就是一个独立信号（不必等到摘要比对）。
    const remoteSize = Number(found.asset && found.asset.size);
    const sizeNote =
      Number.isFinite(remoteSize) && remoteSize !== sum.size
        ? " (size differs too: remote " + formatSize(remoteSize) + " vs local " + formatSize(sum.size) + ")"
        : "";
    out.push(compareLine(found.asset, sum.hex) + sizeNote);
  }
  out.push("");
  out.push("note: " + ATTESTATION_LIMIT);
  out.push("note: local files outside the permission root cannot be read (AppHost's Node permission model); that case reports ERR_ACCESS_DENIED, not \"file not found\".");
  return out.join("\n");
}
