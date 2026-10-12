// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/thirdparty.mjs — 第三方通知渲染器 + SDK 声明同步（derive 的 thirdparty 任务）
//
// ## 通知是**包的一部分**，不是仓库的一部分
//
// 通知写的是「这个包里有什么」，而包内容取决于交付面（当前：纯 JS，无内嵌二进制）。
// 仓库里的源码并不「拥有」某个特定包的内容，所以**仓库里不存这份通知**：
// 它由 pack.mjs 在组装交付树时按实际内容渲染并落进包里。
//
// 这样有两个真好处：
//   · 不会漂：没有一份静态文件可以跟包不一致（以前需要 --check 去比，现在压根不存在两份）。
//   · 不会多：没有内嵌二进制的包里不会出现无关组件段落与条文。
//
// ## 版本号仍然是读的
//
// `vendor/hana-app-sdk/source-manifest.json` 的 `packedVersion` 是宿主打包时写死的 SDK 版本。
// 手抄版本号的结局是漂移：SDK 从 0.970.9 升到 1.0.16-beta 时，通知里还写着旧号（本项目实际发生过）。
// 所以版本号一律从快照读，不手抄、不猜。
//
// ## 许可正文的组织
//
// **法条与事实分开落点**：通知只陈述事实与对应关系，许可正文逐份放在 `licenses/`（随包）。
// `licenses/` 里两类内容：
//   · 静态正文（Apache-2.0 / GPL-3.0 / LGPL-3.0 / 两份 MIT）—— 上游不提供或不便随包：
//     SDK tarball 无 Apache 正文；react 不随包；OpenPGP.js 的库文件不携带自己的 LICENSE 附属件。
//   · SDK 自身的第三方声明 —— 从 tgz 现取（与版本同源，手抄必漂）。← 这个任务负责的那份
//
// ## 边界
//
//   · 只列**随包或内联**的组件。构建工具（rspack 等）不进产物，不列。
//   · 随包二进制的版本与 sha256 以 vendor/sources.json 为唯一事实源——这里读它，不重写一份。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { at } from "../shared/root.mjs";

/** 许可正文目录（仓库持有的静态原文 + 从 tgz 现取的 SDK 声明都落这里）。 */
export const LICENSES_DIR = at("licenses");
const SDK_MANIFEST = at("vendor", "hana-app-sdk", "source-manifest.json");
const SDK_TGZ = at("vendor", "hana-app-sdk", "hana-app-sdk.tgz");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 随包二进制组件 → 它要随带的许可正文文件名。当前无随包二进制（签名走纯 JS，见下）。 */
export const SHIPPED_COMPONENT_LICENSE = {};

/**
 * 恒定随包的第三方许可正文（与本包的交付内容无关，故恒定适用）。
 * SDK 与 react 是构建期内联进设置页产物的；LGPL 与 GPL 是随包独立库 OpenPGP.js 的。
 *
 * GPL-3.0 与 LGPL-3.0 成对：LGPLv3 的定义就是「GPLv3 加上若干额外许可」，
 * 其条文自身引用并依赖 GPLv3 正文，且 LGPL §4(b) 要求随附 GPL 与 LGPL 两份正文，
 * 所以两份必须一起随包。
 */
const SHIPPED_LICENSES = [
  "Apache-2.0.txt",
  "MIT-react.txt",
  "LGPL-3.0.txt",
  "GPL-3.0.txt",
  "hana-app-sdk-THIRD_PARTY_NOTICES.txt",
];

/** 随包 SDK 的版本（宿主打包时写入；唯一事实源）。 */
export function packedVersion() {
  const j = readJson(SDK_MANIFEST);
  const v = j && j.packedVersion;
  if (typeof v !== "string" || !v) throw new Error(`${SDK_MANIFEST} 没有 packedVersion`);
  return v;
}

/** 一组随包组件对应的许可正文清单（含恒定随包的那几份）。 */
export function licensesFor(shippedComponents) {
  const files = new Set(SHIPPED_LICENSES);
  for (const c of shippedComponents) {
    const f = SHIPPED_COMPONENT_LICENSE[c];
    if (f) files.add(f);
  }
  return [...files].sort();
}

/**
 * SDK 自身的第三方声明：从 tgz 里现取（与 SDK 版本同源，手抄必漂）。
 * @returns {string} 该文件应有的内容
 */
