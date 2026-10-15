// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/api-source.mjs — `githana_api` 参考件的上游数据源声明
//
// 两个脚本共用这一份：`fetch-permission-table.mjs` 按它拉取，`api-reference.mjs` 按它读缓存。
// 分开放着会各写一遍 URL 与版本段，改一处漏一处就是「拉的与读的不是同一份」。
//
// ## 版本段钉死
//
// URL 里的 `fpt-2026-03-10` 是 GitHub 的 API 版本段，**不跟随 main**：上游改版时目录名会变，
// 静默跟随会让参考件内容某天一整个变样而没有触发点。升级是有意动作——改这里、重拉、看清 diff。

/** GitHub 的 API 版本段（`fpt` = Free/Pro/Team 云版；另有 ghec / ghes-* 各版本）。 */
export const API_VERSION = "fpt-2026-03-10";

/**
 * 上游表：**按权限索引端点**。
 *
 * 选它的理由（而不是全量 OpenAPI）：它的语义就是「for each permission granted, these are the
 * REST API endpoints that the app can use」——正好是「持有该权限 ⇒ 这些端点可用」，
 * 筛选一步到位，且不必猜 GitHub 的 OR/AND 语义（同一端点出现在多个权限下即任一满足）。
 */
export const SOURCE = `https://raw.githubusercontent.com/github/docs/main/src/github-apps/data/${API_VERSION}/server-to-server-permissions.json`;

/** 本地缓存（`.tmp*` 已被 .gitignore 覆盖，不入库）：上游数据的快照，随时可重拉。 */
export const CACHE_DIR = ".tmp/permission-table";
export const CACHE_FILE = `${CACHE_DIR}/server-to-server-permissions.json`;
