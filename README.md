# GitHana（githana）

把 git / gh / gpg 三条 CLI 接进 HanaAgent 的 **App v2** 重制版：仓库状态与提交、GitHub PR 生命周期、隔离 GPG 签名身份。

- 形态：Hana App v2（`manifestVersion: 2`），`apply(ctx)` 单入口注册 7 个工具 + 3 组后端路由（status / settings / actions）
- 工具命名空间：`git_*`（本地 git）· `gh_*`（GitHub CLI）。**GPG 不在工具面**：密钥生成与公钥查看都只在设置页
- 服务端零 npm 依赖（设置页 UI 需一步构建）· `vendor/` 内嵌各平台运行时（gh 全平台 + Windows gnupg）随包分发 · 版本见 `manifest.json`（单一事实源）

> 与 dshana 同级：本仓库是**源码**，宿主实际加载的是安装位 `<HANA_HOME>/apps/<id>/`（见「安装与更新」）。

## 工具清单

| 工具 | 文件 | 权限档 | 语义 |
|------|------|--------|------|
| `git_exec` | tools/git-exec.js | external_side_effect | 任意 git 子命令透传；cwd 必填 + args 必填 + timeoutSec |
| `git_status` | tools/git-status.js | readOnly | 分支 / upstream / ahead-behind / staged / unstaged / untracked |
| `git_log` | tools/git-log.js | readOnly | 最近提交速览（默认 10，1~100） |
| `git_commit` | tools/git-commit.js | external_side_effect | 本地提交（message 走 stdin）；自动 Co-authored-by；自动 GPG 签名；收尾清 gpg-agent |
| `git_push` | tools/git-push.js | external_side_effect | force 映射 `--force-with-lease`（非裸 `--force`） |
| `gh_exec` | tools/gh-exec.js | external_side_effect | 任意 gh 命令透传（`GH_TOKEN` = OAuth 令牌，按次注入） |
| `gh_pr` | tools/gh-pr.js | external_side_effect | PR create / list / view / merge |

`gpg_keygen` / `gpg_pubkey` 已从工具面退役：GPG 的密钥生成与公钥查看都只在设置页（生成不可逆，
要用户点按钮确认）。实现仍在 `tools/gpg-keygen.js`（只由设置页动作调 `execute`）；公钥读取在
`lib/routes/pubkey.js`，原来的 `tools/gpg-pubkey.js` 已删。

## 与 v1 插件的关键差异

| 维度 | v1 插件（`plugins/github-hanako`，已装） | 本项目（App v2） |
|------|------------------------------------------|------------------|
| 工具注册 | 宿主扫描 `tools/*.js` 自动注册 | `apply(ctx)` 内逐个 `ctx.tools.register`（无前缀，名字全局唯一） |
| 设置 | `contributes.configuration`（明文进 preferences.json） | `contributes.settings.ui` 自定义页 + App 自持存储（DPAPI 加密，不进宿主设置表） |
| 凭据来源 | 手动粘贴 PAT | **GitHub App device flow 授权**（`ghu_` 令牌，PAT 通道已删除） |
| 后端路由 | `pluginRoutes`（`/api/plugins/<id>/`） | `ctx.routes.register`（`/api/apps/<id>/routes/`） |
| 会话流卡 | 动态 route 返回整页 HTML（公钥复制卡） | **不出流内卡**：公钥的查看/复制只有设置页一处（`ui/settings.html`） |
| 外部命令 | 插件进程直接 spawn | 清单申请 `app/process.spawn` → 子进程开 `--allow-child-process` |
| 文件边界 | 无限制 | Node Permission Model：安装目录只读、`app-data/githana` 可写 |
| 令牌存放 | `plugin-data/<id>/config.json` 明文 | 数据目录内 DPAPI 加密（`credential.json`，`kind: "oauth"`），不进宿主设置表 |

`tools/` 与 `tools/lib/` 的实现基本原样复用：`app.js` 把 App 运行上下文（`dataDir` / 安装目录）当作**第二个参数**喂给既有的 `execute(input, ctx)`，因此工具代码零改动。
唯一的适配点：`tools/lib/exec.js` 的 `checkCwd` 对 `ERR_ACCESS_DENIED` 显式放行（隔离进程许可根之外不能 `fs.stat`，把校验交给 git 子进程）。

## 清单能力

