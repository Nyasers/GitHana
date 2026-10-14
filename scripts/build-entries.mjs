// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-entries.mjs — 构建 bin/ 下的独立入口（gpg.shim.mjs / rest.worker.mjs）
 * 与随包库文件（zod.min.mjs）。
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
 * ## zod 走同一形态，但**由本脚本打包**（不是上游原样拷）
 *
 * `zod` 是构建期依赖，运行期要随包（工具参数校验在 App 进程里跑）。形态与 openpgp 一致：
 * 一份独立可替换的库文件 `bin/zod.min.mjs`，各入口运行期用相对 import 加载（见
 * build-server.mjs 的 externals）。区别在**来源**：openpgp 那边上游直接给了 dist/node 下的
 * 单文件产物，原样拷即可；zod 的发行物是**多文件 ESM**（`index.js` re-export `v4/classic/*`
 * 等上百个模块），拷一份源树进包等于让 bin/ 混进一个目录树。所以这里用 rspack 把那棵树打成
 * 单文件——与 openpgp 那边"一份独立、接口兼容即可替换的库文件"是同一个形状，只是生成方式不同。
 * 体积记录在案：实测 **383,425 bytes（374.4 KB）**，minimize 后（对照 openpgp 395,489 bytes）。
 * 构建脚本每次都会把它打出来（`[build-entries] dist/bin/zod.min.mjs  … KB`），所以这个数字可在
 * 构建输出里复核；它是产物（非上游原件），没有"与上游逐字节相同"可断言。
 *
 * 产物：dist/bin/{gpg.shim,rest.worker,zod.min}.mjs（**直接写交付树**，不经 build/ 中转）。
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

/**
 * 随包库文件：产物名 → 要从 node_modules 里打进来的包入口。
 * 与上面那批入口分开列：它们的源在 node_modules（不是本仓源码），产物是**库**不是进程入口。
 */
const LIBRARIES = {
  "zod.min": path.join(appDir, "node_modules", "zod", "index.js"),
};

for (const [name, src] of Object.entries({ ...ENTRIES, ...LIBRARIES })) {
  if (!fs.existsSync(src)) {
    console.error(`[build-entries] 源不存在：${src}`);
    process.exit(1);
  }
}

/**
 * 每个入口一份配置，逐个构建（见头注：不做多入口一次构建，避免共享 chunk）。
 *
 * @param {string} outName 产物名（不含扩展名）
 * @param {string} entryFile 入口源文件
 * @param {boolean} [isLibrary] 这份产物是**给别人 import 的库**（而不是自己跑的进程入口）。
 *   库要保住的正是"被 import 时的接口"：导出名与被导出的一切都不能被生产模式的优化改动。
 */
function configFor(outName, entryFile, isLibrary = false) {
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
    // zod 在这里**不能**外置：本脚本的产物之一就是 bin/zod.min.mjs 本身，外置会打出一个只含
    // 一条 import 的空壳。
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
      // 库产物关掉导出改名。它在生产模式默认开，服务的是"打一个自己跑的进程"（导出名只在自己
      // 内部用，改短了省字节）；而库的导出名就是它**对外承诺的接口**——消费方按名字 import。
      // 实测同类产物（dshana 的 bin/app.mjs，同样是 module 库 + node target）保留了入口的
      // `apply` / `default`，所以默认行为目前就是对的；这里显式关掉是为了让"导出名不可改"成为
      // 构建期的显式约定，而不是依赖打包器对入口模块的隐式豁免。
      // usedExports / providedExports 不动：同一实测显示入口模块的导出被判为"已使用"而未被摇掉。
      ...(isLibrary ? { mangleExports: false } : {}),
    },
    resolve: { extensions: [".js", ".mjs", ".json"] },
    performance: { hints: false },
    stats: "errors-warnings",
  };
}

function buildOne(outName, entryFile, isLibrary = false) {
  return new Promise((resolve, reject) => {
    rspack(configFor(outName, entryFile, isLibrary), (err, stats) => {
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
  for (const [name, src] of Object.entries(LIBRARIES)) {
    await buildOne(name, src, true);
  }
  console.log("[build-entries] 完成。bin/ 下的独立入口均为压缩后单入口 ESM（openpgp.min.mjs 除外：上游原样）。");
} catch (e) {
  console.error("[build-entries] 构建失败：", String((e && e.message) || e));
  process.exit(1);
}
