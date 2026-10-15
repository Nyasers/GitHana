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
export const summary = "把另一个仓库的标签整套搬过来";

export const schema = {
  repo: params.repo.describe("可选：**目标**仓库（标签落到这里），格式 owner/repo；缺省从 cwd 推断"),
  cwd: params.cwdOptional,
  fromRepo: z.string().describe("必填：**源**仓库，格式 owner/repo（从它取标签）"),
  force: z
    .boolean()
    .optional()
    .describe("可选：true 时把目标仓库已有的同名标签也改成与源一致（颜色 / 描述）；默认只建缺失的，已有的跳过"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "把源仓库的标签整套搬进目标仓库（新建缺失的标签；force=true 时会改写目标仓库已有的同名标签）：批量修改 GitHub 远端状态，执行前请确认源与目标仓库",
  ruleId: "github-toolkit-label-clone",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const fromRaw = input?.fromRepo !== undefined && input?.fromRepo !== null ? String(input.fromRepo).trim() : "";
  if (!fromRaw) return label + " 参数错误：fromRepo 必填（源仓库，格式 owner/repo）。";
  const parts = fromRaw.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return label + " 参数错误：fromRepo 格式非法（收到：" + fromRaw + "）。要求 owner/repo。";
  }
  const source = parts[0].trim() + "/" + parts[1].trim();
  if (source.toLowerCase() === repo.toLowerCase()) {
    return label + " 参数错误：fromRepo 与 repo 是同一个仓库（" + source + "），没有可搬的东西。";
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
  if (!first.ok) return label + " 执行失败：" + first.message;
  const srcRes = first.results.find((x) => x.id === "src");
  const dstRes = first.results.find((x) => x.id === "dst");
  if (!srcRes || !srcRes.ok) {
    if (srcRes && srcRes.status === 404) return label + "：源仓库 " + source + " 不存在或令牌不可见。";
    return label + " 执行失败（读源仓库标签）：" + describeFailure(srcRes, source);
  }
  if (!dstRes || !dstRes.ok) return label + " 执行失败（读目标仓库标签）：" + describeFailure(dstRes, repoLabel);

  const srcLabels = Array.isArray(srcRes.json) ? srcRes.json : [];
  const dstLabels = Array.isArray(dstRes.json) ? dstRes.json : [];
  if (srcLabels.length === 0) return label + "：源仓库 " + source + " 没有任何标签，没有可搬的。";

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
      label + "：无需改动（" + repoLabel + " 已经与 " + source + " 一致）。",
      "源标签 " + srcLabels.length + " 个 · 目标已有 " + dstLabels.length + " 个" +
      (force ? "" : "（已有的同名标签默认跳过；要改成与源一致请传 force=true）") + "。",
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
  if (!second.ok) return label + " 执行失败：" + second.message;

  const okIds = second.results.filter((x) => x.ok).map((x) => x.id);
  const failed = second.results.filter((x) => !x.ok);
  const createdOk = okIds.filter((id) => id.startsWith("create:")).length;
  const updatedOk = okIds.filter((id) => id.startsWith("update:")).length;

  const out = [
    label + " 已执行（" + source + " → " + repoLabel + "）：",
    "新建 " + createdOk + " / " + toCreate.length + " 个 · 更新 " + updatedOk + " / " + toUpdate.length + " 个（force=" + force + "）",
    "跳过 " + (srcLabels.length - toCreate.length - toUpdate.length) + " 个目标仓库已有的同名标签。",
  ];
  if (failed.length) {
    out.push("失败 " + failed.length + " 个：");
    for (const f of failed.slice(0, 10)) {
      out.push("  · " + f.id + "：HTTP " + f.status + " " + errorDetail(f));
    }
    if (failed.length > 10) out.push("  ·（其余 " + (failed.length - 10) + " 个略）");
    out.push("提示：新建失败常见原因是同名标签已存在（并发下目标仓库刚被别处建好）或颜色格式不合法。");
  }
  out.push("核对：githana_label(action=\"list\", repo=\"" + repo + "\")。");
  return out.join("\n");
}
