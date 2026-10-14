// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * release/edit — 阶段 2 的能力空洞，本期只在**保留位**里留位置（不入 action 表）。
 *
 * ## 为什么它不入 enum（与 upload / download 那一档的差别）
 *
 * `createSurface` 的 `reserved` 只吃「不在 action 表里」的值：`execute` 先查 `byCommand`，
 * 查不到才查 `reserved`。所以「入 enum」与「只留 reserved 文案」是两种不同的留位形态，
 * 按**参数形态定没定**分：
 *
 *   · `upload` / `download` / `verify` / `verify-asset` / `run download`——参数形态是清楚的
 *     （文件路径、tag、资产名…），只是本期跑不通。它们进 action 表、进模型面的候选，
 *     调用时给出**具体**的限制与替代路径。候选里有它，好处是「受限原因可见」。
 *   · `release edit`（本文件）与 `run watch`——连参数契约都还没定：
 *     AC7 要 `edit` 改 `draft` / `prerelease` / `latest` 三个状态位，而 `latest` 取
 *     `true|false|legacy` 三值、且要走 `make_latest`；`watch` 要返回**任务句柄**（AC8–AC10），
 *     那是一个与「返回结果」不同的返回契约，还要 `app/tasks.manage`（D8 唯一的新增能力，
 *     而本批**不动 manifest**）。
 *
 *   把参数还没定的动词塞进候选，只是给模型一个试错的入口；它既不能在候选摘要里说清怎么用，
 *   调用也只能得到「未实现」。所以这一档只留 reserved 文案——它与 AC5「未知 action 报错并列出
 *   可用值」不冲突：那种报错发生在 reserved 也查不到时。
 *
 * ## 本期调用的实际回报
 *
 * 走到 surface.js 的 reserved 分支，回：
 *   `githana_release（action=edit）未实现：<本文件的 RESERVED_NOTE>\n可用 action：…`
 * ——明确回报，不静默失败。
 *
 * 阶段 2 实现它时，本文件改成真正的 action 模块（`command` / `summary` / `schema` / `run` /
 * `sideEffect`），并把它加进 githana-release.js 的 ACTIONS、从 RESERVED 里删掉。
 */

/** 保留位说明（由 githana-release.js 喂给 createSurface 的 reserved）。 */
export const RESERVED_NOTE =
  "改发布的状态位（draft / prerelease / latest）属于阶段 2 的能力空洞，本期不实现。" +
  "参数契约还没定：latest 取 true|false|legacy 三值（REST 的 make_latest），" +
  "而 legacy（旧式算法）这一支的行为要先核实。本期要改这些状态位请到 GitHub 网页的 releases 页，" +
  "或走 githana_api 打 PATCH /repos/{owner}/{repo}/releases/{id}（端点可达、写法自担）。";
