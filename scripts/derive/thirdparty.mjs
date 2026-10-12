// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/thirdparty.mjs — 第三方通知（THIRD_PARTY_NOTICES.md）生成器
//
// ## 一份文件讲完第三方
//
// 组件声明与**适用的许可正文全文**都在同一份 `THIRD_PARTY_NOTICES.md` 里。交付面因此只有三件
// 与许可有关的文件：`LICENSE`（本项目 MPL-2.0 全文）、`NOTICE`（本项目声明）、
// `THIRD_PARTY_NOTICES.md`（第三方）。不再有 `licenses/` 目录：法条正文与它描述的组件同处一份，
// 读的人不必在两处之间对照（旧形态是「一份汇总 + 一目录散装」，同一件事两个落点）。
//
// ## 它入库，由本任务生成
//
// 与 DSHana 同形：`THIRD_PARTY_NOTICES.md` 是仓库里的生成物，`derive` 写回、`--check` 防漂。
// 「不入库、由 pack 现渲染」的旧做法是为「包内容随 target 变」服务的；当前无内嵌二进制，
// 各 target 的交付内容相同，那个前提不成立，随之取消。
//
// ## 只列**本包真的分发**的组件
//
// 下面那张事实表（每个组件为什么在包里、以什么形态进来）是人写的知识；版本号一律从实装读，
// 不手抄。判据是「代码进不进交付面」，不是「是不是依赖」：构建工具（rspack 等）不进产物，不列。
//
// 典型陷阱：`@hana/app-sdk` 自带的 `THIRD_PARTY_NOTICES.txt`（91 KB、80 个包）描述的是它的
// `app-ui.js` 产物；本 App 只内联它的 `components` / `ui` 入口，antd 生态一个字节都没进包。
// 所以那份文件整份搬运即失真——这里只列本包实际含有的组件。它仍被读，但只作**数据源**
// （取 SDK 内联那几个包的版本），不随包分发。
//
// ## 法条正文逐字节取自仓库
//
// 正文原文存 `scripts/derive/licenses/`（**不随包**），拼接时只做 `trimEnd()` 与分隔行，
// 不改正文内容。上游不提供单独正文的（SDK tarball 无 Apache 正文）由仓库持有；可与实装对齐的
// （MIT(Meta) 与 react 的 LICENSE、LGPL 与 OpenPGP.js 的 LICENSE 均逐字节相同）也已核对过。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { at } from "../shared/root.mjs";

/** 法条正文原文目录（仓库持有，不随包）。 */
const LICENSE_SRC = at("scripts", "derive", "licenses");
const SDK_MANIFEST = at("vendor", "hana-app-sdk", "source-manifest.json");
const SDK_TGZ = at("vendor", "hana-app-sdk", "hana-app-sdk.tgz");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 随包 SDK 的版本（宿主打包时写入；唯一事实源）。 */
export function packedVersion() {
  const j = readJson(SDK_MANIFEST);
  const v = j && j.packedVersion;
  if (typeof v !== "string" || !v) throw new Error(`${SDK_MANIFEST} 没有 packedVersion`);
  return v;
}

/** 法条正文：读仓库里那份，只去尾部空白（不重排、不改字）。 */
function licenseText(file) {
  const p = path.join(LICENSE_SRC, file);
  if (!fs.existsSync(p)) throw new Error(`缺法条正文：${file}（应在 scripts/derive/licenses/ 下，且必须由仓库持有）`);
  return fs.readFileSync(p, "utf8").trimEnd();
}

/** 某个包的实装版本（从它的 package.json 读，不手抄）。 */
function installedVersion(name) {
  const p = at("node_modules", name, "package.json");
  if (!fs.existsSync(p)) throw new Error(`读不到 ${name} 的 package.json（跑 pnpm install）`);
  return readJson(p).version;
}

/** scheduler 不在顶层（它是 react-dom 的内联依赖）：从 .pnpm 目录名解析。 */
function schedulerVersion() {
  const base = at("node_modules", ".pnpm");
  const dir = fs.existsSync(base) ? fs.readdirSync(base).find((n) => /^scheduler@\d/.test(n)) : null;
  if (!dir) throw new Error("找不到 scheduler（react-dom 的内联依赖）；跑 pnpm install");
  return dir.slice("scheduler@".length);
}