- `app/tools.expose-to-model` — 让模型能主动调用这 7 个工具
- `app/process.spawn` — 开 `--allow-child-process`，跑外部 git / gh / gpg（**需要用户在安装审阅里批准**）
- `app/ui.clipboard-write` — 设置页的「复制公钥」按钮

## 设置页

只贡献**一个**设置页（`contributes.settings.ui.route = /settings.html`），不开 page 卡：
同一页里既改 GitHub 认证、又看运行环境状态。页面用**宿主组件**搭（`@hana/app-sdk/components`：
`AppUiProvider` / `SettingsPage` / `SettingsSection` / `SettingRow` / `SaveButton` / `TextInput`），
而不是手抄样式。

- 清单里 `settings` 只有 `title` + `ui`，**没有 `schema`**：令牌不是宿主设置项，App 自己持有配置
  （APPS.md 的口径是 `schema` / `ui` 至少提供一个，只留 `ui` 合法）。
- 动态读写走 App 自己的已认证路由（`/routes/settings/state` 读、`/routes/settings/client-id` 写
  Client ID 覆盖值）。**页面没有任何令牌输入框**：OAuth 令牌只由服务端 device flow 拿到，
  页面只展示 `user_code`、验证地址与账号摘要。
- **surface 凭证**：宿迁把 App 页面挂在租约路径下（`/api/apps/<id>/ui/_surface/<token>/…`），
  页面对自己后端路由的请求不会自动带凭证，页面从自身 URL 路径里取出该 token，
  以 `X-Hana-App-Surface-Session` 头发出（查询串形态 `appSurfaceSession` 优先）。
- 主题：页面先加载组件自带样式（含 Hana 默认 token），再由 `hana-css` 注入宿主当前主题覆盖；
  宿主未注入时回退到公开的 `/api/apps/theme.css`，避免 antd 变量为空导致控件透明。

### 授权与令牌存哪里（不存宿主设置表）

凭据来源是 **GitHub App device flow 授权**（App：`githana-app` / Client ID
`Iv23li0dA1IaFVs6klAc`，可在设置页覆盖）。流程：

1. 设置页点「用 GitHub 登录」→ `POST /routes/actions/oauth/start`；
2. 服务端经 `gh api` 调 `https://github.com/login/device/code`（必须带
   `-H "Accept: application/json"`，否则回 form-encoded），把 `device_code` 留在服务端内存（key = 随机 `flowId`），
   只把 `user_code` / `verification_uri` / `interval` / `expires_in` 回给页面；
3. 页面按 `interval` 自轮询 `GET /routes/actions/oauth/poll?id=<flowId>`，服务端每次只查一次
   `access_token`；`slow_down` 会把间隔 +5s，`expired_token` / `access_denied` /
   `device_flow_disabled` 直接终止并透出可读原因。**不在服务端起长循环**（App 进程生命周期不稳定，
   长任务还会撞宿主回调超时）；进程重启 → flow 丢失，页面拿 404 后提示重新发起。

令牌**不进** `contributes.settings`，因此不会以明文出现在 `user/preferences.json`。
它由 App 自己的加密后端写进数据目录 `<dataDir>/credential.json`：

```jsonc
{ "schemaVersion": 2, "kind": "oauth", "backend": "win32-dpapi", "alg": "dpapi-current-user",
  "storage": "file", "cipher": "<DPAPI 密文，解出 { accessToken, refreshToken }>",
  "meta": { "login": "ProjectNyaser", "name": "Nyaser", "expiresAt": "…",
            "refreshExpiresAt": "…", "clientId": "Iv23li0dA1IaFVs6klAc" } }
```

- **令牌保活**：剩余有效期不足 5 分钟时，工具/路由调用前自动用 `refresh_token` 换新
  （`POST https://github.com/login/oauth/access_token`，`grant_type=refresh_token`，
  device flow 签发的令牌刷新**不需要 client_secret**）。刷新单飞（并发调用共享同一个 Promise），
  失败 → 记 `meta.needsReauth` 并清掉进程内令牌，设置页显示「需重新授权」。
  **不降级到其它凭据**（也没有其它凭据）：失败就是失败，后续 gh 调用如实报未登录。
- **后端可插拔**：`win32` = DPAPI（CurrentUser，密钥由登录身份派生，无需另管密钥）；
  `darwin` = Keychain、`linux` = libsecret 已留后端位与降级策略（`lib/secret.js` 的 `pickBackend`）。
