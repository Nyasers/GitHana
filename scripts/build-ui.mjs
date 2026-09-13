// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-ui.mjs — 把 ui/src/settings.jsx 打成 ui/ 下的浏览器产物。
 *
 * 为什么需要这一步：设置页用宿主组件（@hana/app-sdk/components），而它把 React / React DOM
 * 当外部 peer——浏览器里没有 bare specifier 解析，必须打包。产物直接进 App 包（宿主不会在
 * 安装时跑构建），所以每次改完 UI 源码都要重跑本脚本再 deploy。
 *
 *   ui/src/settings.jsx  ──esbuild──▶  ui/settings.bundle.js
 *   （含 @hana/app-sdk/components.css 与 ./settings.css 的样式合并）
 *                                   └▶  ui/settings.bundle.css
 *
 * 用法：node scripts/build-ui.mjs
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const entry = path.join(appDir, "ui", "src", "settings.jsx");
const outJs = path.join(appDir, "ui", "settings.bundle.js");

if (!fs.existsSync(entry)) {
  console.error(`[build-ui] 入口不存在：${entry}`);
  process.exit(1);
}

const result = await esbuild.build({
  entryPoints: [entry],
  outfile: outJs,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const file of Object.keys(result.metafile.outputs)) {
  const abs = path.resolve(process.cwd(), file);
  if (fs.existsSync(abs)) console.log(`[build-ui] ${path.relative(appDir, abs)}  ${kb(fs.statSync(abs).size)}`);
}
console.log("[build-ui] 完成。记得 deploy 后在 App 详情页「重新加载」。");