/**
 * `@hana/app-sdk` 的 components 产物内联了哪些第三方包、各是什么版本。
 *
 * 从 SDK 自己的 `dist/THIRD_PARTY_NOTICES.txt` 取（那是它打包器写下的记录，不是我们猜的）。
 * 这些包不在本仓 `node_modules` 里（是 SDK 内联进来的），所以版本只能从该声明读。
 * 缺声明即拒：宁可构建失败，也不产出一份漏了组件的合规文件。
 */
function sdkInlinedVersions(wanted) {
  const tmp = at(".tmp", "sdk-notices");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", SDK_TGZ, "-C", tmp], { stdio: "pipe" });
    const p = path.join(tmp, "package", "dist", "THIRD_PARTY_NOTICES.txt");
    if (!fs.existsSync(p)) {
      throw new Error("SDK tgz 里找不到 dist/THIRD_PARTY_NOTICES.txt（无法确认它的内联依赖）");
    }
    const text = fs.readFileSync(p, "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^(@?[A-Za-z0-9._/-]+)@([0-9][^\s]*)$/.exec(line.trim());
      if (m && wanted.includes(m[1]) && !(m[1] in out)) out[m[1]] = m[2];
    }
    const missing = wanted.filter((w) => !(w in out));
    if (missing.length) throw new Error(`SDK 声明里找不到这些内联包：${missing.join(", ")}`);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 各包对应的许可正文文件（同名正文只落一份，多个组件共享同一段）。 */
const TEXT = {
  apache: "apache-2.0.txt",
  mitMeta: "mit-meta.txt",
  lgpl: "lgpl-3.0.txt",
  gpl: "gpl-3.0.txt",
};

/** 许可正文全文段落（标题 + 分隔线 + 原文；原文逐字节不改）。 */
function licenseSections() {
  const section = (title, body) =>
    ["--------------------------------------------------------------------------------", "", title, "", body, ""].join("\n");
  return [
    section("Apache License 2.0", licenseText(TEXT.apache)),
    section("MIT License (Copyright (c) Meta Platforms, Inc. and affiliates.)", licenseText(TEXT.mitMeta)),
    section("GNU Lesser General Public License v3.0", licenseText(TEXT.lgpl)),
    section("GNU General Public License v3.0", licenseText(TEXT.gpl)),
  ];
}

/**
 * 组件事实表。人工知识（为什么在包里、以什么形态进来）在人写的字段里；版本从实装读。
 * 分两类：构建期内联（原始包不随包，必须由我们代为声明）、随包的独立库文件。
 */
function componentTable() {
  const sdkV = packedVersion();
  const sdkInlined = sdkInlinedVersions(["react-is", "use-sync-external-store"]);
  return {
    inlined: [
      {
        name: "@hana/app-sdk",
        version: sdkV,
        license: "Apache License 2.0",
        purpose: "宿主设置页组件（`AppUiProvider` / `SettingsPage` / `SettingsRow` …）与契约类型，让设置页与宿主观感一致。",
        form: "构建期依赖（`vendor/hana-app-sdk/hana-app-sdk.tgz`，官方 SDK 不在 npm 上），经 rspack 内联进 `ui/settings.bundle.js` / `.css`；tarball 本身不随包。",
        source: "随宿主分发的 Hana App Creator SDK（快照见 `vendor/hana-app-sdk/`，含 `source-manifest.json`）",
      },
      {
        name: "react",
        version: installedVersion("react"),
        license: "MIT License",
        purpose: "上述宿主组件的 peer 依赖（运行时）。",
        form: "构建期依赖（npm），经 rspack 内联进 `ui/settings.bundle.js`；npm 包自身不随包。",
      },
      {
        name: "react-dom",
        version: installedVersion("react-dom"),
        license: "MIT License",
        purpose: "react 的 DOM 渲染器，设置页 `createRoot` 用它挂载。",
        form: "构建期依赖（npm），经 rspack 内联进 `ui/settings.bundle.js`；npm 包自身不随包。",
      },
      {
        name: "scheduler",
        version: schedulerVersion(),
        license: "MIT License",
        purpose: "react-dom 的调和调度器（内联依赖）。",
        form: "随 react-dom 一起被 rspack 内联进 `ui/settings.bundle.js`；不在交付面单独出现。",
      },
      {
        name: "react-is",
        version: sdkInlined["react-is"],
        license: "MIT License",
        purpose: "由 `@hana/app-sdk` 的 components 产物内联进来（判定 React 元素类型）。",
        form: "不在本包 `node_modules` 里；随 SDK 的 components 产物一起被打进 `ui/settings.bundle.js`。",
      },
      {
        name: "use-sync-external-store",
        version: sdkInlined["use-sync-external-store"],
        license: "MIT License",
        purpose: "由 `@hana/app-sdk` 的 components 产物内联进来（外部状态订阅）。",
        form: "不在本包 `node_modules` 里；随 SDK 的 components 产物一起被打进 `ui/settings.bundle.js`。",
      },
    ],
    shipped: [
      {
        name: "openpgp（OpenPGP.js）",
        version: installedVersion("openpgp"),
        license: "GNU LGPL v3.0 or later",
        purpose: "签名与验签（设置页的密钥生成、`git_commit` 的 `gpgsig`）—— 顶替原先随包的 GnuPG。",
        form: "一份**独立、可替换的库文件** `bin/openpgp.min.mjs`（上游 npm 发行物 `dist/node/openpgp.min.mjs` 原样未修改）；由 `bin/app.mjs` 与 `bin/gpg.shim.mjs` 在**运行期**以相对路径 `import` 加载。构建期由 `scripts/build-app.mjs` 从 `node_modules/openpgp/dist/node/` 投影进来，并以 sha256 断言与上游逐字节相同。npm 包自身（含其 `.map` / 类型文件）不随包。",
        source: "https://github.com/openpgpjs/openpgpjs（原样未修改）",
      },
    ],
  };
}

/** 生成整份 THIRD_PARTY_NOTICES.md。 */
function render() {
  const { inlined, shipped } = componentTable();

  const L = [];
  L.push("# Third-Party Notices", "");
  L.push("Third-party components distributed with GitHana, and their license notices.");
  L.push("The project's own license is in `NOTICE` (MPL-2.0) and `LICENSE` (full text).", "");
  L.push("Generated by `node scripts/derive/index.mjs thirdparty` — do not edit by hand.");
  L.push("Component versions are read from what is actually installed; the SDK version is read from");
  L.push("`packedVersion` in `vendor/hana-app-sdk/source-manifest.json`.", "");
  L.push("**This file is self-contained**: the full text of every applicable license is reproduced at the");
  L.push("bottom. It lists **only what this package actually distributes** — build-time tools that do not");
  L.push("reach the artifact are not listed.", "");

  // ── 组件清单 ──
  L.push("## Components in this package", "");
  L.push("| Component | Version | License | Form |");
  L.push("|---|---|---|---|");
  for (const c of inlined) L.push(`| ${c.name} | ${c.version} | ${c.license} | 构建期内联 |`);
  for (const c of shipped) L.push(`| ${c.name} | ${c.version} | ${c.license} | 随包独立库（运行期加载） |`);
  L.push("");

  // ── 构建期内联 ──
  L.push("## Bundled at build time", "");
  L.push("These are inlined into `ui/settings.bundle.js` at build time. Their original packages and");
  L.push("`LICENSE` files are **not shipped**, so their notices are reproduced in this file.", "");
  for (const c of inlined) {
    L.push(`### ${c.name} ${c.version}`, "");
    L.push(`- Purpose: ${c.purpose}`);
    L.push(`- Form: ${c.form}`);
    if (c.source) L.push(`- Source: ${c.source}`);
    L.push(`- License: ${c.license}（正文见本文件末尾）`, "");
  }

  // ── 随包独立库 ──
  L.push("## Shipped as a standalone library file", "");
  for (const c of shipped) {
    L.push(`### ${c.name} ${c.version}`, "");
    L.push(`- Purpose: ${c.purpose}`);
    L.push(`- Form: ${c.form}`);
    if (c.source) L.push(`- Source: ${c.source}`);
    L.push(`- License: ${c.license}（正文见本文件末尾）`, "");
  }

  // ── 不随包的运行时 ──
  L.push("## Runtime not shipped with this package", "");
  L.push("- **git**: 宿主 Hana 自带 `<HANA_ROOT>/resources/git`（Git for Windows），App 通过");
  L.push("  `app/process.spawn` 直接使用它。它随宿主分发，其自己的 `LICENSE.txt` 就在宿主安装目录里，");
  L.push("  不由本包再带一份。");
  L.push("- **本包不内嵌任何二进制**：签名由随包的纯 JS shim（`bin/gpg.shim.mjs` + `bin/openpgp.min.mjs`）");
  L.push("  完成，GitHub 请求由随包的 `bin/rest.worker.mjs` 直发，都不需要外部可执行文件。", "");

  // ── LGPL 关系说明（法律立场，人写；包内有 LGPL 组件时出现）──
  //    这里的措辞是承重墙：它描述的是「我们如何履行 LGPL」，不是修饰性声明。
  //    改交付形态（把库重新内联、或换成静态合并）时这段必须同步重写，否则它就在说假话。
  L.push("## LGPL component and this project", "");
  L.push("包内只有 **OpenPGP.js**（`bin/openpgp.min.mjs`）是 LGPL-3.0-or-later；其余全部是本项目的 MPL-2.0 代码。");
  L.push("两者在同一个交付树里共存，但是**独立的作品**：", "");
  L.push("- 本项目的代码与 OpenPGP.js **不共享任何源文件**：它作为一份**独立、可替换的库文件**");
  L.push("  （`bin/openpgp.min.mjs`，上游 npm 发行物 `dist/node/openpgp.min.mjs` 原样未修改）随包，");
  L.push("  由 `bin/app.mjs` 与 `bin/gpg.shim.mjs` 在**运行期**以相对路径 `import` 加载；");
  L.push("- 我们只调用它公开的 API（`generateKey` / `sign` / `verify` / `readKey` …），**不改写、不合并**它的代码；");
  L.push("- 两边的许可各归各：本项目的部分仍是 MPL-2.0，OpenPGP.js 的部分仍是 LGPL-3.0-or-later。", "");
  L.push("**为什么这对两种许可都成立**：MPL-2.0 §3.3 第一句允许把本方 MPL 代码与其它作品组合成一个");
  L.push("Larger Work 分发（只要履行 MPL 对本方代码的义务）；它不因为对方是 (L)GPL 就受限。LGPL");
  L.push("反过来也不要求 Application 用 LGPL：§4 允许 Combined Work 整体按你选的条款走。", "");
  L.push("**LGPL §4 要求我们履行的**（作为这份 Combined Work 的分发者）：", "");
  L.push("| 条款 | 履行方式 |");
  L.push("|---|---|");
  L.push("| §4(a) 显著声明 | 本文件与 `NOTICE` —— 声明 OpenPGP.js 被使用且受 LGPL 约束 |");
  L.push("| §4(b) 随附 GPL 与 LGPL 正文 | 本文件末尾的 LGPLv3 与 GPLv3 全文（LGPL 条文引用 GPL，两份都必须在场） |");
  L.push("| §4(c) 版权声明 | 本包运行时不展示版权声明（无启动版权屏），不触发 |");
  L.push("| §4(d) 可替换性 | 走 **§4(d)(1)**：库以独立文件形态在**运行期**加载，详见下段 |");
  L.push("| §4(e) Installation Information | 不触发：仅在分发 User Product 且受 GPL §6 约束时才要求 |", "");
  L.push("**§4(d)(1) 的落点**：`bin/openpgp.min.mjs` 是一份**接口兼容即可替换**的独立文件：");
  L.push("它不在任何主程序内部，替换它不需要重新构建或重新链接我们这边任何东西。用户（或下游）");
  L.push("把一份接口兼容的修改版 OpenPGP.js 放到同一路径 `bin/openpgp.min.mjs`，两个入口下一次启动就加载它。");
  L.push("这条是它区别于「把库内联进 bundle」的关键——那是 §4(d)(0) 的重组路径，需要交付可重新组合的");
  L.push("源码与目标代码。本包选择前者，所以本包里没有必须随带的源码搬运物。", "");
  L.push("**要保持的不变量**：`bin/openpgp.min.mjs` 必须保持为一份**原样的上游发行物**（未经改写、未与他物合并）。");
  L.push("`scripts/build-app.mjs` 在每次构建时校验它与 `node_modules/openpgp/dist/node/openpgp.min.mjs` 逐字节相同。");
  L.push("只有保持原样，上面的 §4(d)(1) 论述才成立；一旦改写它或把它重新内联进入口，这套说法就失效。", "");

  // ── 法条正文全文 ──
  L.push("## Full license texts", "");
  L.push("以下为上文各组件的许可正文全文（逐字节取自上游 / 仓库持有的原文，未经改写）。", "");
  for (const s of licenseSections()) L.push(s);

  return L.join("\n");
}

/**
 * 任务：thirdparty —— 实装版本 + 仓库持有的法条正文 → THIRD_PARTY_NOTICES.md
 * （它与 SDK 的 tgz 同批，源包括：本包实装版本、仓库持有的静态正文、SDK 声明的内联包版本）。
 */
export const thirdpartyTask = {
  name: "thirdparty",
  about: "实装版本 + 仓库持有的法条正文 → THIRD_PARTY_NOTICES.md（本包第三方合规）",
  plan: () => [{ rel: "THIRD_PARTY_NOTICES.md", content: render() }],
};