- **绝不回落明文**：没有可用后端时保存直接报错，不写明文。
- **跨平台换机行为明确**：文件里的 `alg` 用来判定密文是不是本机后端写的；不匹配时设置页
  会显示「需重新授权」，而不是静默当未配置。
- **不进宿主设置表**：令牌与其它配置全由 App 自己持有，也没有明文回退。这是 v2 首个构建起的
  形态；宿主侧那格即使留有历史记录也只是空串，App 既不读也不写它。
- **clientId 与凭据解耦**：Client ID 非机密（代码里有内置默认值），用户覆盖值存
  `<dataDir>/oauth.json`，**清凭据时保留**——重新授权不必重填。

#### PAT 通道已删除

个人访问令牌通道**已下线删除**（不保留为备用）：设置页没有 PAT 输入框与保存按钮，
`POST /settings/token` 端点（含路由注册）已移除。旧 `schemaVersion: 1` 记录**读但不采用**——
不报错、不动文件、不注入 `GH_TOKEN`；设置页据此提示「PAT 通道已停用」并提供显式清除入口
（`POST /routes/settings/legacy-pat/clear`）。

删 PAT 不丢能力：`gh` 认证与身份推导由 OAuth 完全替代；git push 的 https 认证本就走系统
Git Credential Manager（`credential.helper = manager`），与 PAT 无关；而 GPG 公钥上传是 PAT
本来就没有的权限，只有 OAuth 的 `gpg_keys: write` 能做。

### 手动档（用户自助）

同一个设置页里另有一组手动入口：**实现只有一份**——端点直接调同一份模块本体
（`tools/gpg-keygen.js` 的 `execute`、`lib/routes/pubkey.js` 的公钥读取），不另写并行逻辑。

| 入口 | 端点 | 实现 |
|------|------|------|
| 保存 / 清除 Client ID 覆盖值 | `POST /routes/settings/client-id` | `lib/secret.js`（非机密，存 `oauth.json`） |
| 清除旧 PAT 记录 | `POST /routes/settings/legacy-pat/clear` | `lib/secret.js` 的 `removeSecretRecord` |
| 用 GitHub 登录（device flow） | `POST /routes/actions/oauth/start` | `lib/oauth.js` 的 `startDeviceFlow` |
| 查询授权结果（页面自轮询） | `GET /routes/actions/oauth/poll?id=<flowId>` | `lib/oauth.js` 的 `pollDeviceFlow` |
| 退出授权 | `POST /routes/actions/oauth/revoke` | `lib/oauth.js` 的 `revokeOAuth`（保留 clientId） |
| GitHub 身份 | `GET /routes/actions/identity` | `tools/lib/identity.js` 的纯函数（与密钥生成同源） |
| 检测 gh 认证 | `GET /routes/actions/gh-status` | `tools/lib/exec.js` 的 runCli（与 `gh_exec` 同款隔离 env） |
| 生成 / 轮换密钥（带二次确认） | `POST /routes/actions/keygen` | `tools/gpg-keygen.js` 的 `execute`（**不再是 Agent 工具**） |
| 查看 / 复制公钥 | `GET /routes/actions/pubkey` | `lib/routes/pubkey.js`（**不再是 Agent 工具**） |
| 上传公钥 / 从 GitHub 移除 | `POST /routes/actions/gpg/publish` · `/unpublish` | `lib/gpg-publish.js` |
| 发布状态 | `GET /routes/actions/gpg/status` | `lib/gpg-publish.js` 的 `publishedInfo` |

轮换密钥不可逆（GitHub 上已发布的旧公钥会被自动替换），所以按钮先弹确认再执行。

### GPG 公钥自动发布

借 GitHub App 的 `GPG keys: write` 账号权限，密钥生成后自动把公钥上传到 GitHub 账号，
用户不必再手动粘贴。

- **只删自己那把**：App 数据目录的 `published-gpg-keys.json` 记录 `{ keyId, fingerprint,
  uploadedAt, login, gpgKeyId }`。轮换时先 `GET /user/gpg_keys` **核对**记录里的 `keyId` 是否仍在
  （用户可能已在 GitHub 侧手动删过，以 GitHub 侧为准），再 `DELETE /user/gpg_keys/{keyId}`
  （404 视为已不存在，继续上传），然后 `POST /user/gpg_keys` 上传新公钥并写回记录。
