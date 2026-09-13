# GitHana（githana）

把 git / gh / gpg 三条 CLI 接进 HanaAgent 的 **App v2** 重制版：仓库状态与提交、GitHub PR 生命周期、隔离 GPG 签名身份。

- 形态：Hana App v2（`manifestVersion: 2`），`apply(ctx)` 单入口注册 7 个工具 + 3 组后端路由（status / settings / actions）
- 工具命名空间：`git_*`（本地 git）· `gh_*`（GitHub CLI）。**GPG 不在工具面**：密钥生成与公钥查看都只在设置页
- 服务端零 npm 依赖（设置页 UI 需一步构建）· `vendor/` 内嵌 git/gh/gnupg 随包分发 · 版本见 `manifest.json`（单一事实源）

> 与 dshana 同级：本仓库是**源码**，宿主实际加载的是安装位 `<HANA_HOME>/apps/<id>/`（见「安装与更新」）。

## 工具清单

| 工具 | 文件 | 权限档 | 语义 |
|------|------|--------|------|
| `git_exec` | tools/git-exec.js | external_side_effect | 任意 git 子命令透传；cwd 必填 + args 必填 + timeoutSec |
| `git_status` | tools/git-status.js | readOnly | 分支 / upstream / ahead-behind / staged / unstaged / untracked |
| `git_log` | tools/git-log.js | readOnly | 最近提交速览（默认 10，1~100） |
| `git_commit` | tools/git-commit.js | external_side_effect | 本地提交（message 走 stdin）；自动 Co-authored-by；自动 GPG 签名；收尾清 gpg-agent |
| `git_push` | tools/git-push.js | external_side_effect | force 映射 `--force-with-lease`（非裸 `--force`） |
| `gh_exec` | tools/gh-exec.js | external_side_effect | 任意 gh 命令透传（`GH_TOKEN` 由运行环境注入） |
| `gh_pr` | tools/gh-pr.js | external_side_effect | PR create / list / view / merge |

`gpg_keygen` / `gpg_pubkey` 已从工具面退役：GPG 的密钥生成与公钥查看都只在设置页（生成不可逆，
要用户点按钮确认）。实现仍在 `tools/gpg-keygen.js`（只由设置页动作调 `execute`）；公钥读取在
`lib/routes/pubkey.js`，原来的 `tools/gpg-pubkey.js` 已删。

## 与 v1 插件的关键差异

| 维度 | v1 插件（`plugins/github-hanako`，已装） | 本项目（App v2） |
|------|------------------------------------------|------------------|
| 工具注册 | 宿主扫描 `tools/*.js` 自动注册 | `apply(ctx)` 内逐个 `ctx.tools.register`（无前缀，名字全局唯一） |
| 设置 | `contributes.configuration`（明文进 preferences.json） | `contributes.settings.ui` 自定义页 + App 自持存储（DPAPI 加密，不进宿主设置表） |
| 后端路由 | `pluginRoutes`（`/api/plugins/<id>/`） | `ctx.routes.register`（`/api/apps/<id>/routes/`） |
| 会话流卡 | 动态 route 返回整页 HTML（公钥复制卡） | **不出流内卡**：公钥的查看/复制只有设置页一处（`ui/settings.html`） |
| 外部命令 | 插件进程直接 spawn | 清单申请 `app/process.spawn` → 子进程开 `--allow-child-process` |
| 文件边界 | 无限制 | Node Permission Model：安装目录只读、`app-data/githana` 可写 |
| 令牌存放 | `plugin-data/<id>/config.json` 明文 | 数据目录内 DPAPI 加密（`credential.json`），不进宿主设置表 |

`tools/` 与 `tools/lib/` 的实现基本原样复用：`index.js` 把 App 运行上下文（`dataDir` / 安装目录）当作**第二个参数**喂给既有的 `execute(input, ctx)`，因此工具代码零改动。
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
- 动态读写走 App 自己的已认证路由（`/routes/settings/state` 读、`/routes/settings/token` 写），
  页面不回显已存 token，只显示「已配置 / 未配置」，重新填写才回写。
