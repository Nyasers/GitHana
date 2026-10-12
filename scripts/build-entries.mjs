// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-entries.mjs — 构建 bin/ 下的独立入口（gpg.shim.mjs / rest.worker.mjs）。
 *
 * ## 这一批是什么
 *
 * `bin/` 下的入口分三类：
 *   · `app.mjs` —— App 主体，由 build-server.mjs 单独打（宿主要缓存它，产物要逐字节可复现）；
 *   · `gpg.shim.mjs` / `rest.worker.mjs` —— **被 spawn 出去的独立进程**，各自单文件；
 *   · `openpgp.min.mjs` —— 随包库文件，上游发行物**原样**拷入（见下）。
 * 本脚本负责第二类。它们与 app.mjs 不共享运行时，也互不共享（各自独立进程），
 * 所以**逐入口分别构建**、不做多入口一次构建（那会切出共享 chunk，让"哪个文件是入口"变模糊）。
 *
 * ## 为什么 worker 也要打，尽管它零依赖
 *
 * 它只用 Node 全局（fetch / process / AbortSignal），确实可以直接拷源码进包。但那样 `bin/` 下
 * 会出现「两个同级入口，一个构建产物、一个带完整注释的源码」——形态不齐，且源码里的注释与
 * 内部结构会随包分发。构建产物与它的同伴一致：单行、无注释、只留要跑的代码。
 * 副产品是体积（16 KB 源码 → 压缩后更小），但那不是理由，形态一致才是。
 *
 * ## node 内置全部外部化
 *
 * `node:fs` / `node:child_process` 等由宿主进程提供，不打进来（externalsPresets.node）。
 * 目标平台固定为 node（这两个入口只在 node 里跑）。
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
 * 运行期按相对路径解析，与 app.mjs 同在 bin/ 下，都解析得到。worker 不 import openpgp，
 * 这条 externals 对它是空转（不匹配任何请求），保留以免两份配置各自漂。
 *
 * 产物：dist/bin/{gpg.shim,rest.worker}.mjs（**直接写交付树**，不经 build/ 中转）。
 *
 * 用法：node scripts/build-entries.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const outDir = path.join(appDir, "dist", "bin");

/** 本批入口：产物名 → 源文件。名字即产物名，源在 tools/lib/ 下。 */
const ENTRIES = {
  "gpg.shim": path.join(appDir, "tools", "lib", "gpg.shim.mjs"),
  "rest.worker": path.join(appDir, "tools", "lib", "rest.worker.mjs"),
};

for (const [name, src] of Object.entries(ENTRIES)) {
  if (!fs.existsSync(src)) {
    console.error(`[build-entries] 入口不存在：${src}`);
    process.exit(1);
  }
}

/** 每个入口一份配置，逐个构建（见头注：不做多入口一次构建，避免共享 chunk）。 */
function configFor(outName, entryFile) {
  return {
    mode: "production",
    devtool: false,
    target: "node",
    entry: { [outName]: entryFile },
    output: {
      path: outDir,
      filename: "[name].mjs",
      clean: false, // dist/bin/ 是共享目录（app.mjs / openpgp.min.mjs 同层），不能在这里清
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
      // 单入口、无动态 import → 没有可切的东西；保持单文件。
      splitChunks: false,
      runtimeChunk: false,
      minimize: true,
    },
    resolve: { extensions: [".js", ".mjs", ".json"] },
    performance: { hints: false },
    stats: "errors-warnings",
  };
}

function buildOne(outName, entryFile) {
  return new Promise((resolve, reject) => {
    rspack(configFor(outName, entryFile), (err, stats) => {
      if (err) return reject(err);
      const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
      for (const w of info.warnings || []) {
        console.log(`[build-entries] ${outName} 警告: ${(w.message || "").split("\n")[0]}`);
      }
      if (stats.hasErrors()) {
        return reject(new Error((info.errors || []).map((e) => e.message).join("\n")));
      }
      const out = path.join(outDir, `${outName}.mjs`);
      if (!fs.existsSync(out)) return reject(new Error(`未产出 dist/bin/${outName}.mjs`));
      const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
      console.log(`[build-entries] dist/bin/${outName}.mjs  ${kb(fs.statSync(out).size)}`);
      resolve();
    });
  });
}

try {
  for (const [name, src] of Object.entries(ENTRIES)) {
    await buildOne(name, src);
  }
  console.log("[build-entries] 完成。bin/ 下的独立入口均为压缩后单入口 ESM（openpgp.min.mjs 除外：上游原样）。");
} catch (e) {
  console.error("[build-entries] 构建失败：", String((e && e.message) || e));
  process.exit(1);
}