- **绝不**枚举账号 GPG 密钥后按名字/指纹模糊匹配批量删除——账号上有用户个人正主密钥，
  误删是事故。上传时用的 `name`（`GitHana`）只作标识，**不参与删除匹配**。
- 上传失败**不阻断**本地密钥生成（本地签名链路已可用），结果写进 keygen 返回文本，
  并提供设置页手动重试按钮。
- 错误映射：`403` → 「App 未授予 GPG keys: write」+ 指向 App 权限设置；`422` → 透出 GitHub
  原文 + 「该邮箱需为账号已验证邮箱」；无 OAuth 凭据 → 「需先完成 GitHub App 授权」
  （不用 PAT 尝试——PAT 通常没有 `gpg_keys` 权限）。

### 安装仍需用户手动完成

需要账号 admin 权限，App 侧无法代劳：装到 **Nyasers** 组织覆盖组织下的仓库；若要往
`liliMozi` 名下的仓库发评论/提 PR，需 **liliMozi 本人** 把 App 装到该账号。App 的访问边界是
「安装所在账号」，仅授权不安装无效。

## 构建与交付面

源码树与交付树分开：**`dist/` = App 安装目录形态**（宿主读它根下的 `manifest.json` + entry），
由 `scripts/build-app.mjs` 以**白名单**组装；`pack.mjs` 只从 `dist/` 出包。

```bash
pnpm install          # react / react-dom / @rspack/core / @hana/app-sdk（仓库内 tgz 快照）
pnpm run build        # 组装 dist/（内部先打产物，再按白名单拷交付件）
pnpm run build:ui     # 只构建设置页产物：ui/src/settings.jsx → ui/dist/settings.bundle.*
pnpm run build:server # 只构建服务端单入口：app.js → build/server/app.mjs
```

**交付树是「单入口 + bin」形态**：服务端代码打成 `bin/app.mjs` 一个文件，
平台二进制在 `bin/<平台>/` 平铺，两者同层——`bin/` 的语义就是「装到机器上要跑的东西」。

```
dist/
  manifest.json  LICENSE  NOTICE
  bin/app.mjs             ← 服务端单入口（`.mjs` 自带 ESM 语义，不再随包 package.json）
  bin/<平台>/<exe>         ← 运行时二进制
  licenses/ assets/ skills/ ui/
```

**为什么打成单入口**：交付面是「装到机器上要跑的东西」，而不是「源码树的形状」。此前服务端
以源码形态随包（`index.js` + `lib/` + `tools/` 共 22 个文件），代价是交付面里混着源码、
还要为了解析规则随带一个 `package.json`（没有它 Node 把 `.js` 当 CJS，入口 import 直接报错）。

**为什么叫 app 而不是 index**：单入口的名字应该回答「这是什么」——它是 App 主体，不是一份
目录下的默认页。DSHana 的入口叫 `bin/index.mjs`，但那是它**两份东西**（主体 + 受管 runtime）
之间的一层静态转发壳，用来绕开「rspack 产出的入口带数字 id、每次构建都变」。本 App 没有第二份，
也没有那层壳，直接产出主体 `app.mjs`——照搬 `index` 会把别人的补丁当成形态。

> ⚠ bundle 有一个真陷阱：**`import.meta.url` 默认会被固化成构建机的绝对路径**
> （`file:///H:/…/tools/lib/bin.js`），在用户机器上不存在。而入口位置正是工具面定位安装根的
> 根据。`build-server.mjs` 因此显式关掉这个固化（`module.parser.javascript.importMeta: false`），
> 保留运行时语义。这个坑在源码树里跑不出来（那时路径恰好是真的），只有装机后才暴露——
> 所以「产物形态的改动必须真机验收」不是口号。

**为什么是白名单而不是排除表**：源码树里多出什么，黑名单就漏什么——本地规划文档（`SPECS.md` /
`specs/`）与设置页源码（`ui/src/`）就是这么进过包的。改成逐个点名后，要进包必须在名单里，
源码树里多出什么都不影响包。

**两个产物目录都不入库**（见 `.gitignore`）：

| 目录 | 内容 | 生成者 |
|------|------|--------|
| `dist/` | App 交付树（= 安装目录形态） | `scripts/build-app.mjs`（内部调 build-ui / build-server） |
| `ui/dist/` | 设置页产物（bundle.js / bundle.css） | `scripts/build-ui.mjs` |
| `build/server/` | 服务端单入口（app.mjs） | `scripts/build-server.mjs` |