- **surface 凭证**：宿迁把 App 页面挂在租约路径下（`/api/apps/<id>/ui/_surface/<token>/…`），
  页面对自己后端路由的请求不会自动带凭证，页面从自身 URL 路径里取出该 token，
  以 `X-Hana-App-Surface-Session` 头发出（查询串形态 `appSurfaceSession` 优先）。
- 主题：页面先加载组件自带样式（含 Hana 默认 token），再由 `hana-css` 注入宿主当前主题覆盖；
  宿主未注入时回退到公开的 `/api/apps/theme.css`，避免 antd 变量为空导致控件透明。

### 令牌存哪里（不存宿主设置表）

GitHub 令牌**不进** `contributes.settings`，因此不会以明文出现在 `user/preferences.json`。
它由 App 自己的加密后端写进数据目录 `<dataDir>/credential.json`：

```jsonc
{ "schemaVersion": 1, "backend": "win32-dpapi", "alg": "dpapi-current-user",
  "storage": "file", "cipher": "AQAAANCMnd8BFdERjHoAwE..." }
```

- **后端可插拔**：`win32` = DPAPI（CurrentUser，密钥由登录身份派生，无需另管密钥）；
  `darwin` = Keychain、`linux` = libsecret 已留后端位与降级策略（`lib/secret.js` 的 `pickBackend`）。
- **绝不回落明文**：没有可用后端时保存直接报错，不写明文。
- **跨平台换机行为明确**：文件里的 `alg` 用来判定密文是不是本机后端写的；不匹配时设置页
  会显示「需重新保存」，而不是静默当未配置。
- **不进宿主设置表**：令牌与其它配置全由 App 自己持有，也没有明文回退。这是 v2 首个构建起的
  形态；宿主侧那格即使留有历史记录也只是空串，App 既不读也不写它。

### 手动档（用户自助）

同一个设置页里另有一组手动入口：**实现只有一份**——端点直接调同一份模块本体
（`tools/gpg-keygen.js` 的 `execute`、`lib/routes/pubkey.js` 的公钥读取），不另写并行逻辑。

| 入口 | 端点 | 实现 |
|------|------|------|
| 保存 / 清除令牌 | `POST /routes/settings/token` | `lib/secret.js`（Agent 侧无对应） |
| GitHub 身份 | `GET /routes/actions/identity` | `tools/lib/identity.js` 的纯函数（与密钥生成同源） |
| 检测 gh 认证 | `GET /routes/actions/gh-status` | `tools/lib/exec.js` 的 runCli（与 `gh_exec` 同款隔离 env） |
| 生成 / 轮换密钥（带二次确认） | `POST /routes/actions/keygen` | `tools/gpg-keygen.js` 的 `execute`（**不再是 Agent 工具**） |
| 查看 / 复制公钥 | `GET /routes/actions/pubkey` | `lib/routes/pubkey.js`（**不再是 Agent 工具**） |

轮换密钥不可逆（GitHub 上已上传的旧公钥立即失效），所以按钮先弹确认再执行。

## 构建（设置页 UI）

React 设置页需要一步构建（宿主不会在安装时跑构建）：

```bash
pnpm install          # react / react-dom / @rspack/core / @hana/app-sdk（本地 tgz）
node scripts/build-ui.mjs   # ui/src/settings.jsx → ui/settings.bundle.js + ui/settings.bundle.css
```

产物 `ui/settings.bundle.*` 随包分发；`ui/src/` 只是源。改完 UI 源码要重新构建，bundle 变了才算改完。

## 内嵌运行时（平台通用）

二进制不写死平台，也不无谓重复：

| 二进制 | Windows | macOS / Linux | 来源 |
|--------|---------|---------------|------|
| git | **宿主已捆绑**（`<HANA_ROOT>/resources/git`），不随包分发 | 系统 PATH | 宿主 或 系统 |
| gh | 内嵌（官方单文件产物） | 内嵌（待补 sha256） | `vendor/<平台>-<架构>/gh` |
| gnupg | 内嵌（必需：签名链路要求认 GNUPGHOME 的原生模式） | 系统 gpg（本就读 GNUPGHOME） | vendor 或 系统 |

布局与解析：

- 布局是数据：`vendor/<platform>-<arch>/<component>/…`（`vendor/sources.json` 声明来源与 sha256）；
  旧的 `vendor/<component>/…` 仍兼容。
