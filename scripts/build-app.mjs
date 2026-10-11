// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-app.mjs — 组装 App 交付树 dist/（仓库根）。
 *
 * ## 为什么要有这一层
 *
 * 之前 pack.mjs 直接从源码树过滤（黑名单）出包，于是「源码树里多出什么」就等于「包里多出什么」：
 * 本地规划文档（SPECS.md / specs/）与设置页源码（ui/src/）都跟着进了包，且没有任何断言拦得住
 * ——黑名单只列它记得的东西，新冒出来的文件默认放行。
 *
 * 现在改成 DSHana 同形：构建阶段把交付件**逐个点名**组装进 dist/（白名单），pack 只从 dist/ 出包。
 * 源码树里多出什么都不影响包；要进包就必须在这个名单里。
 *
 * ## dist/ 的形状（= App 安装目录形态）
 *
 *   manifest.json / index.js / package.json / LICENSE / NOTICE
 *   licenses/ assets/ bin/ lib/ skills/ tools/
 *   bin/<platform>/  ← 运行时二进制平铺（如 bin/win32-x64/gpg.exe、bin/win32-x64/gh.exe）
 *   ui/  ← 只含壳页与构建产物，**不含 ui/src/**
 *
 * `THIRD_PARTY_NOTICES.md` **不在这里**：它描述的是“这个包里有什么”，而包内容取决于 target，
 * 仓库源码并不“拥有”某个特定包的内容。所以它由 pack.mjs 在暂存后按实际内容渲染（见 pack 的许可面收窄）。
 *
 * `bin/` 的形状与仓库的 `vendor/` **有意不同**：仓库那份是构建期缓存，按组件分目录是为了
 * 单组件能整体重抓；产物里没有“重抓某个组件”这件事，组件那一层就只剩噪音——
 * 装到机器上要的是“这个平台的二进制在哪”，`bin/<platform>/` 直接回答。
 * 形状不同不是不一致，是两边各自回答自己的问题。
 *
 * licenses/ 是许可正文的单一落点：通知只陈述事实与对应关系，法条逐份在这里随包。
 *
 * 不含：scripts/（开发件）、build-deps/（SDK tarball，已迁到 vendor/hana-app-sdk/）、
 * node_modules/、.github/、README.md、SPECS.md、specs/、pnpm-* 清单、releases/、dist-extensions/；
 * 以及整个 `vendor/`（构建期缓存与声明，运行时无消费者）。
 *
 * ## 每轮先清再写
 *
 * dist/ 是构建产出，不入 git（见 .gitignore）。每轮整体清空重建，避免上一轮的残留被当成产物。
 *
 * 用法：node scripts/build-app.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

/** 交付件白名单：**只有**列在这里的东西会进包。 */
const DELIVERY_FILES = [
  "manifest.json",
  "index.js",
  "package.json", // 入口是 ESM，没有它 Node 按 CJS 解析，index.js 的 import 直接语法报错
  "LICENSE",
  "NOTICE",
];
const DELIVERY_DIRS = [
  "licenses", // 许可正文（通知只陈述事实，法条逐份在这里随包）
  "assets",
  "lib",
  "skills",
  "tools",
  "vendor",
];

const log = (...a) => console.log("[build-app]", ...a);
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

/** 逐份拷贝并计数（便于报告，也让"拷贝了什么"在日志里可见）。 */
function copyInto(from, to) {
  cpSync(from, to, { recursive: true, dereference: true });
  const st = statSync(to);
  if (!st.isDirectory()) return 1;
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else n += 1;
    }
  };
  walk(to);
  return n;
}