源码与产物不混在同一层：`ui/src/` 是源，`ui/dist/` 是物，`dist/ui/` 是进包的那一份。
**出包时 `pack.mjs` 会无条件重新组装**，所以不必记得先构建，包里那份必然等于当前源码的产物。

## 脚本组织

`scripts/` 按域分目录，共用原语在 `shared/`：

```
scripts/
  shared/          root（向上找仓库根）/ run（直跑判定）/ args（命令行）/ err-text
  derive/          派生任务表：从某个源推导、写回目标文件；apply 与 --check 二态
  dev/             本地开发循环（install-local）
  probe/           查宿主能力面（host-surface）
  *.mjs            命令面入口：fetch-vendor / build-ui / build-app / selfcheck / pack / index
  hana-app-tools/  官方作者工具的原样拷贝（收录判定见其 README）
```

**为什么有 shared**：仓库根定位、直跑判定、参数读取这几件事，之前每支脚本各自写一遍且已漂
（有的数 `..` 层数、有的只认 `--x v` 不认 `--x=v`）。收敛成一处，新增脚本只 import。

**`derive` 的口径**：凡「能推导 + 被抄了多份 + 抄漏会坏」的事实都进那张表（当前两项：主清单版本
→ `package.json#version`、SDK tgz → `licenses/` 那份声明）。只写"这个文件该长什么样"，比较与
写回由框架统一做；`--check` 只读不写，CI 用它当门禁。人不定与不可推导的东西不进表：法律文本、
通知正文（它是包的一部分，由 pack 渲染）。

```bash
pnpm run derive         # 全部写回
pnpm run derive:check   # 只校验（CI 门禁）
pnpm run check:all      # 构建 + 自检 + 派生门禁 + vendor 门禁
```

**开发循环**（每次都走，所以做成命令而不是 README 里的手工步骤）：

```bash
pnpm run pack --target win32-x64 --out /tmp/out
pnpm run install:local -- --zip /tmp/out/githana-v<版本>-win32-x64.zip
pnpm run probe:host -- --app-bus                 # 宿主给的 bus 能力面（读 SDK 契约）
pnpm run probe:host -- --look models-changed     # 某字面在宿主 bundle 里出现在哪
```

`install:local` 走宿主自己的扩装面（与界面里「安装本地包」同一条）：卸载 → 提交 staging →
确认 → 等本 App 的 Status 端点应答。**就绪判据与本 App 的形态相配**：GitHana 没有受管运行时，
路由注册完就能应答 `/routes/status`；拿「等 runtime ready」那种判据在它这里永远等不到。

## App SDK 快照

`@hana/app-sdk` 不在 npm 上，它是宿主打包时产出的内部包。仓库因此在 `vendor/hana-app-sdk/`
存一份快照（4 个 tgz + `source-manifest.json`），**它入库**（`vendor/*` 的忽略规则里给了例外）
——构建必需，而 npm 上拿不到。

宿主升级后快照会漂，用脚本同步（源就是本机宿主，所以不进 CI）：

```bash
pnpm run sync:sdk            # 从 <HANA_HOME>/artifacts/server/<最新版本>/ 同步
pnpm run sync:sdk -- --check # 只校验漂移
```

同步后要跟着做两件事（脚本会打印）：按包名点名 `pnpm update @hana/app-sdk`（pnpm 不会因本地
tgz 换内容而重算锁文件），再 `pnpm run derive` 刷新 licenses/ 里那份 SDK 声明。

快照本身**不随包**：它是构建期依赖，由 rspack 内联进设置页产物；`build-app.mjs` 会把
`dist/vendor/hana-app-sdk/` 删掉。

## 第三方许可

**通知是包的一部分，仓库里不存它。** `THIRD_PARTY_NOTICES.md` 写的是“这个包里有什么”，而包内容
取决于 target（universal 带全平台 gh + win32 gnupg；darwin 包只带 gh），源码并不“拥有”某个特定包的
内容。所以它由 `pack.mjs` 在组装交付树时按实际内容渲染（见「许可面随包内容收窄」）。

两个真好处：**不会漂**（没有一份静态文件可以跟包不一致，以前靠 `--check` 比对，现在压根只有一份）；
**不会多**（darwin 包里不会出现 GnuPG 段落与 GPL-3.0 条文——那不是在多给，是在陈述不成立的事实）。

