// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/thirdparty.mjs — 第三方通知渲染器 + SDK 声明同步（derive 的 thirdparty 任务）
//
// ## 通知是**包的一部分**，不是仓库的一部分
//
// 通知写的是「这个包里有什么」，而包内容取决于 target（universal 带全平台 gnupg；
// 其余平台不带内嵌二进制）。仓库里的源码并不「拥有」某个特定包的内容，所以**仓库里不存这份通知**：
// 它由 pack.mjs 在组装交付树时按实际内容渲染并落进包里。
//
// 这样有两个真好处：
//   · 不会漂：没有一份静态文件可以跟包不一致（以前需要 --check 去比，现在压根不存在两份）。
//   · 不会多：只带 gnupg 的包里不会出现无关组件段落与条文。
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
//   · 静态正文（Apache-2.0 / GPL-3.0 / 两份 MIT）—— 上游不提供（GnuPG 官方 Windows
//     安装器只有 README 声明、无 COPYING；SDK tarball 无 Apache 正文），只能由仓库持有原文。
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
const SOURCES = at("vendor", "sources.json");
const SDK_TGZ = at("vendor", "hana-app-sdk", "hana-app-sdk.tgz");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 随包二进制组件 → 它要随带的许可正文文件名。 */
export const SHIPPED_COMPONENT_LICENSE = {
  gnupg: "GPL-3.0.txt",
};

/**
 * 恒定内联的组件（设置页产物始终随包，故这些正文恒定适用）。
 * 它们不在 vendor 里，是 rspack 在构建期打进来的，所以不参与「包里有没有」的判断。
 */
const INLINED_LICENSES = ["Apache-2.0.txt", "MIT-react.txt", "hana-app-sdk-THIRD_PARTY_NOTICES.txt"];

/** 随包 SDK 的版本（宿主打包时写入；唯一事实源）。 */
export function packedVersion() {
  const j = readJson(SDK_MANIFEST);
  const v = j && j.packedVersion;
  if (typeof v !== "string" || !v) throw new Error(`${SDK_MANIFEST} 没有 packedVersion`);
  return v;
}

/** 随包二进制的事实（版本/来源）从 sources.json 读，与 fetch-vendor 同源。 */
export function vendorFacts(component) {
  const s = readJson(SOURCES);
  for (const [platform, entry] of Object.entries(s.platforms || {})) {
    const c = entry.components && entry.components[component];
    if (c) return { ...c, platform };
  }
  return null;
}

