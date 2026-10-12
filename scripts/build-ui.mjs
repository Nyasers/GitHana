// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-ui.mjs — 把 ui/src/settings.jsx 打成设置页浏览器产物。
 *
 * 为什么需要这一步：设置页用宿主组件（@hana/app-sdk/components），而它把 React / React DOM
 * 当外部 peer——浏览器里没有 bare specifier 解析，必须打包。产物直接进 App 包（宿主不会在
 * 安装时跑构建），所以每次改完 UI 源码都要重跑本脚本，让产物进包。
 *
 *   ui/src/settings.jsx  ──rspack──▶  dist/ui/settings.bundle.js
 *   （含 @hana/app-sdk/components.css 与 ./settings.css 的样式合并、按导入顺序抽取）
 *                                    └▶  dist/ui/settings.bundle.css
 *
 * 产物直接写进**交付树** dist/ui/（平铺，不再套一层 ui/dist/）：交付面里 ui/ 只该有
 * 「壳页 + 可直接引用的产物」两层意思，多一层 dist 只是搬运留下的痕迹。dist/ 不入 git
 * （见 .gitignore），由 build-app.mjs 每轮整体重建。
 *
 * 本脚本可以单独跑（改 UI 后的快速迭代），但产出的 dist/ 是部分的；
 * 要一个完整交付树请跑 `pnpm run build`（build-app 会先清空 dist/ 再依次构建）。
 *
 * 为什么是 Rspack 而不是 esbuild：SDK 的 components 产物里有几个**可选 peer** 的
 * `require`（例如 @emotion/is-prop-valid，位于 try/catch 探测里）。esbuild 把这类调用编成
 * 「Dynamic require of "…" is not supported」并**抛错**——虽然调用点自己吞了异常，但那类垫片
 * 一旦出现在别的上下文就会变成硬崩；Rspack 走 webpack 系语义：解析不到就退化成空模块并给一条
 * 警告，调用方照常拿到 undefined。同时 Rspack 自带 CSS 抽取与 SWC 压缩，不再需要额外依赖。
 *
 * 用法：node scripts/build-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const entry = path.join(appDir, "ui", "src", "settings.jsx");
const outDir = path.join(appDir, "dist", "ui");

if (!fs.existsSync(entry)) {
  console.error(`[build-ui] 入口不存在：${entry}`);
  process.exit(1);
}

/** 可选 peer：SDK 侧只在 try/catch 里探测，缺了就该退化为空模块而不是编译失败。 */
const OPTIONAL_PEERS = ["@emotion/is-prop-valid"];

const config = {
  mode: "production",
  devtool: false,
  target: ["web", "es2022"],
  entry: { "settings.bundle": entry },
  output: {
    path: outDir,
    filename: "[name].js",
    clean: false, // dist/ 由 build-app 整体清空重建；共享目录不能在这里清（否则会抹掉别的构建产物）
    module: true,
    chunkFormat: "module",
  },
  experiments: { outputModule: true },
  optimization: {
    minimize: true,
    splitChunks: false,
    runtimeChunk: false,
    minimizer: [new rspack.SwcJsMinimizerRspackPlugin()],
  },
  resolve: {
    extensions: [".jsx", ".js", ".json"],
    alias: Object.fromEntries(OPTIONAL_PEERS.map((p) => [p, false])),
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "ecmascript", jsx: true },
              transform: { react: { runtime: "automatic", development: false } },
            },
          },
        },
        type: "javascript/auto",
      },
      { test: /\.css$/, type: "css" },
    ],
  },
  plugins: [new rspack.CssExtractRspackPlugin({ filename: "settings.bundle.css" })],
  performance: { hints: false },
  stats: "errors-warnings",
};

rspack(config, (err, stats) => {
  if (err) {
    console.error("[build-ui] 编译失败：", err);
    process.exit(1);
  }
  const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
  for (const w of info.warnings || []) {
    const msg = (w.message || "").split("\n")[0];
    console.log(`[build-ui] 警告: ${msg}`);
  }
  if (stats.hasErrors()) {
    for (const e of info.errors || []) {
      console.error(`[build-ui] 错误: ${e.message}`);
    }
    process.exit(1);
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  // 只认这两个交付物，直接读盘：比解析 stats.assets 稳（产物内容未变时 Rspack 会跳过写入，
  // 那时 assets 的形状与首次构建不同）。
  for (const name of ["settings.bundle.js", "settings.bundle.css"]) {
    const p = path.join(outDir, name);
    console.log(`[build-ui] dist/ui/${name}  ${fs.existsSync(p) ? kb(fs.statSync(p).size) : "<缺失>"}`);
  }
  console.log("[build-ui] 完成。产物在 dist/ui/，随包安装后在 App 详情页「重新加载」。");
});