通知里的事实与许可正文**分开落点**：通知只陈述关系，法条逐份在 `licenses/`（随包）。这样法条
不经脚本转手（内联意味着让 `trimEnd` 决定法律文本长什么样）。

`licenses/` 里两类内容来源不同：

- **静态正文**（`Apache-2.0.txt` / `GPL-3.0.txt` / 两份 `MIT-*.txt`）—— 必须由仓库持有原文。
  上游不给：GnuPG 官方 Windows 安装器只带 `README.txt` 版权声明、**无 COPYING**（已按 2.5.24 实物验证）；
  SDK tarball 无 Apache 正文；react 不随包。
- **`hana-app-sdk-THIRD_PARTY_NOTICES.txt`** —— 从 SDK tgz 现取，由 `derive` 任务写入（与版本同源，手抄必漂）：

  ```bash
  pnpm run derive            # 全部写回（含从 tgz 现取的那份声明）
  pnpm run derive:check      # CI 门禁：拦住「换了 SDK 快照却忘了同步」
  ```

两份 MIT 各一份（`MIT-gh.txt` 版权归 GitHub, Inc.，`MIT-react.txt` 归 Meta Platforms）——
同一套 MIT 条款但版权人不一，合并会让归属不清。

## 内嵌运行时（平台通用）

二进制不写死平台，也不无谓重复：

| 二进制 | Windows | macOS / Linux | 来源 |
|--------|---------|---------------|------|
| git | **宿主已捆绑**（`<HANA_ROOT>/resources/git`），不随包分发 | 系统 PATH | 宿主 或 系统 || gh | 内嵌（官方单文件产物） | 内嵌（官方单文件产物） | `vendor/bin/<平台>-<架构>/gh` |
| gnupg | 内嵌（必需：签名链路要求认 GNUPGHOME 的原生模式） | 系统 gpg（本就读 GNUPGHOME） | vendor 或 系统 |

**每个组件目录只留运行时需要的文件**：落盘把上游 `remove/*` 的内容平铺到组件根，最终形态是
`vendor/bin/<平台>/<组件>/<exe>`。上游产物里那此 `share/`（man 手册）、`LICENSE`、卸载器、
`include/` 都裁掉，不靠随包拷贝转运许可文本（法条统一走 `licenses/`）。
**git 不随包**：宿主始终随带 `<HANA_ROOT>/resources/git`，其自带的 `LICENSE.txt` 就在宿主
安装目录里，不由本包再带一份。

**许可面随包内容收窄**：`pack.mjs` 出包时重渲染 `THIRD_PARTY_NOTICES.md`、并只留本包适用的
`licenses/` 正文——一个只装 gh 的 darwin 包不该出现 GPL 条文与 GnuPG 段落，那不是在多给，
是在陈述不成立的事实。与 vendor 按 `--target` 收窄同一条原则、同一个位置。

布局与解析：

- 布局是数据：`vendor/bin/<platform>-<arch>/<component>/<exe>`（`vendor/sources.json` 声明来源与 sha256）。
  运行时二进制统一收在 `vendor/bin/` 下，与元数据分层：`sources.json` 与 SDK 快照在 `vendor/` 根，
  所以 `.gitignore` 只需一行 `/vendor/bin/`（不必用 `!` 逐条翻案）。
- 解析是代码（`tools/lib/bin.js`）：**宿主内嵌 → 随包 vendor → 系统 PATH**。
- **探活不用 fs 用 spawn**：AppHost 开了 Node Permission Model，宿主 resources 在许可根之外，
  `fs.statSync/existsSync` 一律 `ERR_ACCESS_DENIED`；但 `app/process.spawn` 开的是子进程，
  **外部命令不继承该模型**。所以判存在性的方式是「跑一次 `--version`，能起来就算有」。
  只看 `HANA_DESKTOP_RESOURCES_PATH` 的写法在 v2 里必然失效（AppHost 不传它）。
- 按需重建：`node scripts/fetch-vendor.mjs [--platform <key>] [组件…]`。
  **不点名时只拉当前平台**（`process.platform`）：开发机只需要自己的那份，其他平台是 CI 的事。
  抓全平台只应该发生在两条流水线上：`release.yml` 遍历 sources.json 全部平台出 universal 包，
  `ci.yml` 按矩阵各拉自己的。本地手动拉全平台只会白白占两百多 MB。
