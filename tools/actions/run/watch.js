// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/watch — 阶段 2 的能力空洞，本期只在**保留位**里留位置（不入 action 表）。
 *
 * ## 为什么与 rerun / workflow run 不同档
 *
 * 三者看起来都是「让 CI 跑起来」，但返回契约分成两类：
 *
 *   · **同步触发**（`run rerun` / `workflow run`）——发一个请求，GitHub 收下，回执里写「已触发」
 *     （外加一个 URL / 编号）。调用在几秒内结束，返回的是**结果**。这一档本期实现。
 *   · **任务型**（`run watch`）——「等它到终态」不能占着工具回调等：宿主的工具回调有超时，
 *     长轮询会堵住整条通道（spec 的 AC10 第一条纪律：工具回调内不等）。正确形态是**返回句柄**，
 *     由宿主后台任务在 CI 到终态时把结论回投来源会话——那是 AC8 / AC9 的
 *     `ctx.tasks.create({ scope: "session", delivery: "next-step", chipVisibility: "show" })`，
 *     要 manifest 新增 `app/tasks.manage`（D8 的唯一新增能力）。返回契约因此不同：
 *     一个句柄（可被 `ctx.tasks.list()` 恢复、可被会话取消）而不是一份结论。
 *
 * 参数契约与返回契约都还没定，所以它**不入 enum**（同 release/edit）。把「返回句柄」这个形态
 * 混进一个返回文本的工具候选里，只会让模型以为它是一个可以拿到结论的动词。
 *
 * ## 本期调用的实际回报
 *
 * 走到 surface.js 的 reserved 分支，回
 * `githana_run（action=watch）未实现：<RESERVED_NOTE>`，并列出可用 action。
 *
 * 现在要看 CI 到没到终态：`githana_run(action="view")` 回报**此刻**的 run 与各作业状态——
 * 那是「此刻」，不是「等它跑完」；等它跑完得自己隔一会儿再 view 一次。
 */

/** 保留位说明（由 githana-run.js 喂给 createSurface 的 reserved）。 */
export const RESERVED_NOTE =
  "等 CI 到终态属于阶段 2 的能力空洞，本期不实现。" +
  "形态是宿主后台任务（返回任务句柄、CI 到终态时回投来源会话，见 spec 的 AC8–AC10），" +
  "需要 manifest 新增 app/tasks.manage——本批不动清单，且返回契约要能容纳「返回句柄而非结果」这一档。" +
  "本期要看 CI 状态用 githana_run(action=\"view\") 看此刻的 run 与作业状态（隔一会儿再看一次就是轮询）。";