/** 一组随包组件对应的许可正文清单（含恒定内联的那几份）。 */
export function licensesFor(shippedComponents) {
  const files = new Set(INLINED_LICENSES);
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
 *   components — **本份通知覆盖哪些随包二进制组件**（如 ["gh","gnupg"]）。
 *   打包级传该包里真实存在的组件（pack 用 shippedComponentsInStage 算出来）。
 */
export function renderNotice({ components }) {
  const sdkVersion = packedVersion();
  const has = (c) => components.includes(c);
  const gnupg = has("gnupg") ? vendorFacts("gnupg") : null;
  // 只有包里真的带了 GPL 组件时才谈 GPL（MinGit 从不随包，故它不参与这个判断）。
  const anyGpl = Boolean(gnupg);
  const files = licensesFor(components);

  const L = [];
  L.push("# Third-Party Notices", "");
  L.push("Third-party components distributed with GitHana, and their license notices.");
  L.push("The project's own license is in `NOTICE` (MPL-2.0).", "");
  L.push("Generated at packaging time by `scripts/pack.mjs` (renderer: `scripts/derive/thirdparty.mjs`).");
  L.push(`The SDK version is read from \`packedVersion\` in \`vendor/hana-app-sdk/source-manifest.json\`;`);
  L.push("the vendored binary versions come from `vendor/sources.json`.", "");
  L.push("**Full license texts ship alongside this file in `licenses/`.** This file states what is in");
  L.push("**this package** and which text applies; it does not reproduce the texts themselves.", "");

  // ── GPL 关系说明（法律立场，人写；只有包里真有 GPL 组件时才出现）──
  if (anyGpl) {
    L.push("## GPL 组件与本项目的关系", "");
    L.push("随包分发的 `GnuPG` 是**独立程序**，本项目：", "");
    L.push("- **不链接、不改写、不内联**它们的代码 —— 只通过 `app/process.spawn` 以子进程方式调用");
    L.push("  （传 argv 与 env），这与 git 自己调用 `gpg` 是同一种关系；");
    L.push("- 分发时它们**原样未修改**，与我们的 MPL-2.0 代码在同一个归档里共存，属于**聚合分发**");
    L.push("  （mere aggregation），不构成衍生作品，因此**不会把 MPL 代码\"传染\"成 GPL**；");
    L.push("- 反向也自洽：`NOTICE` 里那句 `Incompatible With Secondary Licenses` 限制的是**本项目的 MPL");
    L.push("  代码**不得被以 GPL 等次级许可再发布，它不给这些 GPL 组件增加任何额外限制。", "");
    L.push("**要保持的不变量**：永不把 GPL 组件链接/内联进我们的产物（打进 `ui/dist/settings.bundle.js` 的");
    L.push("只有 React(MIT) 与 @hana/app-sdk(Apache-2.0)）。一旦破坏这条线，上面的结论就不成立了。", "");
    L.push("**GPL 要求我们履行的**（作为这些二进制的再分发者）：", "");
    L.push("1. 随包附上许可正文 —— 见 `licenses/` 下的 GPL 文本；");
    L.push("2. 让对应源码可得 —— 下列条目各自标注了**确切的上游版本与源码地址**（均为未修改的原版）；");
    L.push("3. 不对这些组件附加超出其许可的限制 —— 我们没有任何附加条款。", "");
  }

  // ── 随包二进制 ──
  L.push("## 随安装包分发（内嵌运行时）", "");
  L.push("二进制不入版本库：来源与 sha256 由 `vendor/sources.json` 声明，`scripts/fetch-vendor.mjs`");
  L.push("按 `<platform>-<arch>` 重建；落盘只保留该表 `keep` 声明的条目，最终形态是");
  L.push("`bin/<platform>/<exe>`（产物侧，构建期由 `build-app` 从 `vendor/bin/` 投影过去）。", "");

  if (gnupg) {
    L.push("### GnuPG", "");
    L.push(`- Version: ${gnupg.version}`);
    L.push("- Purpose: 隔离环内的 GPG 签名与验签（设置页的密钥生成、`git_commit` 签名、`gpgconf` 收尾）");
    L.push("- Form: 取自官方 Windows 安装器（NSIS/7z 容器）的 `bin/`，**未修改**；置备时删除 `gpgconf.ctl`");
    L.push("  （使其认 `GNUPGHOME` env —— 隔离签名的前提）");
    L.push(`- Source: ${gnupg.url}`);
    L.push("- License: GPL-3.0-or-later —— 正文见 `licenses/GPL-3.0.txt`");
    L.push("- 上游的 Windows 安装器只带 `README.txt` 的版权声明、**不含 COPYING 正文**，故正文由本仓库持有。", "");
  }
  L.push("### git（不随包）", "");
  L.push("- Form: **始终不随包**。宿主 Hana 自带 `<HANA_ROOT>/resources/git`（Git for Windows），App 通过");
  L.push("  `app/process.spawn` 直接使用它（详见 `tools/lib/bin.js` 的平台通用解析）。");
  L.push("- License: 随宿主那份分发，其自己的 `LICENSE.txt` 就在宿主安装目录里，不由本包再带一份。", "");
  L.push("### GitHub 域（无外部二进制）", "");
  L.push("- Form: **不随任何二进制**。GitHub 的 REST 请求由随包的 `bin/rest-worker.mjs` 在子进程里直发");
  L.push("  （Node 内置 `fetch`，无第三方依赖）。");
  L.push("- 历史上随包的是 gh CLI（MIT）；改用自写 REST 后它已不在包内。", "");

  // ── 构建期内联 ──
  L.push("## 构建期内联（打进 `ui/dist/settings.bundle.js`）", "");
  L.push("这些包在构建时被打进设置页产物，其原始包**不随安装包分发**，故在此列出。", "");
  L.push(`### @hana/app-sdk ${sdkVersion}`, "");
  L.push("- Purpose: 宿主设置页组件（`AppUiProvider` / `SettingsPage` / `SettingsRow` …）与契约类型，");
  L.push("  让设置页与宿主观感一致");
  L.push("- Form: 构建期依赖（`vendor/hana-app-sdk/hana-app-sdk.tgz`，官方 SDK 不在 npm 上），");
  L.push("  经 rspack 内联进 `ui/dist/settings.bundle.js` / `.css`；tarball 本身不随安装包");
  L.push("- Source: 随宿主分发的 Hana App Creator SDK（快照见 `vendor/hana-app-sdk/`，含 `source-manifest.json`）");
  L.push("- License: Apache-2.0 —— 正文见 `licenses/Apache-2.0.txt`");
  L.push("- 该包自身的第三方声明（其内部又内联了其它组件）：见 `licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt`", "");
  L.push("### react / react-dom 19.3.0", "");
  L.push("- Purpose: 上述宿主组件的 peer 依赖，内联进 `ui/dist/settings.bundle.js`");
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
    "GPL-3.0.txt": ["GNU GPL v3", "GnuPG（随包）"],
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
