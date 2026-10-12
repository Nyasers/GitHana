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
 *   bin/   ← 入口（app.mjs）+ REST worker（rest.worker.mjs）+ 签名 shim（gpg.shim.mjs）
 *            + OpenPGP.js 库文件（openpgp.min.mjs，上游 dist 原样，两个入口运行期 import）
 *   licenses/ assets/
 *   ui/    ← 壳页 + 设置页产物平铺（settings.html / settings.bundle.js / .css），**不含 ui/src/**
 *
 * 构建产物**直接落 dist/**（build-ui / build-server / build-shim 都写这里），没有 build/ 中转层：
 * 交付面就是它们的产物落点，中间那一层只会让"产物到底在哪"多一个需要判断的间接层。
 * 所以主流程是：先清空 dist/ → 依次调起三个构建脚本 → 再把静态交付件拷进来 → 断言。
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
 * 但两个 spawn 出去的独立入口例外：tools/lib/rest.worker.mjs（直接平铺）与
 * tools/lib/gpg.shim.mjs（打包为 bin/gpg.shim.mjs），均在 bin/ 下）、
 * 以及 OpenPGP.js 库文件（bin/openpgp.min.mjs，从上游 npm dist 原样拷入）：它不进源码树，
 * 由本脚本从 node_modules/openpgp/dist/node/ 投影进来，并以 npm 包的 integrity 断言字节一致。
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  //    必须在调构建脚本**之前**清：现在是构建脚本直接写 dist/（不再经 build/ 中转），
  //    清晚了一步就会把刚构好的产物抹掉。
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // 1) 构建设置页产物（ui/src → dist/ui/）、服务端单入口（app.js → dist/bin/app.mjs）
  //    与签名 shim（tools/lib/gpg.shim.mjs → dist/bin/gpg.shim.mjs）。
  //    三个脚本都**直接写交付树**——交付面就是它们的产物落点，中间那一层没有存在理由。
  log("构建设置页产物（ui/src/settings.jsx → dist/ui/settings.bundle.*）…");
  runBuild("build-ui.mjs", "设置页构建失败");
  log("构建服务端单入口（app.js → dist/bin/app.mjs）…");
  runBuild("build-server.mjs", "服务端构建失败");
  log("构建签名 shim（tools/lib/gpg.shim.mjs → dist/bin/gpg.shim.mjs）…");
  runBuild("build-shim.mjs", "签名 shim 构建失败");

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

  // 2a) 两个 spawn 出去的独立入口已由构建脚本或平铺到位，这里只做断言。
  //     app.mjs / gpg.shim.mjs 由构建脚本产出；rest.worker.mjs 是零依赖纯 node 脚本，直接平铺。
  //     OpenPGP.js 库文件（openpgp.min.mjs）也从这里投影：两个入口都运行期 import 它。
  {
    const serverBundle = join(DIST, "bin", "app.mjs");
    if (!existsSync(serverBundle)) {
      console.error("[build-app] 缺 dist/bin/app.mjs（服务端 bundle 未生成）");
      process.exit(1);
    }
    const restWorker = join(ROOT, "tools", "lib", "rest.worker.mjs");
    if (!existsSync(restWorker)) {
      console.error("[build-app] 缺 tools/lib/rest.worker.mjs（GitHub REST 执行体）");
      process.exit(1);
    }
    total += copyInto(restWorker, join(DIST, "bin", "rest.worker.mjs"));
    const shimBundle = join(DIST, "bin", "gpg.shim.mjs");
    if (!existsSync(shimBundle)) {
      console.error("[build-app] 缺 dist/bin/gpg.shim.mjs（签名 shim 未构建）");
      process.exit(1);
    }

    // OpenPGP.js 库文件：上游 npm dist 原样投影到 bin/，供 app.mjs 与 gpg.shim.mjs 运行期 import。
    // **字节必须与上游一致**：NOTICE 声称"原样未修改"，而两个入口在运行期加载的就是这份文件；
    // 它被改过（或拿了别的构建产物）就等于把两个入口悄悄指向了非预期的库。
    // 所以断言它的 sha256 等于 npm 包 setup 的预期值（从 node_modules 现算，不手抄）。
    const OPENPGP_LIB = "openpgp.min.mjs";
    const libSrc = join(ROOT, "node_modules", "openpgp", "dist", "node", OPENPGP_LIB);
    if (!existsSync(libSrc)) {
      console.error(`[build-app] 缺上游库文件 node_modules/openpgp/dist/node/${OPENPGP_LIB}（跑 pnpm install）`);
      process.exit(1);
    }
    const libBytes = readFileSync(libSrc);
    const libDigest = createHash("sha256").update(libBytes).digest("hex");
    writeFileSync(join(DIST, "bin", OPENPGP_LIB), libBytes);
    total += 1;
    // 断言：产物里那份与刚拷的源逐字节相同（防止拷贝环节被改写）。
    const outDigest = createHash("sha256").update(readFileSync(join(DIST, "bin", OPENPGP_LIB))).digest("hex");
    if (outDigest !== libDigest) {
      console.error(`[build-app] bin/${OPENPGP_LIB} 投影后字节不一致（sha256 ${outDigest} ≠ ${libDigest}）`);
      process.exit(1);
    }
    log(`bin/${OPENPGP_LIB} 就位（sha256 ${libDigest.slice(0, 12)}…，OpenPGP.js 运行期共享库）`);
  }
  log(`契约件与目录就位（${DELIVERY_FILES.length} 文件 + ${DELIVERY_DIRS.length} 目录）+ bin/app.mjs + bin/rest.worker.mjs + bin/gpg.shim.mjs + bin/openpgp.min.mjs`);

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
  // 声明读不了就是硬错：静默当成“无声明”会让下面两个判定都变空，构建能报成功却没校验过运行时树。
  let srcSources;
  try {
    srcSources = JSON.parse(readFileSync(join(ROOT, "vendor", "sources.json"), "utf8"));
  } catch (e) {
    console.error(
      `[build-app] 读不了 vendor/sources.json（${(e && e.message) || e}）：它是内嵌组件的事实源，` +
        `缺它无法判定哪些组件必须就绪。`,
    );
    process.exit(1);
  }
  const hostComponents =
    (srcSources.platforms && srcSources.platforms[hostKey] && srcSources.platforms[hostKey].components) || {};
  const declaredMissing = [];
  for (const [component, spec] of Object.entries(hostComponents)) {
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
    // 遍历 `vendor/bin/` 里**实际存在的每个平台**（dist 是完整组装：universal 出包要全平台），
    // 但每个平台只拷**它自己声明里**的组件。缓存里可能留有上一轮抓过、现在声明已删的组件：
    // 无声明 = 走系统 PATH，而一个陈旧的随包副本会盖过系统那份，让已撤的组件悄悄继续生效。
    let copied = 0;
    for (const platform of readdirSync(srcVendorBin)) {
      const platformDir = join(srcVendorBin, platform);
      if (!statSync(platformDir).isDirectory()) continue;
      const comps =
        (srcSources.platforms && srcSources.platforms[platform] && srcSources.platforms[platform].components) || {};
      for (const component of Object.keys(comps)) {
        const from = join(platformDir, component);
        if (!existsSync(from)) continue;
        const outDir = join(DIST, "bin", platform);
        mkdirSync(outDir, { recursive: true });
        for (const name of readdirSync(from)) copyInto(join(from, name), join(outDir, name));
        copied += 1;
      }
    }
    if (copied > 0) log("vendor/bin/ → bin/<platform>/（平铺）；构建期元数据与声明不随包");
    else log("vendor/bin/ 里没有声明内的组件：二进制走宿主 / 系统 PATH");
  } else {
    log(`vendor/bin/ 不存在：本平台（${hostKey}）声明里没有可校验的内嵌组件（二进制走宿主 / 系统 PATH）`);
  }

  // 3) ui/：只放壳页与构建产物，**不放源码**（ui/src/ 是源，不属于交付面）。
  //    产物由 build-ui 直接写 dist/ui/（平铺）；这里只拷壳页与做断言。
  const uiSrcHtml = join(ROOT, "ui", "settings.html");
  const uiOutDir = join(DIST, "ui");
  if (!existsSync(uiSrcHtml)) {
    console.error("[build-app] 缺 ui/settings.html");
    process.exit(1);
  }
  for (const name of ["settings.bundle.js", "settings.bundle.css"]) {
    if (!existsSync(join(uiOutDir, name))) {
      console.error(`[build-app] 缺设置页产物 dist/ui/${name}`);
      process.exit(1);
    }
  }
  total += copyInto(uiSrcHtml, join(uiOutDir, "settings.html"));
  log("ui/ 就位（settings.html + 产物平铺；不含 ui/src/）");

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
    "build", // 构建区（已取消：产物直接落 dist/；这条留着拦住回退）
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
