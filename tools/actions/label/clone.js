// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * label/clone：把一个仓库的标签整套搬到另一个仓库（githana_label 动词）。
 *
 * gh `label clone <源仓库>` 的对应物。REST 没有"复制标签"的端点，所以本动词按 gh 的语义编排：
 *   · 取源仓库的标签全集（`GET /repos/{src}/labels`，分页合并）；
 *   · 取目标仓库的现有标签；
 *   · **缺的建**（`POST /repos/{dst}/labels`），**已有的跳过**；
 *   · `force=true` 时才把已有的也改成与源一致（`PATCH /repos/{dst}/labels/{name}`）。
 *
 * 默认跳过而不是覆盖：搬标签最常见的用途是"新仓库先铺一套"，那时目标里已有的那几个是**有意
 * 保留**的本地差异；无条件覆盖会把它们抹掉。所以要覆盖得显式说。
 *
 * 目标是**当前仓库**（repo 指的那个），源是 `fromRepo`：与 gh 一致（`gh label clone <源>`
 * 在当前目录的仓库上落地），但这里不做目录推断，两个仓库都显式给。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";

export const command = "clone";
export const summary = "Copy another repository's whole label set over";

export const schema = {
  repo: params.repo.describe("Optional: the **target** repository (labels land here), in owner/repo form; defaults to inferring from cwd"),
  cwd: params.cwdOptional,
  fromRepo: z.string().describe("Required: the **source** repository, in owner/repo form (labels are taken from it)"),
  force: z
    .boolean()
    .optional()
    .describe("Optional: when true, also rewrite same-named labels already present in the target repository to match the source (color / description); by default only missing ones are created and existing ones are skipped"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "Copy the source repository's whole label set into the target repository (missing labels are created; with force=true, same-named labels already in the target repository are rewritten): bulk-modifies remote GitHub state, confirm the source and target repositories before running",
  ruleId: "github-toolkit-label-clone",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const fromRaw = input?.fromRepo !== undefined && input?.fromRepo !== null ? String(input.fromRepo).trim() : "";
  if (!fromRaw) return label + " argument error: fromRepo is required (the source repository, in owner/repo form).";
  const parts = fromRaw.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return label + " argument error: fromRepo is malformed (received: " + fromRaw + "). Expected owner/repo.";
  }
  const source = parts[0].trim() + "/" + parts[1].trim();
  if (source.toLowerCase() === repo.toLowerCase()) {
    return label + " argument error: fromRepo and repo are the same repository (" + source + "); there is nothing to copy.";
  }

  const force = input?.force === true;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  // 第一轮：取源标签全集与目标现有标签。
  const first = await callRest(
    [
      { id: "src", url: apiUrl(source, "/labels") + "?per_page=100", timeoutMs, paginate: true },
      { id: "dst", url: apiUrl(repo, "/labels") + "?per_page=100", timeoutMs, paginate: true },
    ],
    { timeoutSec },
  );
  if (!first.ok) return label + " execution failed: " + first.message;
  const srcRes = first.results.find((x) => x.id === "src");
  const dstRes = first.results.find((x) => x.id === "dst");
  if (!srcRes || !srcRes.ok) {
    if (srcRes && srcRes.status === 404) return label + ": source repository " + source + " does not exist or is not visible to the token.";
    return label + " execution failed (reading source repository labels): " + describeFailure(srcRes, source);
  }
  if (!dstRes || !dstRes.ok) return label + " execution failed (reading target repository labels): " + describeFailure(dstRes, repoLabel);

  const srcLabels = Array.isArray(srcRes.json) ? srcRes.json : [];
  const dstLabels = Array.isArray(dstRes.json) ? dstRes.json : [];
  if (srcLabels.length === 0) return label + ": source repository " + source + " has no labels at all; there is nothing to copy.";

  const dstByName = new Map();
  for (const l of dstLabels) if (l && l.name) dstByName.set(String(l.name).toLowerCase(), l);

  const toCreate = [];
  const toUpdate = [];
  for (const l of srcLabels) {
    if (!l || !l.name) continue;
    const existing = dstByName.get(String(l.name).toLowerCase());
    if (!existing) toCreate.push(l);
    else if (force) toUpdate.push({ existing, src: l });
  }

  if (toCreate.length === 0 && toUpdate.length === 0) {
    return [
      label + ": no changes needed (" + repoLabel + " already matches " + source + ").",
      "source labels: " + srcLabels.length + " · target already has " + dstLabels.length +
      (force ? "" : " (same-named labels already present are skipped by default; to rewrite them to match the source pass force=true)") + ".",
    ].join("\n");
  }

  // 第二轮：建缺失的 / 改同名标签（force）。
  const batch = [];
  for (const l of toCreate) {
    batch.push({
      id: "create:" + l.name,
      method: "POST",
      url: apiUrl(repo, "/labels"),
      json: { name: String(l.name), color: String(l.color || ""), description: l.description ? String(l.description) : "" },
      timeoutMs,
    });
  }
  for (const u of toUpdate) {
    batch.push({
      id: "update:" + u.existing.name,
      method: "PATCH",
      url: apiUrl(repo, "/labels/" + encodeURIComponent(String(u.existing.name))),
      json: { new_name: String(u.src.name), color: String(u.src.color || ""), description: u.src.description ? String(u.src.description) : "" },
      timeoutMs,
    });
  }

  const second = await callRest(batch, { timeoutSec });
  if (!second.ok) return label + " execution failed: " + second.message;

  const okIds = second.results.filter((x) => x.ok).map((x) => x.id);
  const failed = second.results.filter((x) => !x.ok);
  const createdOk = okIds.filter((id) => id.startsWith("create:")).length;
  const updatedOk = okIds.filter((id) => id.startsWith("update:")).length;

  const out = [
    label + " done (" + source + " → " + repoLabel + "):",
    "created " + createdOk + " / " + toCreate.length + " · updated " + updatedOk + " / " + toUpdate.length + " (force=" + force + ")",
    "skipped " + (srcLabels.length - toCreate.length - toUpdate.length) + " same-named labels already present in the target repository.",
  ];
  if (failed.length) {
    out.push(failed.length + " failed:");
    for (const f of failed.slice(0, 10)) {
      out.push("  · " + f.id + ": HTTP " + f.status + " " + errorDetail(f));
    }
    if (failed.length > 10) out.push("  · (" + (failed.length - 10) + " more omitted)");
    out.push("hint: creations usually fail because a same-named label already exists (the target repository may have just been given one concurrently) or because the color format is invalid.");
  }
  out.push("verify with: githana_label(action=\"list\", repo=\"" + repo + "\").");
  return out.join("\n");
}