- CI：`.github/workflows/ci.yml` 三平台矩阵各自 fetch vendored runtime + `pnpm run check`
  （构建设置页 UI + selfcheck）；出包与发版在 `.github/workflows/release.yml`（tag `v*` 触发），
  ubuntu 上抓全平台运行时并出 universal 包。官方 creator 不在本仓，所以用一个零依赖的
  `scripts/selfcheck.mjs` 兜住结构门槛
  （manifest 字段与 route 文件存在性、全部服务端 JS 语法、vendor 就绪性）。

## 跨平台与市场包（只有一个包，但它是全平台的）

**App 是 Web 应用，跨平台靠运行时解析，不逐平台出包**：

```
宿主内嵌 git（<HANA_ROOT>/resources/git，spawn 探活）
  → 本平台 bin/<platform>-<arch>/（随包带了）
    → 系统 PATH（git / gh / gpg）
```

- CI 的 release 流水线**只出一个 `universal` 包**——这个包把 `vendor/sources.json` 声明的
  **每个平台的官方运行时都打进去**（win32-x64 的 gh + gnupg，win32-arm64 / darwin-arm64 / darwin-x64
  与 linux-x64/arm64 的 gh），所以它在任意平台装上都是自包含的。**进市场的也只有它。**
- **macOS / Linux 的 gpg 走系统，不随包**：GnuPG 上游只发 Windows 安装器（`gnupg-w32-*`），
  POSIX 一律给源码、交由发行版/包管理器分发，没有可直接校验 sha256 的单文件产物。
  影响：**GNU/Linux 发行版普遍预装 gpg；macOS 从不预装**（需 `brew install gnupg` 或 GPG Suite）。
  设置页在 gpg 缺失时会直接给出对应平台的安装指引，而不是只说“缺失”。
- **win32-arm64 上只有 gh**：gh 有官方 arm64 产物，GnuPG 没有（官方 ftp 只有 w32 x86/x64）。
  那台机器上 gh 自包含，gpg 仍走系统。
- 为什么必须全平台随包，而不只是“不带 vendor 靠系统 PATH”：Windows 的签名链路要求
  vendor gnupg（认 `GNUPGHOME` 的原生模式，系统 scoop gpg 带 `gpgconf.ctl` 不认），
  而 `gpg.program` 由运行时解析到现在安装的 vendor gnupg，包不带 vendor 就没有可解析的目标。
- `node scripts/pack.mjs --target <platform>` 是点名才用的单平台构建（只留该平台 vendor），
  不进 CI、不进市场；universal 出包前会断言各平台必需组件都在，缺一个直接拒包。
- 包体大小不在包内解决：本仓库没有原生模块，因此不存在“非目标平台原生模块怎么裁剪”的问题；
  宿主侧的包限制偏紧时，抬限制比裁包合理。

## 出包与市场清单

```bash
pnpm run pack  --target universal         # → releases/<id>-v<ver>-universal.zip
                                          #   + .sha256 + .entry.json（索引构建器的输入）
pnpm run index                            # → index.v2.json（市场清单）
```

- `pack.mjs` 自带最小 ZIP 写入器，**不依赖官方包工具**；官方静态校验器可用时会作为额外关卡（不可用则标 `unverified`，不假装通过）。
- `.entry.json` 不能漏：索引构建器只吃这种文件。它的 `archive.url` 写 `{{BASE_URL}}` 占位，由 `build-index.mjs` 换成真实下载基址。
- **索引的限制**：`index.v2.json` 的条目只有 `archive.url` 一个地址，**没有平台维度**，构建器按 `kind:id` 分组——所以清单只放 universal（它本身已是全平台的）；平台包（如有）作为 release 资产按名取用。选非 universal 时脚本会警告。

## 安装与更新（走发行包）

```bash
pnpm run pack --target universal   # → releases/githana-v<版本>-universal.zip（+ .sha256 / .entry.json）
```

安装：把 zip 交给宿主的安装入口（与 `.skill`、插件目录同一条安装路由），或从市场装对应的 release。
宿主会弹确认卡逐条列出申请的能力（APPS.md：安装来源 → `stageInstall` 管线），批准后落到
`<HANA_HOME>/apps/<id>/`。