function main() {
  // 0) 清空重建：dist/ 是产出，每轮整体重来，避免残留混进产物。
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // 1) 先构建设置页产物（ui/src → ui/dist）。产物必须先就绪，下面才拷得进来。
  const buildUi = join(ROOT, "scripts", "build-ui.mjs");
  if (!existsSync(buildUi)) {
    console.error("[build-app] 找不到 scripts/build-ui.mjs");
    process.exit(1);
  }
  log("构建设置页产物（ui/src/settings.jsx → ui/dist/settings.bundle.*）…");
  try {
    execFileSync(process.execPath, [buildUi], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[build-app] 设置页构建失败");
    process.exit(1);
  }

  // 2) 契约件与代码目录（白名单）
  let total = 0;
  for (const name of DELIVERY_FILES) {
    const src = join(ROOT, name);
    if (!existsSync(src)) {
      console.error(`[build-app] 交付件缺失：${name}`);
      process.exit(1);
    }
    total += copyInto(src, join(DIST, name));
  }
  for (const name of DELIVERY_DIRS) {
    const src = join(ROOT, name);
    if (!existsSync(src)) {
      console.error(`[build-app] 交付目录缺失：${name}/`);
      process.exit(1);
    }
    total += copyInto(src, join(DIST, name));
  }
  log(`契约件与代码目录就位（${DELIVERY_FILES.length} 个文件 + ${DELIVERY_DIRS.length} 个目录）`);

  // 2b) vendor/ 只服务构建期，**不进交付面**：交付面是 `bin/<platform>/`，二进制在那里平铺。
  //     仓库里按组件分目录（vendor/bin/<平台>/<组件>/）是为了单组件可整体重抓；
  //     产物里没有“重抓某个组件”这件事，组件那一层就只剩噪音。
  //     sources.json 与 SDK 快照同样不随包（运行时无消费者，声明只服务重建与派生）。
  const distVendorBin = join(DIST, "vendor", "bin");
  if (!existsSync(distVendorBin)) {
    console.error("[build-app] 缺 vendor/bin/（跑 node scripts/fetch-vendor.mjs 重建内嵌运行时）");
    process.exit(1);
  }
  for (const platform of readdirSync(distVendorBin)) {
    const platformDir = join(distVendorBin, platform);
    if (!statSync(platformDir).isDirectory()) continue;
    const outDir = join(DIST, "bin", platform);
    mkdirSync(outDir, { recursive: true });
    for (const component of readdirSync(platformDir)) {
      const compDir = join(platformDir, component);
      if (!statSync(compDir).isDirectory()) continue;
      for (const name of readdirSync(compDir)) {
        renameSync(join(compDir, name), join(outDir, name));
      }
    }
  }
  rmSync(join(DIST, "vendor"), { recursive: true, force: true });
  log("vendor/ → bin/<platform>/（平铺）；构建期元数据与声明不随包");

  // 3) ui/：只放壳页与构建产物，**不放源码**（ui/src/ 是源，不属于交付面）。
  const uiSrcHtml = join(ROOT, "ui", "settings.html");
  const uiSrcDist = join(ROOT, "ui", "dist");
  if (!existsSync(uiSrcHtml)) {
    console.error("[build-app] 缺 ui/settings.html");
    process.exit(1);
  }
  for (const name of ["settings.bundle.js", "settings.bundle.css"]) {
    if (!existsSync(join(uiSrcDist, name))) {
      console.error(`[build-app] 缺设置页产物 ui/dist/${name}`);
      process.exit(1);
    }
  }
  total += copyInto(uiSrcHtml, join(DIST, "ui", "settings.html"));
  total += copyInto(uiSrcDist, join(DIST, "ui", "dist"));
  log("ui/ 就位（settings.html + dist/ 产物；不含 ui/src/）");

  // 4) 断言：交付树里绝不能出现源码与开发件。
  //    这是白名单的最后一道保险——拷贝逻辑改了、或将来有人加了目录，这里会当场拦住。
  const FORBIDDEN = [
    "ui/src", // 设置页源码
    "scripts", // 构建脚本
    "node_modules",
    "build-deps",
    "vendor", // 构建期缓存与声明：已投影为 bin/<platform>/，产物里不再有这一层
    "README.md",
    "SPECS.md",
    "specs",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".github",
    "releases",
    "dist-extensions",
  ];
  const leaked = FORBIDDEN.filter((p) => existsSync(join(DIST, p)));
  if (leaked.length) {
    console.error(`[build-app] 交付树里出现了不该有的路径：${leaked.join("、")}`);
    process.exit(1);
  }

  // 5) 断言：manifest 声明的入口与设置页路由必须在交付树里真实存在。
  //    缺了就是"宿主装上也起不来"的静默缺口，不该等到用户机器上才暴露。
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  if (typeof manifest.entry === "string" && !existsSync(join(DIST, manifest.entry))) {
    console.error(`[build-app] manifest.entry 指向的文件不在交付树里：${manifest.entry}`);
    process.exit(1);
  }
  const route = manifest.contributes?.settings?.ui?.route;
  if (typeof route === "string" && !existsSync(join(DIST, "ui", route.replace(/^\//, "")))) {
    console.error(`[build-app] 设置页路由指向的文件不在交付树里：ui${route}`);
    process.exit(1);
  }

  log(`完成：${rel(DIST)} 共 ${total} 个文件（白名单交付面，pack 从这里出包）`);
}

main();
