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
 *   manifest.json / LICENSE / NOTICE
 *   bin/  ← 入口（app.mjs，服务端 bundle）+ REST worker（rest-worker.mjs）+ 运行时二进制平铺（bin/<platform>/gpg.exe …）
 *   licenses/ assets/
 *   ui/   ← 只含壳页与构建产物，**不含 ui/src/**
 *
 * **服务端代码以单入口进包**（`bin/app.mjs`）：入口名回答“这是什么”——它是 App 主体，
 * 不是一份目录下的默认页。安装目录里只有一个服务端文件，而不是 `app.js` + `lib/` + `tools/`
 * 共 22 个源码文件——交付面是"装到机器上要跑的东西"，不是"源码树的形状"。`.mjs` 扩展名自带
 * ESM 语义，所以**不再随包 package.json**（以前它是为了让 Node 把 `.js` 当 ESM 解析才跟着进包的）。
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
 * 不含：scripts/（开发件）、根上的 app.js / lib/ / tools/（已 bundle 进 bin/app.mjs，
 * 但 tools/lib/rest-worker.mjs 例外——它是 spawn 出去的独立入口，平铺到 bin/rest-worker.mjs）、
 * build-deps/（SDK tarball，已迁到 vendor/hana-app-sdk/）、node_modules/、.github/、README.md、
 * SPECS.md、specs/、pnpm-* 清单、releases/、dist-extensions/；以及整个 `vendor/`
 * （构建期缓存与声明，运行时无消费者）。
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
  "LICENSE",
  "NOTICE",
];
const DELIVERY_DIRS = [
  "licenses", // 许可正文（通知只陈述事实，法条逐份在这里随包）
  "assets",
];

const log = (...a) => console.log("[build-app]", ...a);
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

/** 跑一个构建脚本（同目录下的 .mjs）；失败即退出。 */
function runBuild(script, failMessage) {
  const p = join(ROOT, "scripts", script);
  if (!existsSync(p)) {
    console.error(`[build-app] 找不到 scripts/${script}`);
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, [p], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error(`[build-app] ${failMessage}`);
    process.exit(1);
  }
}

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

  // 1) 先构建设置页产物（ui/src → ui/dist）与服务端单入口 bundle（app.js → build/server/）。
  //    两个产物都必须先就绪，下面才拷得进来。
  log("构建设置页产物（ui/src/settings.jsx → ui/dist/settings.bundle.*）…");
  runBuild("build-ui.mjs", "设置页构建失败");
  log("构建服务端单入口（app.js → build/server/app.mjs）…");
  runBuild("build-server.mjs", "服务端构建失败");

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

  // 2a) 服务端单入口 → bin/app.mjs（与平台二进制同层：bin/ 就是"装到机器上要跑的东西"）。
  const serverBundle = join(ROOT, "build", "server", "app.mjs");
  if (!existsSync(serverBundle)) {
    console.error("[build-app] 缺 build/server/app.mjs（服务端 bundle 未生成）");
    process.exit(1);
  }
  mkdirSync(join(DIST, "bin"), { recursive: true });
  total += copyInto(serverBundle, join(DIST, "bin", "app.mjs"));

  // 2a') REST worker → bin/rest-worker.mjs。
  //     它**不**进 app.mjs 的 bundle：那是个 spawn 出去的子进程入口，必须是一个真实存在的
  //     独立文件（tools/lib/rest.js 用 process.execPath 拉它）。与 app.mjs 同层，理由一样：
  //     bin/ 就是“装到机器上要跑的东西”。
  const restWorker = join(ROOT, "tools", "lib", "rest-worker.mjs");
  if (!existsSync(restWorker)) {
    console.error("[build-app] 缺 tools/lib/rest-worker.mjs（GitHub REST 执行体）");
    process.exit(1);
  }
  total += copyInto(restWorker, join(DIST, "bin", "rest-worker.mjs"));
  log(`契约件与目录就位（${DELIVERY_FILES.length} 文件 + ${DELIVERY_DIRS.length} 目录）+ bin/app.mjs + bin/rest-worker.mjs`);

  // 2b) 内嵌运行时二进制：**从仓库的 vendor/bin/ 直接投影**到交付树的 bin/<platform>/。
  //     vendor/ 本身不进交付面（它是构建期缓存与声明），所以这里读源树、只把二进制平铺过去，
  //     而不是先拷 vendor/ 再删。仓库里按组件分目录（vendor/bin/<平台>/<组件>/）是为了单组件
  //     可整体重抓；产物里没有“重抓某个组件”这件事，组件那一层就只剩噪音。
  //     sources.json 与 SDK 快照也不随包（运行时无消费者，声明只服务重建与派生）。
  //
  //     判定面按**本机平台**的声明：sources.json 里 sha256 为空的组件本就不随包（回退宿主 /
  //     系统 PATH），macOS / Linux 声明里没有可校验产物，fetch-vendor 不会建 vendor/bin/——那是
  //     合法状态，不是缺件。只拦“本机平台声明了可校验产物却没就绪”（与 selfcheck 同口径）。
  //     不逐个平台校验：CI 是逐平台跑的，Linux runner 上本来就只抓了 linux 的 vendor。
  const srcVendorBin = join(ROOT, "vendor", "bin");
  const hostKey = `${process.platform}-${process.arch}`;
  let srcSources = null;
  try {
    srcSources = JSON.parse(readFileSync(join(ROOT, "vendor", "sources.json"), "utf8"));
  } catch {
    srcSources = null;
  }
  const declaredMissing = [];
  for (const [component, spec] of Object.entries(
    (srcSources && srcSources.platforms && srcSources.platforms[hostKey] &&
      srcSources.platforms[hostKey].components) || {},
  )) {
    if (!spec.sha256) continue; // 无声明产物 → 走宿主 / 系统 PATH，不必随包
    if (!existsSync(join(srcVendorBin, hostKey, component, spec.exe))) {
      declaredMissing.push(`${hostKey}/${component}`);
    }
  }
  if (declaredMissing.length) {
    console.error(
      `[build-app] 本机平台声明了却未就绪的内嵌组件：${declaredMissing.join("、")}\n` +
        `           跑 node scripts/fetch-vendor.mjs --platform ${hostKey} 重建内嵌运行时。`,
    );
    process.exit(1);
  }
  if (existsSync(srcVendorBin)) {
    for (const platform of readdirSync(srcVendorBin)) {
      const platformDir = join(srcVendorBin, platform);
      if (!statSync(platformDir).isDirectory()) continue;
      const outDir = join(DIST, "bin", platform);
      mkdirSync(outDir, { recursive: true });
      for (const component of readdirSync(platformDir)) {
        const compDir = join(platformDir, component);
        if (!statSync(compDir).isDirectory()) continue;
        for (const name of readdirSync(compDir)) {
          copyInto(join(compDir, name), join(outDir, name));
        }
      }
    }
    log("vendor/bin/ → bin/<platform>/（平铺）；构建期元数据与声明不随包");
  } else {
    log(`vendor/bin/ 不存在：本平台（${hostKey}）声明里没有可校验的内嵌组件（二进制走宿主 / 系统 PATH）`);
  }

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
    "app.js", // 服务端源码（已 bundle 进 bin/app.mjs）
    "lib", // 服务端源码目录
    "tools", // 工具实现目录
    "package.json", // 产物用 .mjs 自带 ESM 语义，不再需要它跟包
    "node_modules",
    "build-deps",
    "vendor", // 构建期缓存与声明：已投影为 bin/<platform>/，产物里不再有这一层
    "build", // 构建区（服务端 bundle 已拷进 bin/）
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