function sdkThirdPartyText() {
  const tmp = at(".tmp", "sdk-notices");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-xzf", SDK_TGZ, "-C", tmp], { stdio: "pipe" });
  const p = at(".tmp", "sdk-notices", "package", "dist", "THIRD_PARTY_NOTICES.txt");
  if (!fs.existsSync(p)) throw new Error("SDK tgz 里找不到 dist/THIRD_PARTY_NOTICES.txt");
  const text = fs.readFileSync(p, "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  return text;
}

/**
 * 渲染通知正文。
 *
 * @param {{ components: string[] }} opts
 *   components — **本份通知覆盖哪些随包二进制组件**。当前 sources.json 无任何组件（无内嵌二进制），
 *   所以正常仓态下它为空数组；参数保留给将来需要内嵌二进制时复用（与
 *   SHIPPED_COMPONENT_LICENSE / licensesFor 同一口径）。
 */
export function renderNotice({ components }) {
  const sdkVersion = packedVersion();
  const files = licensesFor(components);
  // 包里是否带了恒定随包的 LGPL 组件：OpenPGP.js 以随包独立库形态分发（见 build-app / build-shim），
  // 所以这一整段恒定适用。若将来把它换掉（改内联、或换成非 LGPL 库），这里要跟着改。
  const anyLgpl = files.includes("LGPL-3.0.txt");

  const L = [];
  L.push("# Third-Party Notices", "");
  L.push("Third-party components distributed with GitHana, and their license notices.");
  L.push("The project's own license is in `NOTICE` (MPL-2.0).", "");
  L.push("Generated at packaging time by `scripts/pack.mjs` (renderer: `scripts/derive/thirdparty.mjs`).");
  L.push(`The SDK version is read from \`packedVersion\` in \`vendor/hana-app-sdk/source-manifest.json\`.`);
  L.push("**Full license texts ship alongside this file in `licenses/`.** This file states what is in");
  L.push("**this package** and which text applies; it does not reproduce the texts themselves.", "");

  // ── LGPL 关系说明（法律立场，人写；包内有 LGPL 组件时出现）──
  //    这里的措辞是承重墙：它描述的是「我们如何履行 LGPL」，不是修饰性声明。
  //    改交付形态（把库重新内联、或换成静态合并）时这段必须同步重写，否则它就在说假话。
  if (anyLgpl) {
    L.push("## LGPL 组件与本项目的关系", "");
    L.push("包内只有 **OpenPGP.js**（`bin/openpgp.min.mjs`）是 LGPL-3.0-or-later；其余全部是本项目的 MPL-2.0 代码。");
    L.push("两者在同一个交付树里共存，但是**独立的作品**：", "");
    L.push("- 本项目的代码与 OpenPGP.js **不共享任何源文件**：它作为一份**独立、可替换的库文件**") 
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
    L.push("| §4(b) 随附 GPL 与 LGPL 正文 | `licenses/GPL-3.0.txt` + `licenses/LGPL-3.0.txt`（LGPL 条文引用 GPL，两份必须都带） |");
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
  }

  // ── 随包二进制 ──
  L.push("## 随安装包分发（内嵌运行时）", "");
  L.push("**本包不内嵌任何二进制。** 运行时不需要外部可执行文件：");
  L.push("- git 用宿主自带的 `<HANA_ROOT>/resources/git`；");
  L.push("- 签名由随包的纯 JS shim（`bin/gpg.shim.mjs`，OpenPGP.js 为同目录运行期库 `bin/openpgp.min.mjs`）完成，不再有随包 GnuPG；");
  L.push("- GitHub 请求由随包的 `bin/rest.worker.mjs` 直发。", "");
  L.push("### git（不随包）", "");
  L.push("- Form: **始终不随包**。宿主 Hana 自带 `<HANA_ROOT>/resources/git`（Git for Windows），App 通过");
  L.push("  `app/process.spawn` 直接使用它（详见 `tools/lib/bin.js` 的平台通用解析）。");
  L.push("- License: 随宿主那份分发，其自己的 `LICENSE.txt` 就在宿主安装目录里，不由本包再带一份。", "");
  L.push("### GitHub 域（无外部二进制）", "");
  L.push("- Form: **不随任何二进制**。GitHub 的 REST 请求由随包的 `bin/rest.worker.mjs` 在子进程里直发");
  L.push("  （Node 内置 `fetch`，无第三方依赖）。");
  L.push("- 历史上随包的是 gh CLI（MIT）；改用自写 REST 后它已不在包内。", "");

  // ── 随包独立库（运行期加载，非内联）──
  L.push("## 随包的独立库文件（运行期加载）", "");
  L.push("### openpgp（OpenPGP.js）6.3.2", "");
  L.push("- Purpose: 签名与验签（设置页的密钥生成、`git_commit` 的 `gpgsig`）—— 顶替原先随包的 GnuPG");
  L.push("- Form: 一份**独立、可替换的库文件** `bin/openpgp.min.mjs`（上游 npm 发行物");
  L.push("  `dist/node/openpgp.min.mjs` 原样未修改）；由 `bin/app.mjs` 与 `bin/gpg.shim.mjs`");
  L.push("  在**运行期**以相对路径 `import` 加载，其代码不被合并进这两个入口。");
  L.push("  构建期由 `scripts/build-app.mjs` 从 `node_modules/openpgp/dist/node/` 投影进来，");
  L.push("  并以 sha256 断言与上游逐字节相同。npm 包自身（含其 `.map` / 类型文件）不随包。");
  L.push("- Source: https://github.com/openpgpjs/openpgpjs（原样未修改）");
  L.push("- License: LGPL-3.0-or-later —— 正文见 `licenses/LGPL-3.0.txt`", "");

  // ── 构建期内联 ──
  L.push("## 构建期内联（打进设置页产物）", "");
  L.push("这些包在构建时被打进设置页产物，其原始包**不随安装包分发**，故在此列出。", "");
  L.push(`### @hana/app-sdk ${sdkVersion}`, "");
  L.push("- Purpose: 宿主设置页组件（`AppUiProvider` / `SettingsPage` / `SettingsRow` …）与契约类型，");
  L.push("  让设置页与宿主观感一致");
  L.push("- Form: 构建期依赖（`vendor/hana-app-sdk/hana-app-sdk.tgz`，官方 SDK 不在 npm 上），");
  L.push("  经 rspack 内联进设置页产物 `ui/settings.bundle.js` / `.css`；tarball 本身不随安装包");
  L.push("- Source: 随宿主分发的 Hana App Creator SDK（快照见 `vendor/hana-app-sdk/`，含 `source-manifest.json`）");
  L.push("- License: Apache-2.0 —— 正文见 `licenses/Apache-2.0.txt`");
  L.push("- 该包自身的第三方声明（其内部又内联了其它组件）：见 `licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt`", "");
  L.push("### react / react-dom 19.3.0", "");
  L.push("- Purpose: 上述宿主组件的 peer 依赖，内联进设置页产物 `ui/settings.bundle.js`");
  // react 与 SDK 的 npm 包都不随包（只有编译后的代码在 bundle 里），所以正文必须随 licenses/ 走。
  L.push("- License: MIT —— 正文见 `licenses/MIT-react.txt`（该包不随包分发，正文由本仓库持有）", "");

  // ── 官方作者工具 ──
  L.push("## 官方作者工具（哪些能自足、哪些不能）", "");
  L.push("| 工具 | 位置 | 说明 |");
  L.push("|------|------|------|");
  L.push("| `extension-index-build.mjs` | **仓库内拷贝**（`scripts/hana-app-tools/`） | 只依赖 node 内建，可独立运行 → 已在仓库，使市场清单在任何 runner 上都能出 |");
  L.push("| `validate-app.mjs`（静态校验） | 只在宿主 | import 了 Hana 内部包（`@earendil-works/pi-coding-agent` 等），**不能**拷进仓库独立运行；有就用、没有就标 `unverified` |");
  L.push("| `extension-pack.mjs` | 不用 | 需要 jsdom + sharp（原生）；包由本仓库 `scripts/pack.mjs` 自己出 |", "");
  L.push("具体收录判定与升级方式：见 `scripts/hana-app-tools/README.md`。", "");

  // ── 许可正文索引（只列本份通知适用的那几份）──
  L.push("## 许可正文索引（`licenses/`）", "");
  L.push("| 文件 | 许可 | 适用组件 |");
  L.push("|------|------|----------|");
  const indexRow = {
    "Apache-2.0.txt": ["Apache License 2.0", "@hana/app-sdk（构建期内联）"],
    "MIT-react.txt": ["MIT (Copyright Meta Platforms, Inc. and affiliates)", "react / react-dom（构建期内联）"],
    "LGPL-3.0.txt": ["GNU LGPL v3", "openpgp / OpenPGP.js（随包独立库 bin/openpgp.min.mjs，运行期加载）"],
    "GPL-3.0.txt": ["GNU GPL v3", "LGPLv3 的基底（LGPL 条文引用它，§4(b) 要求两份都随包）"],
    "hana-app-sdk-THIRD_PARTY_NOTICES.txt": ["混合（含 MIT / ISC / Apache-2.0 等）", "@hana/app-sdk 内联的第三方依赖"],
  };
  for (const f of files) {
    const r = indexRow[f];
    if (r) L.push(`| \`${f}\` | ${r[0]} | ${r[1]} |`);
  }
  L.push("");

  return L.join("\n");
}

/**
 * 任务：thirdparty —— 随包 SDK 的 tgz → licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt
 * （它是派生的；其余正文是仓库持有的静态原文，人写的法律文本不进派生表）。
 */
export const thirdpartyTask = {
  name: "thirdparty",
  about: "vendor/hana-app-sdk 的 tgz 内声明 → licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt",
  plan: () => [{ rel: "licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt", content: sdkThirdPartyText() }],
};
