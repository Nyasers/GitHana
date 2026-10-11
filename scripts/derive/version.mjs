// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/version.mjs — 主清单版本 → package.json#version（derive 的 version 任务）
//
// ## 版本单一事实源是 manifest.json，不是 package.json
//
// 宿主安装时在包根读 `manifest.json`，包名里的版本（`<id>-v<version>-<target>.zip`）也取自它。
// `package.json` 在交付树里另有作用（入口是 ESM，Node 靠它按 module 解析 index.js），但它那份
// `version` 字段没有任何发布含义——它唯一需要满足的是"与 manifest 一致"，否则读的人会以为发
// 布的是另一个版本。
//
// 所以方向是 manifest → package.json，反过来会把"事实源"挪到一个人读的字段上。pack.mjs 出包时
// 也断言两者一致（`版本不一致：manifest=… package.json=…`），那道断言拦的是"忘了跑本任务"，
// 与这里互补：derive 负责对齐，pack 负责在不对齐时拒绝出包。
import fs from "node:fs";
import { at } from "../shared/root.mjs";

const MANIFEST = "manifest.json";
const PKG = "package.json";

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** 读主清单的版本（缺失即报错——版本是包契约的一部分，不能默认成某个值）。 */
export function manifestVersion() {
  const j = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
  const v = j && j.version;
  if (typeof v !== "string" || !v) throw new Error(`${MANIFEST} 没有 version`);
  return v;
}

/**
 * 任务：version —— manifest.json#version → package.json#version。
 *
 * 整份比较（与其它任务同口径）：这里只改 version 一个字段，但产出的仍是"这个文件应该长什么样"，
 * 框架据此逐字比对。若 package.json 里有别人手写的内容漂了（如缩进被编辑器改过），本任务会
 * 一并写回统一形态——JSON 由机器拥有，不是给人手改的。
 */
export const versionTask = {
  name: "version",
  about: `${MANIFEST}#version → ${PKG}#version`,
  plan: () => {
    const version = manifestVersion();
    const j = JSON.parse(fs.readFileSync(at(PKG), "utf8"));
    j.version = version;
    return [{ rel: PKG, content: jsonText(j) }];
  },
};
