// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-shim.mjs — 把签名 shim 打成单入口 ESM（bin/gpg.shim.mjs）。
 *
 * ## 为什么 shim 要单独打一份
 *
 * shim 是 **git spawn 出去的独立进程**（经 gpg.program），与 app.mjs 不共享运行时。
 * 它是自己的入口，交付面里没有 node_modules（白名单只收交付件），所以依赖只能外置成
 * 同目录的库文件，不能留裸包名。这与 rest.worker.mjs 的处境不同：那个零依赖，可以直接平铺；
 * shim 有依赖，只能打。
 *
 * ## 为什么不与 app.mjs 一起打（两入口一次构建）
 *
 * 那会让两边共享的代码被切成 chunk，产物变成 app.mjs + gpg.shim.mjs + 若干数字 chunk——
 * 而 shim 要作为**单文件**被 gpg.program 指向（多文件会让"哪个是入口"变模糊，且 chunk
 * 路径要在运行时解析）。分开打，产物可复现，与 build-server.mjs 同口径。
 *
 * ## node 内置全部外部化
 *
 * `node:fs` / `node:child_process` 等由宿主进程提供，不打进来（externalsPresets.node）。
 * 目标平台固定为 node（shim 只在 node 里跑）。
 *
 * ## OpenPGP.js 是**运行期外置**，不内联
 *
 * `openpgp` 外置成同目录的相对 import（`./openpgp.min.mjs`），该库文件由 build-app.mjs
 * 从上游 dist 原样拷进 dist/bin/，与 app.mjs 共用同一份。两条理由：
 *   · 体积：一份 395 KB 顶掉原先 app.mjs / shim 各自内联的一份；
 *   · 许可：OpenPGP.js 是 LGPL-3.0-or-later，以独立可替换的库文件形态分发时，
 *     LGPL §4(d)(1)（运行期使用用户系统上的库、接口兼容的修改版可直接替换）才有落点；
 *     内联进产物则只能走 §4(d)(0) 的重组路径。详见 THIRD_PARTY_NOTICES.md 的 LGPL 段。
 * 外置 request 写成 "module ./openpgp.min.mjs"：产物里就是一条 ESM 相对 import，
 * 运行期按相对路径解析，与 app.mjs 同在 bin/ 下，两边都解析得到。
 *
 * 产物：dist/bin/gpg.shim.mjs（**直接写交付树**，不经 build/ 中转）。
 *
 * 用法：node scripts/build-shim.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const entry = path.join(appDir, "tools", "lib", "gpg.shim.mjs");
const outDir = path.join(appDir, "dist", "bin");

if (!fs.existsSync(entry)) {
  console.error(`[build-shim] 入口不存在：${entry}`);
  process.exit(1);
}

const config = {
  mode: "production",
  devtool: false,
  target: "node",
  entry: { "gpg.shim": entry },
  output: {
    path: outDir,
    filename: "[name].mjs",
    clean: false, // dist/bin/ 是共享目录（app.mjs / rest.worker.mjs 同层），不能在这里清
    module: true,
    chunkFormat: "module",
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // OpenPGP.js 外置为同目录的运行期相对 import（与 app.mjs 共用 bin/openpgp.min.mjs）。
  externals: { openpgp: "module ./openpgp.min.mjs" },
  module: {
    parser: {
      javascript: {
        // 与 build-server 同口径：不把 import.meta.url 固化成构建机路径。
        importMeta: false,
      },
    },
  },
  optimization: {
    // 单入口、无动态 import → 没有可切的东西；保持单文件（gpg.program 要指向一个确定文件）。
    splitChunks: false,
    runtimeChunk: false,
    minimize: true,
  },
  resolve: { extensions: [".js", ".mjs", ".json"] },
  performance: { hints: false },
  stats: "errors-warnings",
};

rspack(config, (err, stats) => {
  if (err) {
    console.error("[build-shim] 编译失败：", err);
    process.exit(1);
  }
  const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
  for (const w of info.warnings || []) {
    console.log(`[build-shim] 警告: ${(w.message || "").split("\n")[0]}`);
  }
  if (stats.hasErrors()) {
    for (const e of info.errors || []) console.error(`[build-shim] 错误: ${e.message}`);
    process.exit(1);
  }
  const out = path.join(outDir, "gpg.shim.mjs");
  if (!fs.existsSync(out)) {
    console.error("[build-shim] 未产出 dist/bin/gpg.shim.mjs");
    process.exit(1);
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`[build-shim] dist/bin/gpg.shim.mjs  ${kb(fs.statSync(out).size)}`);
  console.log("[build-shim] 完成。单入口 ESM，OpenPGP.js 为运行期相对 import（bin/openpgp.min.mjs）。");
});