没有源码镜像那一步：`pack.mjs` 自己暂存净包（末级目录名 = `manifest.id`），直接从源码目录出包；
`node_modules` 是构建期的东西，不进包。手把目录塞进 `apps/` 只是兜底，会以「未登记」出现在
市场「已安装」→「待批准」，需要在那里批准。

## 目录

下面是**源码树**。服务端那几项（`app.js` / `lib/` / `tools/`）是源码，**不进包**：
`build-server` 把它们打成单入口 `bin/app.mjs`，交付树里只有一个服务端文件。

```
manifest.json            # manifestVersion 2 + capabilities + settings（title + ui，无 schema）；entry 指向产物 bin/app.mjs
app.js                   # apply(ctx)：注册 7 工具 + 3 组路由；disposer 收尾（源码，bundle 后进 bin/app.mjs）
tools/                   # 7 个工具 + gpg-keygen.js（仅设置页动作）+ lib/（exec / bin / context / identity / github）
lib/secret.js            # 凭据加密存储（OAuth only；DPAPI 等后端可插拔）+ clientId 覆盖值
lib/oauth.js             # GitHub App device flow 授权 + 令牌保活（刷新单飞）
lib/gpg-publish.js       # GPG 公钥发布/轮换（只删自己记录里的那一个 key_id）
lib/routes/status.js     # 环境状态端点（授权状态 / 二进制版本 / 公钥 / 发布状态）
lib/routes/settings.js   # 设置页数据端点（state / client-id / legacy-pat/clear）
lib/routes/actions.js    # 设置页「手动档」端点（oauth/* / keygen / gpg/* / gh-status / identity / pubkey）
lib/routes/pubkey.js     # 公钥数据读取（无端点）：状态端点 / 设置页动作共用
ui/settings.html         # 设置页（contributes.settings.ui.route）：认证 + 运行环境状态合一
assets/icon.svg          # App 图标
vendor/                  # 内嵌运行时：bin/<平台>/（二进制，不入 git）+ sources.json（声明）+ hana-app-sdk/（SDK 快照）
skills/gh/SKILL.md       # 随 App 分发的 gh CLI 使用参考
scripts/                 # 分域：build（组装/出包）/ derive（派生同步）/ dev（本地装机）/ probe（能力面）
  shared/                #   共用原语：root（仓库根）/ run（直跑判定）/ args（命令行）/ err-text
  derive/index.mjs       #   派生任务表（版本对齐、SDK 声明同步），apply 与 --check 二态
  dev/install-local.mjs  #   把本地包装进宿主（卸载→提交→确认→等路由应答）
  probe/host-surface.mjs #   查宿主能力面（SDK 契约 / 宿主 bundle 里的字面）
```

## 提交者身份推导

`gh api user` 返回 `{ id, login, name }`（该端点**不需要任何权限**）。名字走三级链：

   显式 name 参数 → user.name → login

`login = ProjectNyaser`、`name = Nyaser` 时，隔离 gitconfig 写 `user.name = Nyaser`；
邮箱固定为 `{id}+{login}@users.noreply.github.com`。同一组纯函数（`tools/lib/identity.js` 的
`deriveNameFromUser`）同时供 `tools/gpg-keygen.js` 与 `/routes/actions/identity` 使用，
两处不会跑偏。

## GPG 隔离机制（沿用 v1）

密钥只落 `app-data/githana/gnupg`，签名/验签不碰用户个人 GPG 环：

1. **keygen 侧**：所有 gpg 调用显式 `--homedir <dataDir>/gnupg`
2. **签名侧（git）**：隔离 gitconfig 写 `user.signingkey` / `commit.gpgsign=true`；`gpg.program` **不写文件**，由 `buildBinEnv` 每次 spawn 按当前安装现算并用 `GIT_CONFIG_*` 注入（文件里的绝对路径会被 vendor 布局绑死，换布局即失效）；同时每次 spawn 注入 `GIT_CONFIG_GLOBAL` / `GNUPGHOME` / `GIT_TERMINAL_PROMPT=0` / `GH_TOKEN`（= OAuth 令牌；无凭据时不注入）

两个必须绕开的坑（同 v1）：系统 scoop gpg 带 `gpgconf.ctl` 认不到 `GNUPGHOME`；MinGit 的 `gpg.program` 不支持带参。所以运行时注入的 `gpg.program` 只能指向认 env 的 vendor gnupg（绝对路径由 `resolveBin("gpg")` 现算，不落文件）。
