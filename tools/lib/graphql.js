// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/graphql.js — GitHub GraphQL 通道（与 REST 同一条 `api.github.com` 上的端点）。
 *
 * 走 tools/lib/rest.js 的 REST worker：GraphQL 只是 `POST /graphql`，载荷是 `{ query, variables }`，
 * 与 REST 的 `body` 同等对待（见 spec gh-cli-parity D5 / AC12）。所以不新增通道、不新增依赖，
 * 也不新增清单能力。
 *
 * 有些动词**只有** GraphQL 能做（`createLinkedBranch` / `pinIssue` / `unpinIssue`），
 * REST 没有等价端点；反之 Actions 全族、release 资产上传只有 REST 有。选哪条是各动作内部的事，
 * 对外一个动词、一份返回结构（AC11）。
 *
 * ## 两类失败的区分
 *
 *   · HTTP 层失败（401 / 403 / 5xx…）→ 复用 REST 的失败说明（含认证引导）；
 *   · HTTP 200 带 `errors` 数组 → GraphQL 的执行期错误（字段不存在、权限不足…），
 *     原文列出，不吞。
 *
 * 两者都**明确报错**，不静默降级（spec 的 Boundary Conditions：需 GraphQL 的能力在无通道时
 * 必须说出来，不能假装成功）。
 */
import { request, apiRoot, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";

/** GraphQL 端点的完整地址（api.github.com/graphql）。 */
export const GRAPHQL_URL = apiRoot("/graphql");

/**
 * 发一次 GraphQL 查询 / 变更。
 *
 * @param {string} query GraphQL 文档
 * @param {object|undefined} variables 变量（可省）
 * @param {{ timeoutSec?: number }} [options]
 * @returns {Promise<{ data?: any, error?: string, errors?: Array<object>, status?: number|null }>}
 */
export async function graphql(query, variables, { timeoutSec } = {}) {
  const payload = variables === undefined ? { query } : { query, variables };
  const r = await request(
    {
      method: "POST",
      url: GRAPHQL_URL,
      json: payload,
      timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
    },
    { timeoutSec },
  );

  // 基础设施失败（worker 缺失 / 网络层 / 白名单拒绝）：status 为 null。
  if (r.status === null) return { status: null, error: "GraphQL call failed: " + (r.error || "unknown error") };

  const body = r.json && typeof r.json === "object" ? r.json : null;

  // HTTP 层失败：GraphQL 在鉴权/限流失败时返回非 2xx，响应体是 REST 那套 `{ message }`。
  if (!r.ok) {
    return { status: r.status, error: "GraphQL rejected (HTTP " + r.status + "): " + errorDetail(r) };
  }
  if (!body) {
    return {
      status: r.status,
      error: "GraphQL response is not JSON (HTTP " + r.status + "): " + String(r.text || "").slice(0, 300),
    };
  }

  // HTTP 200 带 errors：GraphQL 把执行期错误放在这里（data 可能同时有部分结果）。
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length) {
    const lines = errors.map((e) => {
      const path = Array.isArray(e && e.path) ? " (path: " + e.path.join(".") + ")" : "";
      return "  · " + String((e && e.message) || "unknown error") + path;
    });
    return {
      status: r.status,
      errors,
      error:
        "GraphQL returned " + errors.length + " error(s):\n" + lines.join("\n") +
        "\n(field and input shapes are defined by the GitHub GraphQL docs; if you really must build one yourself, use githana_api against /graphql.)",
    };
  }
  return { status: r.status, data: body.data };
}
