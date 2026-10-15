// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/release.js — githana_release 各动词共用的定位、取值域与渲染。
 *
 * 跨名词共用（仓库上下文、失败说明、时间渲染）在 tools/lib/gh.js；这里只放 **release 专有**
 * 的部分：tag 与 asset 的定位、`latest` 的三值、状态位渲染、条目一行排版，以及「按 tag / 按
 * id 定位一个 release」这一跳——view / delete / delete-asset / upload / download / verify /
 * verify-asset 都要它。
 *
 * ## tag 与 id 都能定位，但只有 tag 是用户手上的那个
 *
 * GitHub 的 release 有两个键：数字 `id`（写入面用它）与 `tag_name`（人认它）。gh 的
 * `release view [<tag>]` 按 tag 走，所以本工具以 **tag 为主键**；`GET /releases/{id}` 与
 * `GET /releases/tags/{tag}` 返回同一形状，所以两条路都留着，报错文案统一指向 tag。
 *
 * ## `latest` 是三值，不是布尔
 *
 * `make_latest` 收 `true` / `false` / `legacy`（GitHub 的原话：`legacy` = 「使用旧式算法决定
 * 哪个 release 是 latest」）。`legacy` 不是「删除 latest 标记」——把它当 `false` 处理就改了语义。
 * 取值域的声明在 actions/release/create.js 的 `latest`（enum）；这里只把三个值渲染成可读串。
 * 改状态位的 `edit` 走 PATCH 端点（按 release id），不经过这一跳，所以它不在上文的「都要它」之列。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";
import { describeFailure } from "./gh.js";

/** `make_latest` 取值域（REST 的 PATCH /releases/{id}）。 */
export const MAKE_LATEST_VALUES = ["true", "false", "legacy"];

/** `make_latest` 三值 → 可读串。 */
export function makeLatestText(value) {
  const v = value !== undefined && value !== null ? String(value) : "";
  const map = { true: "是（true）", false: "否（false）", legacy: "旧式算法（legacy）" };
  return map[v] || (v || "未提供");
}

/**
 * 状态位渲染：draft / prerelease / latest。
 *
 * `latest` 只有是 true 时才报——GitHub 的 release 表示里 `latest` 是布尔（当前是否为该仓库的
 * latest），false 是缺省态，逐条打「latest=false」只是噪声。
 */
export function releaseFlags(rel) {
  const r = rel && typeof rel === "object" ? rel : {};
  const flags = [];
  if (r.draft) flags.push("草稿 draft");
  if (r.prerelease) flags.push("预发布 prerelease");
  if (r.latest === true) flags.push("latest");
  return flags;
}

/** 只到日期的渲染（列表行里精确到分钟是噪声）。 */
function dateOnly(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** release 条目一行（list 用）：`tag  标题  [状态位]  日期`。 */
export function releaseLine(rel) {
  const r = rel && typeof rel === "object" ? rel : {};
  const flags = releaseFlags(r);
  const at = r.published_at || r.created_at;
  return (
    "  " + (r.tag_name || "?") +
    "  " + (r.name || "（无标题）") +
    (flags.length ? "  [" + flags.join(" · ") + "]" : "") +
    (at ? "  " + dateOnly(at) : "")
  );
}

/** 字节 → 可读（release 的体积字段都以字节给）。 */
export function formatSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}

/** asset 条目一行（view / download / verify-asset 共用）。 */
export function assetLine(asset) {
  const a = asset && typeof asset === "object" ? asset : {};
  const size = a.size !== undefined ? "  " + formatSize(a.size) : "";
  const downloads = a.download_count !== undefined ? "  下载 " + a.download_count : "";
  return "  " + (a.name || "?") + size + downloads + (a.state && a.state !== "uploaded" ? "  [" + a.state + "]" : "");
}

/** 资产列表的排版（找不到目标时列出全部，供调用方改参数）。 */
export function assetListText(list) {
  if (!Array.isArray(list) || list.length === 0) return "  （这个 release 没有任何资产）";
  return list.map(assetLine).join("\n");
}

/**
 * 按 tag 定位 release（`GET /repos/{o}/{r}/releases/tags/{tag}`）。
 *
 * tag 逐段编码：GitHub 的 tag 允许含 `/`（如 `release/v1.0`），整串编码会把分隔符也编掉。
 *
 * @returns {Promise<{ release: object } | { error: string, notFound?: boolean }>}
 */
