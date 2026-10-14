// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * cache/delete：删除 Actions 缓存（githana_cache 动词）。
 *
 * ## 两条端点，按定位方式选
 *
 *   · `DELETE /repos/{o}/{r}/actions/caches/{cache_id}` —— 删**一条**（按 `id`）；
 *   · `DELETE /repos/{o}/{r}/actions/caches?key=<key>&ref=<ref>` —— 删**一族**
 *     （GitHub 文档：Deletes one or more caches matching the specified parameters），
 *     返回体里带 `total_count` 与 `actions_caches`（删掉的那些）。
 *
 * 所以本动词按「给了 id 还是给了 key」选端点，并把删掉的条数如实回报——「删一族」这条路上，
 * 回执里的条数是调用方唯一能看到的现场（删完就没得查了）。
 *
 * ## 为什么按 key 删要 `ref`
 *
 * 缓存 key 会跨分支重名（同一段构建逻辑在不同分支上算出同一个 key）。只给 key 会把这个 key
 * 在**所有** ref 上的缓存一起删掉——那通常不是调用方想要的（它会静默清掉别人的构建缓存）。
 * 所以：
 *   · `ref` 显式给了 → 只删该 ref 上的；
 *   · 没给 `ref` → 需要 `confirm=true` 才真删（缺它就返回引导，并**先列出**会被删的那些），
 *     因为「跨所有分支清掉一个 key」是比「清我这个分支的」重一档的动作。
 *
 * ## 与 run/delete 的分界
 *
 * 缓存是「构建过程的副产物」，删它只让下一次构建慢一点；run 记录与日志是「事实记录」，删了
 * 就没得查。后者要 `confirm=true` 是那个理由；本动词只在「跨 ref 删一族」时才要它。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { formatBytes } from "../../lib/ci.js";

