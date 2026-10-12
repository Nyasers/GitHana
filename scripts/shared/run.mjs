// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/run.mjs — "本文件是否被直接运行"的判定（CLI 入口守卫共用一份）。
//
// 为什么不能只看文件名或只用 import.meta.url 比较：域目录下会有同名文件（各域的 index.mjs），
// 后缀判定会互相误命中。这里比**绝对路径**。Windows 盘符与路径大小写不敏感，比较前归一。
//
// 本仓在实行这套守卫之前，各脚本各自写 `process.argv[1] && import.meta.url ===
// pathToFileURL(process.argv[1]).href`——它漏了 Windows 的路径大小写与短路径两种情况，
// 在 CI 上会偶发不执行 main（表现为"跑完却什么都没做"）。
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 传入 import.meta.url：`node <本文件>` 直接运行时为 true，被 import 时为 false。 */
export function isDirectRun(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = path.resolve(fileURLToPath(importMetaUrl));
  const target = path.resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === target.toLowerCase() : self === target;
}