- 解析是代码（`tools/lib/bin.js`）：**宿主内嵌 → 随包 vendor → 系统 PATH**。
- **探活不用 fs 用 spawn**：AppHost 开了 Node Permission Model，宿主 resources 在许可根之外，
  `fs.statSync/existsSync` 一律 `ERR_ACCESS_DENIED`；但 `app/process.spawn` 开的是子进程，
  **外部命令不继承该模型**。所以判存在性的方式是「跑一次 `--version`，能起来就算有」。
  只看 `HANA_DESKTOP_RESOURCES_PATH` 的写法在 v2 里必然失效（AppHost 不传它）。
- 按需重建：`node scripts/fetch-vendor.mjs [--platform <key>] [组件…]`；
  `optional: true` 的条目（如 Windows 的 git）默认不抓，显式点名才抓。
- CI：`.github/workflows/ci.yml` 三平台矩阵各自 fetch vendored runtime + `pnpm run check`
  （构建设置页 UI + selfcheck）；出包与发版在 `.github/workflows/release.yml`（tag `v*` 触发），
  官方 creator 不在本仓，所以用一个零依赖的 `scripts/selfcheck.mjs` 兜住结构门槛
  （manifest 字段与 route 文件存在性、全部服务端 JS 语法、vendor 就绪性）。

## 跨平台与市场包（只有一个包）

**App 是 Web 应用，跨平台靠运行时解析，不逐平台出包**：

```
宿主内嵌 git（<HANA_ROOT>/resources/git，spawn 探活）
  → 本平台 vendor/<platform>-<arch>/（若随包带了）
    → 系统 PATH（gh / gpg）
```

- CI 的 release 流水线**只出一个 `universal` 包**（不随任何平台的 vendor），**进市场的也只有它**。
- `node scripts/pack.mjs --target <platform>` 是点名才用的自包含单平台构建（带该平台的 vendor），
  不进 CI、不进市场。
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
- **索引的限制**：`index.v2.json` 的条目只有 `archive.url` 一个地址，**没有平台维度**，构建器按 `kind:id` 分组——所以清单只放 universal；平台包（如有）作为 release 资产按名取用。选非 universal 时脚本会警告。

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

```
manifest.json            # manifestVersion 2 + capabilities + settings（title + ui，无 schema）
index.js                 # apply(ctx)：注册 7 工具 + 3 组路由；disposer 收尾
tools/                   # 7 个工具 + gpg-keygen.js（仅设置页动作）+ lib/（exec / bin / context / identity / github）
lib/routes/status.js     # 环境状态端点（token / 二进制版本 / 公钥）
lib/routes/settings.js   # 设置页数据端点（state / token）
lib/routes/actions.js    # 设置页「手动档」端点（keygen / gh-status / identity / pubkey）
lib/routes/pubkey.js     # 公钥数据读取（无端点）：状态端点 / 设置页动作共用
ui/settings.html         # 设置页（contributes.settings.ui.route）：认证 + 运行环境状态合一
assets/icon.svg          # App 图标
vendor/                  # 内嵌 git（MinGit）/ gh / gnupg（随包分发，不入 git 仓库）
skills/gh/SKILL.md       # 随 App 分发的 gh CLI 使用参考
scripts/                 # fetch-vendor（内嵌运行时）/ build-ui / pack / index / selfcheck
```

## GPG 隔离机制（沿用 v1）

密钥只落 `app-data/githana/gnupg`，签名/验签不碰用户个人 GPG 环：

1. **keygen 侧**：所有 gpg 调用显式 `--homedir <dataDir>/gnupg`
2. **签名侧（git）**：隔离 gitconfig 写 `user.signingkey` / `commit.gpgsign=true` / `gpg.program=<vendor gnupg>`；每次 spawn 注入 `GIT_CONFIG_GLOBAL` / `GNUPGHOME` / `GIT_TERMINAL_PROMPT=0` / `GH_TOKEN`

两个必须绕开的坑（同 v1）：系统 scoop gpg 带 `gpgconf.ctl` 认不到 `GNUPGHOME`；MinGit 的 `gpg.program` 不支持带参。所以 `gpg.program` 只能指向认 env 的 vendor gnupg。