export const command = "delete";
export const summary = "删除 Actions 缓存（按 id 删一条，或按 key 删一族）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  id: z.number().int().min(1).optional().describe("可选：缓存 id（从 githana_cache(action=\"list\") 取）——删这一条"),
  key: z.string().optional().describe("可选：缓存 key——删这个 key 的缓存；配 ref 只删该 ref 上的。GitHub 的 key 参数按文档是「key 或 key 前缀」，所以它可能匹配到多条甚至多个不同的 key"),
  ref: z.string().optional().describe("可选：限定的 ref（如 refs/heads/main）；按 key 删时不给它会跨所有分支删，那种情况需要 confirm=true"),
  confirm: z
    .boolean()
    .optional()
    .describe("按 key 删且未给 ref 时必须为 true（会跨所有分支清掉这个 key）；缺它会先列出将被删的那些"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "**删除** GitHub 远端仓库的 Actions 缓存（下一次构建会重新生成，不会丢代码）：执行前请确认 repo，以及 key 是否给了 ref 限定",
  ruleId: "github-toolkit-cache-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const idIn = input?.id !== undefined && input?.id !== null ? String(input.id).trim() : "";
  const keyIn = input?.key !== undefined && input?.key !== null ? String(input.key).trim() : "";
  const refIn = input?.ref !== undefined && input?.ref !== null ? String(input.ref).trim() : "";

  if (!idIn && !keyIn) {
    return (
      label + " 参数错误：要么给 id（删一条），要么给 key（删一族）——两者都没有。\n" +
      "先用 githana_cache(action=\"list\") 看有哪些缓存（那里能拿到 id 与 key）。"
    );
  }
  if (idIn && keyIn) {
    return label + " 参数错误：id 与 key 只能给一个（id 删一条，key 删一族）。当前两者都给了。";
  }

  // ── 按 id 删一条 ────────────────────────────────────────────────────────
  if (idIn) {
    const r = await callRest(
      [{ method: "DELETE", url: apiUrl(repo, "/actions/caches/" + encodeURIComponent(idIn)), timeoutMs }],
      { timeoutSec },
    );
    if (!r.ok) return label + " 执行失败：" + r.message;
    const res = r.results[0];
    // 204 No Content 是成功（删除不返回正文）。
    if (!res || (!res.ok && res.status !== 204)) {
      if (res && res.status === 404) return label + "：仓库 " + repoLabel + " 里没有 id 为 " + idIn + " 的缓存。";
      return label + " 执行失败：" + describeFailure(res, repoLabel);
    }
    return [
      label + " 已删除（" + repoLabel + "）：",
      "缓存 id：" + idIn + "（一条）",
      "说明：删缓存只让下一次构建重新生成它，不丢代码。要清掉某个 key 的全部缓存用 githana_cache(action=\"delete\", key=\"…\")。",
    ].join("\n");
  }

  // ── 按 key 删一族 ──────────────────────────────────────────────────────
  const query = ["key=" + encodeURIComponent(keyIn)];
  if (refIn) query.push("ref=" + encodeURIComponent(refIn));

  // 先取一次将被删的那些：跨 ref 删的确认引导要有现场（删完就查不到了）。
  const before = await callRest(
    [
      {
        url: apiUrl(repo, "/actions/caches") + "?key=" + encodeURIComponent(keyIn) + (refIn ? "&ref=" + encodeURIComponent(refIn) : ""),
        timeoutMs,
      },
    ],
    { timeoutSec },
  );
  const list = before.ok && before.results[0] && before.results[0].ok && before.results[0].json && Array.isArray(before.results[0].json.actions_caches)
    ? before.results[0].json.actions_caches
    : [];
  const totalBytes = list.reduce((sum, it) => sum + (Number(it && it.size_in_bytes) || 0), 0);
  const refsTouched = [...new Set(list.map((it) => String((it && it.ref) || "?")))];

  if (!refIn && input?.confirm !== true) {
    const out = [
      label + " 需要确认（未执行删除）：按 key 删且**没给 ref**，会把所有分支上的这个 key 一起清掉。",
      "key：" + keyIn + " · 仓库 " + repoLabel,
      "范围：全部 ref。当前匹配到 " + list.length + " 条" +
        (list.length ? "（合计 " + formatBytes(totalBytes) + " · 涉及 " + refsTouched.length + " 个 ref）" : "") +
        (before.ok ? "" : "\n（注意：上面这次预查失败了——" + (before.message || "结果不可用") + "，条数可能不准。）"),
    ];
    for (const it of list.slice(0, 20)) {
      out.push("  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) + "  " + (it.ref || "?"));
    }
    if (list.length > 20) out.push("  …（还有 " + (list.length - 20) + " 条）");
    out.push("更保险的做法：给 ref 限定（ref=\"refs/heads/<分支>\"），只删那个分支上的。");
    out.push("确认要跨所有分支删，请重发同一次调用并带上 confirm=true。");
    return out.join("\n");
  }

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/actions/caches") + "?" + query.join("&"), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 404) {
      return (
        label + "：没有匹配的缓存（key=" + keyIn + (refIn ? " · ref=" + refIn : "") + " · " + repoLabel + "）。\n" +
        "注意：GitHub 的 key 参数按文档是「key 或 key 前缀」，若确认该 key 存在，请核对写入时算出的完整 key。\nGitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const deleted = Array.isArray(body.actions_caches) ? body.actions_caches : [];
  const count = body.total_count !== undefined ? Number(body.total_count) : deleted.length;
  const out = [
    label + " 已删除（" + repoLabel + "）：",
    "key：" + keyIn + " · 范围：" + (refIn ? "仅 ref=" + refIn : "全部 ref（未给 ref 限定）"),
    "删掉 " + count + " 条" + (count > 1 ? "（" + [...new Set(deleted.map((it) => String((it && it.ref) || "?")))].length + " 个 ref）" : ""),
  ];
  for (const it of deleted.slice(0, 20)) {
    out.push("  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) + "  " + (it.ref || "?") + "  创建 " + fmtTime(it.created_at));
  }
  if (deleted.length > 20) out.push("  …（还有 " + (deleted.length - 20) + " 条）");
  out.push("说明：删缓存只让下一次构建重新生成它，不丢代码。要删单条用 githana_cache(action=\"delete\", id=<上面的 id>)。");
  return out.join("\n");
}
