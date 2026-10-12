// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/root.mjs — 仓库根定位（脚本域共用一份）。
//
// 为什么不数 ".." 的层数：脚本分在 scripts/<域>/ 下，到根的深度不一，数层数会在目录调整时
// 失准（本仓实行这套分域之前，每个脚本各自 `join(dirname(fileURLToPath(import.meta.url)), "..")`，
// 脚本一进子目录就要逐个改）。这里向上找最近的 package.json——脚本只会待在 scripts/ 下
// （其子目录不含 package.json），第一个命中的就是仓库根。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 从给定文件向上找最近的含 package.json 的目录。 */
export function findRepoRoot(from) {
  let dir = path.dirname(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`找不到仓库根：${from} 向上没有 package.json`);
    dir = up;
  }
}

export const ROOT = findRepoRoot(fileURLToPath(import.meta.url));

/** 仓库根下的绝对路径（拼多段，避免各处散落 join(ROOT, "a", "b")）。 */
export const at = (...p) => path.join(ROOT, ...p);

/** 相对仓库根的展示路径（正斜杠，跨平台日志一致）。 */
export const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";
