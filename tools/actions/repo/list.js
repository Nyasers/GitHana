// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/list：列出仓库（githana_repo 动词）。
 *
 * 两个面二选一，由 `owner` 决定：
 *   · 缺省 → `GET /user/repos`（当前令牌能看到的自己的仓库，含作为协作者的那些）；
 *   · 给了 `owner` → `GET /users/{owner}/repos`（该用户的公开仓库）。
 *
 * **不给 `GET /orgs/{org}/repos` 留位置**：organization 权限本 App 一项未申请（D7），那条路只会
 * 403；组织的仓库要列就在 `owner` 里写组织名走 `/users/{owner}/repos`（公开可见的那部分）。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiRoot, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { requireAuth, describeFailure, fmtTime } from "../../lib/gh.js";

export const command = "list";
export const summary = "列出仓库（自己 / 指定 owner）";

export const schema = {
  owner: z.string().optional().describe("可选：用户或组织名；缺省列当前登录账号可访问的仓库"),
  visibility: z.enum(["all", "public", "private"]).optional().describe("仅 owner 缺省时生效：all（默认）/ public / private"),
  // 上限 100 不写成 max：超过上限在 run() 是**收敛到 100**（GitHub 单页上限），收紧成拒绝会改语义。
  limit: z.number().int().min(1).optional().describe("返回条数，默认 30，上限 100（超过上限收敛到 100）"),
  timeoutSec: params.timeoutSec,
};

/** 模型面专属（不参与运行期校验）：补上"上限 100"这个提示；运行期超过上限是收敛而不是拒绝。 */
export const modelFields = {
  limit: z.number().int().min(1).max(100).describe("返回条数，默认 30，上限 100（超过上限收敛到 100）"),
};

export async function run(input, ctx, { label }) {
  const authErr = requireAuth(label);
  if (authErr) return authErr;

  const owner = input?.owner !== undefined && input?.owner !== null ? String(input.owner).trim() : "";
  const timeoutSec = input?.timeoutSec;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  let limit = 30;
  if (input?.limit !== undefined && input?.limit !== null) limit = Math.min(100, input.limit);

  // 取值域由 schema 保证（enum）；这里只做缺省。
  const visibility = owner === "" ? String(input?.visibility || "all") : "";

  // 查询串直接拼在 path 里（rest.js 的 apiRoot 只负责加主机与前导斜杠）。
  const query = ["sort=updated", "direction=desc", "per_page=" + String(limit)];
  if (owner === "") query.push("visibility=" + encodeURIComponent(visibility));
  const path = (owner !== "" ? "/users/" + encodeURIComponent(owner) + "/repos" : "/user/repos") + "?" + query.join("&");
  const url = apiRoot(path);

  const r = await callRest([{ url, timeoutMs }], { timeoutSec });
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + "：用户或组织 " + owner + " 不存在（或不可见）。";
    }
    return label + " 执行失败：" + describeFailure(res, owner || "（当前账号）");
  }

  const items = Array.isArray(res.json) ? res.json : [];
  const scope = owner !== "" ? "@" + owner + " 的公开仓库" : "当前账号可访问的仓库（visibility=" + visibility + "）";
  if (items.length === 0) return label + "（" + scope + "）：没有匹配的仓库。";

  const out = [label + "（" + scope + " · " + items.length + " 条 · 按最后更新倒序）："];
  for (const it of items) {
    out.push(
      (it.private ? "[private] " : "[public]  ") + (it.full_name || "?") +
      (it.archived ? "（已归档）" : "") + (it.fork ? "（fork）" : ""),
    );
    out.push("  " + (it.description || "（无简介）"));
    out.push(
      "  默认分支 " + (it.default_branch || "?") + " · 更新 " + fmtTime(it.pushed_at || it.updated_at) +
      (it.language ? " · " + it.language : ""),
    );
    if (it.html_url) out.push("  " + it.html_url);
  }
  return out.join("\n");
}
