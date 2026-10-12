// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-server.mjs — 把服务端代码打成单入口 bundle（bin/app.mjs）。
 *
 * ## 为什么打 bundle
 *
 * 交付面是"装到机器上要跑的东西"，而不是"源码树的形状"。此前服务端代码以源码形态随包
 * （`app.js` + `lib/` 7 个 + `tools/` 14 个 = 22 个文件），代价有三：
 *   · 交付面里混着源码，读包的人无法一眼分清"哪些是要跑的、哪些是给人看的"；
 *   · 随包的 `package.json` 只为了让 Node 把 `.js` 按 ESM 解析（那时入口是 `.js`，
 *     没有它 import 直接语法报错）——**一个为解析规则而随包的文件**；
 *   · 入口的层数被固定（`import.meta.url` 上推两级 = 安装根），产物布局一改就指错。
 *
 * 打成单入口后：产物是 `bin/app.mjs`（`.mjs` 扩展名自带 ESM 语义，**不需要 package.json
 * 随包**），服务端只有一个文件进包，安装根的取法也不再依赖入口的层数（见 tools/lib/bin.js
 * 的 pluginRoot）。
 *
 * ## 为什么叫 app 而不是 index
 *
 * 单入口的名字应该回答"这是什么"：它是 App 主体，不是一份目录下的默认页。
 *
 * 同生态的 DSHana 把入口叫 `bin/index.mjs`，但那个名字服务于它的一个历史原因：**它有两份东西**
 * ——主体 `app.mjs` 与受管 runtime `dsh.mjs`——而 `index.mjs` 是一层手写的静态转发壳，
 * 用来绕开"rspack 产出的入口带数字 id、每次构建都变"的问题（宿主会缓存入口）。
 * 本 App 没有第二份东西，也没有那层壳：直接产出主体 `app.mjs`，宿主同样按 manifest.entry 加载。
 * 照搬 `index` 那个名字会把别人的补丁当成形态。
 *
 *   app.js ──rspack(node target)──▶ dist/bin/app.mjs
 *
 * ## 为什么是 Rspack
 *
 * 与 build-ui.mjs 同一个打包器（已经在依赖里），配置口径一致。node 内置模块全部外部化
 * （`externalsPresets.node`）：它们是宿主进程提供的，不该被打进来。
 *
 * `openpgp` 则外置成同目录的运行期相对 import（`./openpgp.min.mjs`）：该库文件由
 * build-app.mjs 从上游 dist 原样拷进 dist/bin/，与 gpg.shim.mjs 共用同一份。体积上
 * 省掉一份内联副本；许可上是 LGPL §4(d)(1) 的落点（独立可替换的库文件，见 NOTICE 的 LGPL 段）。
 *
 * ## 产物落点
 *
 * `dist/bin/`——**直接写交付树**，不再经过 build/ 中转。中转那一层没有存在理由：
 * 写进去立刻又拷出来，只会让"产物到底在哪"多一个需要判断的间接层。
 * build-app.mjs 负责先清空 dist/、再依次调起各构建脚本。
 *
 * 用法：node scripts/build-server.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const entry = path.join(appDir, "app.js");
const outDir = path.join(appDir, "dist", "bin");

if (!fs.existsSync(entry)) {
  console.error(`[build-server] 入口不存在：${entry}`);
  process.exit(1);
}

const config = {
  mode: "production",
  devtool: false,
  target: "node",
  entry: { app: entry },
  output: {
    path: outDir,
    filename: "[name].mjs",
    clean: false, // dist/bin/ 是共享目录（还有 rest.worker.mjs 等同层件），不能在这里清
    module: true,
    chunkFormat: "module",
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  // node 内置模块全部外部化：它们是宿主进程提供的，不该打进产物。
  externalsPresets: { node: true },
  // OpenPGP.js 外置为同目录的运行期相对 import（与 gpg.shim.mjs 共用 bin/openpgp.min.mjs）。
  externals: { openpgp: "module ./openpgp.min.mjs" },
  module: {
    parser: {
      javascript: {
        // **不要把 `import.meta.url` 在构建期固化成构建机的绝对路径。**
        // 默认行为会把它替换成 `file:///H:/workspace/…/tools/lib/bin.js` 这样的字符串，
        // 那台路径在用户机器上不存在，而入口位置正是工具面定位安装根的根据
        // （见 tools/lib/bin.js 的 pluginRoot）。保持运行时语义，产物在任何安装位都自洽。
        importMeta: false,
      },
    },
  },
  optimization: {
    // 不切 chunk：**chunk 来自多入口共享代码或动态 `import()`**，本 App 两边都没有——
    // 服务端就一个入口（app.js），也没有动态 import（仅 JSDoc 里出现过 `import("hono").Hono`
    // 这类类型注释，不是真导入）。实测：把这里改成 `splitChunks: { chunks: "all" }`，产物文件名
    // 完全一样（没有可切的东西）；只有强行 `runtimeChunk: "single"` 才会多出一个 runtime.mjs。
    //
    // 对照 DSHana：它的 bin/ 有 300.mjs/964.mjs，因为它是**两入口一次构建**（主体 app +
    // 受管 runtime dsh），两边共享代码才切得出来；它的 ui/ 数字 chunk 则来自 stream-entry.ts 里
    // 对重型半的动态 import。形态对齐的是“为什么切”，不是“看上去该有几个文件”。
    //
    // 单入口还有个真好处：产物逐字节可复现（连跑两次构建 SHA256 相同），宿主缓存它才稳。
    // 这正是 DSHana 把 bin/index.mjs 写成静态壳（而非 rspack 产出）所追求的性质。
    splitChunks: false,
    runtimeChunk: false,
    minimize: true,
  },
  resolve: { extensions: [".js", ".json"] },
  performance: { hints: false },
  stats: "errors-warnings",
};

rspack(config, (err, stats) => {
  if (err) {
    console.error("[build-server] 编译失败：", err);
    process.exit(1);
  }
  const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
  for (const w of info.warnings || []) {
    console.log(`[build-server] 警告: ${(w.message || "").split("\n")[0]}`);
  }
  if (stats.hasErrors()) {
    for (const e of info.errors || []) console.error(`[build-server] 错误: ${e.message}`);
    process.exit(1);
  }
  const out = path.join(outDir, "app.mjs");
  if (!fs.existsSync(out)) {
    console.error("[build-server] 未产出 dist/bin/app.mjs");
    process.exit(1);
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`[build-server] dist/bin/app.mjs  ${kb(fs.statSync(out).size)}`);
  console.log("[build-server] 完成。单入口 ESM（.mjs 自带 ESM 语义，无需随包 package.json）。");
  console.log("[build-server] OpenPGP.js 为运行期相对 import（bin/openpgp.min.mjs）。");
});
