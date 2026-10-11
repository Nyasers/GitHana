// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/err-text.mjs — 抛出值 → 可读文本（脚本域 catch 到的形状统一走这里）。
//
// 为什么单独成文件：`catch (e)` 拿到的可能是 Error、字符串、或任意抛出值。到处写
// `e && e.message` 会在不同脚本里给出不同形状（有的漏掉字符串抛出值，显示成 "[object Object]"
// 或空串）。收敛成一处，日志与退出信息才是同一个口径。

/** 取错误的可读文本：有 message 用之，否则 String(e)（含 throw 原始值/字符串的情形）。 */
export const errText = (e) => (e && e.message) || String(e);
