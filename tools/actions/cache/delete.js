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
export const summary = "Delete Actions caches (one by id, or a whole family by key)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  id: z.number().int().min(1).optional().describe("Optional: cache id (get it from githana_cache(action=\"list\")) — deletes that one entry"),
  key: z.string().optional().describe("Optional: cache key — deletes the caches for this key; combined with ref it only deletes the ones on that ref. Per GitHub's docs the key parameter is \"key or key prefix\", so it may match several entries or even several different keys"),
  ref: z.string().optional().describe("Optional: restrict the ref (e.g. refs/heads/main); when deleting by key, omitting it deletes across all branches, and that case requires confirm=true"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required to be true when deleting by key without a ref (clears this key across all branches); without it the entries that would be deleted are listed first"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "**Delete** Actions caches in a remote GitHub repository (the next build regenerates them; no code is lost): confirm repo before running, and whether the key has a ref restriction",
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
      label + " argument error: give either id (delete one entry) or key (delete a whole family) — neither was provided.\n" +
      "Start with githana_cache(action=\"list\") to see which caches exist (that is where you get the id and key)."
    );
  }
  if (idIn && keyIn) {
    return label + " argument error: id and key are mutually exclusive (id deletes one entry, key deletes a whole family). Both were provided.";
  }

  // ── 按 id 删一条 ────────────────────────────────────────────────────────
  if (idIn) {
    const r = await callRest(
      [{ method: "DELETE", url: apiUrl(repo, "/actions/caches/" + encodeURIComponent(idIn)), timeoutMs }],
      { timeoutSec },
    );
    if (!r.ok) return label + " execution failed: " + r.message;
    const res = r.results[0];
    // 204 No Content 是成功（删除不返回正文）。
    if (!res || (!res.ok && res.status !== 204)) {
      if (res && res.status === 404) return label + ": repository " + repoLabel + " has no cache with id " + idIn + ".";
      return label + " execution failed: " + describeFailure(res, repoLabel);
    }
    return [
      label + " deleted (" + repoLabel + "):",
      "cache id: " + idIn + " (one entry)",
      "note: deleting a cache only makes the next build regenerate it; no code is lost. To clear all caches for a key use githana_cache(action=\"delete\", key=\"…\").",
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
      label + " confirmation required (nothing deleted yet): deleting by key with **no ref given** clears this key on all branches.",
      "key: " + keyIn + " · repository " + repoLabel,
      "scope: all refs. Currently " + list.length + " match" +
        (list.length ? " (" + formatBytes(totalBytes) + " total · across " + refsTouched.length + " refs)" : "") +
        (before.ok ? "" : "\n(note: the pre-check above failed — " + (before.message || "result unusable") + "; the count may be off.)"),
    ];
    for (const it of list.slice(0, 20)) {
      out.push("  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) + "  " + (it.ref || "?"));
    }
    if (list.length > 20) out.push("  …(" + (list.length - 20) + " more)");
    out.push("The safer option: restrict by ref (ref=\"refs/heads/<branch>\") and only delete the ones on that branch.");
    out.push("To confirm deleting across all branches, resend the same call with confirm=true.");
    return out.join("\n");
  }

  const r = await callRest(
    [{ method: "DELETE", url: apiUrl(repo, "/actions/caches") + "?" + query.join("&"), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    const detail = errorDetail(res);
    if (res && res.status === 404) {
      return (
        label + ": no matching caches (key=" + keyIn + (refIn ? " · ref=" + refIn : "") + " · " + repoLabel + ").\n" +
        "note: per GitHub's docs the key parameter is \"key or key prefix\"; if you are sure that key exists, double-check the full key computed at write time.\nGitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const body = res.json && typeof res.json === "object" ? res.json : {};
  const deleted = Array.isArray(body.actions_caches) ? body.actions_caches : [];
  const count = body.total_count !== undefined ? Number(body.total_count) : deleted.length;
  const out = [
    label + " deleted (" + repoLabel + "):",
    "key: " + keyIn + " · scope: " + (refIn ? "only ref=" + refIn : "all refs (no ref restriction given)"),
    "deleted " + count + (count > 1 ? " (" + [...new Set(deleted.map((it) => String((it && it.ref) || "?")))].length + " refs)" : ""),
  ];
  for (const it of deleted.slice(0, 20)) {
    out.push("  id " + (it.id !== undefined ? it.id : "?") + "  " + formatBytes(it.size_in_bytes) + "  " + (it.ref || "?") + "  created " + fmtTime(it.created_at));
  }
  if (deleted.length > 20) out.push("  …(" + (deleted.length - 20) + " more)");
  out.push("note: deleting a cache only makes the next build regenerate it; no code is lost. To delete a single entry use githana_cache(action=\"delete\", id=<the id above>).");
  return out.join("\n");
}
