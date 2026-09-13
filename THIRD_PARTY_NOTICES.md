# Third-Party Notices

Third-party components distributed with GitHana, and their license notices.
The project's own license is in `NOTICE` (MPL-2.0). 许可正文放在 `licenses/`，随安装包一起分发。

## 本项目与这些 GPL 组件的关系（先说清楚，免得误会）

随包分发的 `GnuPG`(GPL-3.0) 与 `MinGit`(GPL-2.0) 都是**独立程序**，本项目：

- **不链接、不改写、不内联**它们的代码 —— 只通过 `app/process.spawn` 以子进程方式调用
  （传 argv 与 env），这与 git 自己调用 `gpg` 是同一种关系；
- 分发时它们**原样未修改**，与我们的 MPL-2.0 代码在同一个归档里共存，属于**聚合分发**
  （mere aggregation），不构成衍生作品，因此**不会把 MPL 代码"传染"成 GPL**；
- 反向也自洽：`NOTICE` 里那句 `Incompatible With Secondary Licenses` 限制的是**本项目的 MPL
  代码**不得被以 GPL 等次级许可再发布，它不给这些 GPL 组件增加任何额外限制。

**要保持的不变量**：永不把 GPL 组件链接/内联进我们的产物（打进 `ui/settings.bundle.js` 的
只有 React(MIT) 与 @hana/app-sdk(Apache-2.0)）。一旦破坏这条线，上面的结论就不成立了。

**GPL 要求我们履行的**（作为这些二进制的再分发者）：

1. 随包附上许可正文 —— 见 `licenses/GPL-3.0.txt`、`licenses/GPL-2.0.txt`；
2. 让对应源码可得 —— 下列条目各自标注了**确切的上游版本与源码地址**（均为未修改的原版）；
3. 不对这些组件附加超出其许可的限制 —— 我们没有任何附加条款。

## 随安装包分发（内嵌运行时）

二进制不入版本库：来源与 sha256 由 `vendor/sources.json` 声明，`scripts/fetch-vendor.mjs`
按 `<platform>-<arch>` 重建。

### gh CLI

- Version: 2.95.0
- Purpose: GitHub CLI —— PR 生命周期、`gh api`、认证复用
- Form: 官方单文件产物，**未修改**，按平台矩阵各自随包（`vendor/<platform>-<arch>/gh`）
- Source: https://github.com/cli/cli （tag `v2.95.0`）
- License: MIT —— 正文见 `licenses/MIT.txt`（与上游随附的 LICENSE 同文）

### GnuPG

- Version: 2.5.21（官方 Windows 构建 `gnupg-w32-2.5.21_20260702.exe`）
- Purpose: 隔离环内的 GPG 签名与验签（`gpg_keygen` 生成密钥、`git_commit` 签名、`gpgconf` 收尾）
- Form: 取自官方 Windows 安装器（NSIS/7z 容器）的 `bin/`，**未修改**；置备时删除 `gpgconf.ctl`
  （使其认 `GNUPGHOME` env —— 隔离签名的前提）
- Source: https://gnupg.org/download/ （ftp 归档 `binary/gnupg-w32-2.5.21_20260702.exe`）
- License: GPL-3.0-or-later —— 正文见 `licenses/GPL-3.0.txt`

### MinGit（Git for Windows）— 可选

- Version: 2.55.0.windows.1
- Purpose: git 操作的内嵌回退
- Form: 默认**不随包**。宿主 Hana 自带 `<HANA_ROOT>/resources/git`，App 通过 `app/process.spawn`
  直接使用它（详见 `tools/lib/bin.js` 的平台通用解析）；`sources.json` 保留声明，是为了
  "需要自包含包时一条命令重新抓取"：`node scripts/fetch-vendor.mjs git`
- Source: https://github.com/git-for-windows/git （tag `v2.55.0.windows.1`，asset `MinGit-2.55.0-64-bit.zip`）
- License: GPL-2.0 —— 正文见 `licenses/GPL-2.0.txt`

## 构建期内联（打进 `ui/settings.bundle.js`）

这些包在构建时被打进设置页产物，其原始包**不随安装包分发**，故在此列出。

### @hana/app-sdk 0.970.9

- Purpose: 宿主设置页组件（`AppUiProvider` / `SettingsPage` / `SettingsRow` …）与契约类型，
  让设置页与宿主观感一致
- Form: 构建期依赖（`build-deps/hana-app-sdk-0.970.9.tgz`，官方 SDK 不在 npm 上），
  经 esbuild 内联进 `ui/settings.bundle.js` / `.css`；tarball 本身不随安装包
- Source: 随宿主分发的 Hana App SDK
- License: Apache-2.0 —— 正文见 `licenses/Apache-2.0.txt`
- 该包自身的第三方声明（其内部又内联了其它组件）：`licenses/hana-app-sdk-THIRD_PARTY_NOTICES.txt`

### react / react-dom 19.3.0

- Purpose: 上述宿主组件的 peer 依赖，内联进 `ui/settings.bundle.js`
- License: MIT —— 正文见 `licenses/MIT.txt`

### esbuild 0.28.x

- Purpose: 打设置页产物（构建工具），**不进任何分发产物**
- License: MIT —— 同 `licenses/MIT.txt`

## 官方校验（需要宿主）

出包前的官方静态校验由 `scripts/pack.mjs` 调用**宿主自带**的 `validate-app.mjs`。它是宿主作者工具
的一部分，依赖闭包里含 Hana 内部包（如 `@earendil-works/pi-coding-agent`），**不能**被拷进本仓库
独立运行；因此：本机装了 Hana（或设了 `HANA_APP_TOOLS_ROOT`）就过这道关，否则出包照常，但输出会
写明 `officialValidation: unavailable` —— 不假装通过。

## 未内联的许可文本

（无。上面每一条的可分发文本都在 `licenses/` 里。）