export async function fetchReleaseByTag(repo, repoLabel, tag, timeoutSec, label) {
  const url = apiUrl(repo, "/releases/tags/" + tag.split("/").map(encodeURIComponent).join("/"));
  const r = await callRest([{ url, timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }], { timeoutSec });
  if (!r.ok) return { error: label + " 执行失败：" + r.message };
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return { error: label + "：仓库 " + repoLabel + " 里没有 tag 为 " + tag + " 的 release。", notFound: true };
    }
    return { error: label + " 执行失败：" + describeFailure(res, repoLabel) };
  }
  return { release: res.json && typeof res.json === "object" ? res.json : {} };
}

/**
 * 定位一个 release：`releaseId` 优先，其次 `tag`，都没有则取「最近发布的」。
 *
 * @param {object} input 工具入参（读 input.releaseId / input.tag）
 * @param {{ repo: string, repoLabel: string, timeoutSec: * }} c resolveContext 的结果
 * @param {string} label 报错前缀（工具名(action)）
 * @param {{ required?: boolean }} [opts] required=true 时缺 tag 即报错（不回落「最近一个」）
 * @returns {Promise<{ release: object } | { error: string }>}
 */
export async function locateRelease(input, c, label, opts = {}) {
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const releaseId = input && input.releaseId !== undefined && input.releaseId !== null ? String(input.releaseId).trim() : "";
  const tag = input && input.tag !== undefined && input.tag !== null ? String(input.tag).trim() : "";

  if (releaseId) {
    const r = await callRest([{ url: apiUrl(repo, "/releases/" + encodeURIComponent(releaseId)), timeoutMs }], { timeoutSec });
    if (!r.ok) return { error: label + " 执行失败：" + r.message };
    const res = r.results[0];
    if (!res || !res.ok) {
      if (res && res.status === 404) return { error: label + "：仓库 " + repoLabel + " 里没有 id 为 " + releaseId + " 的 release。" };
      return { error: label + " 执行失败：" + describeFailure(res, repoLabel) };
    }
    return { release: res.json && typeof res.json === "object" ? res.json : {} };
  }

  if (!tag) {
    if (opts.required) {
      return {
        error:
          label + " 参数错误：tag 必填（要操作哪个 release）。\n" +
          "先看有哪些：githana_release(action=\"list\")。",
      };
    }
    // 缺省取**最近一次发布**（`/releases/latest` 只算非 draft 非 prerelease 的，没有就 404）。
    const r = await callRest([{ url: apiUrl(repo, "/releases/latest"), timeoutMs }], { timeoutSec });
    if (!r.ok) return { error: label + " 执行失败：" + r.message };
    const res = r.results[0];
    if (!res || !res.ok) {
      if (res && res.status === 404) {
        return {
          error:
            label + "：仓库 " + repoLabel + " 没有「最近发布的」release（latest 只算非草稿、非预发布的）。\n" +
            "请显式传 tag。",
        };
      }
      return { error: label + " 执行失败：" + describeFailure(res, repoLabel) };
    }
    return { release: res.json && typeof res.json === "object" ? res.json : {} };
  }

  return fetchReleaseByTag(repo, repoLabel, tag, timeoutSec, label);
}

/**
 * 在 release 里找一个资产：`assetName` 优先，其次 `assetId`。
 *
 * 不额外发请求——release 表示里已经内嵌了 `assets` 数组（每个含 id / name / size / state /
 * download_count）。要看 `browser_download_url` 或 `digest` 才需要单独取一次该 asset。
 *
 * @returns {{ asset: object, list: Array<object> } | { error: string, list: Array<object> }}
 */
export function findAsset(release, input) {
  const list = release && Array.isArray(release.assets) ? release.assets : [];
  const assetId = input && input.assetId !== undefined && input.assetId !== null ? String(input.assetId).trim() : "";
  const name = input && input.assetName !== undefined && input.assetName !== null ? String(input.assetName).trim() : "";

  if (assetId) {
    const hit = list.find((a) => a && String(a.id) === assetId);
    if (!hit) return { error: "assetId " + assetId + " 不在这个 release 的资产列表里。", list };
    return { asset: hit, list };
  }
  if (name) {
    const hit = list.find((a) => a && String(a.name) === name);
    if (!hit) return { error: "这个 release 里没有名为 " + name + " 的资产。", list };
    return { asset: hit, list };
  }
  return { error: "需要 assetName（或 assetId）来指定是哪个资产。", list };
}
