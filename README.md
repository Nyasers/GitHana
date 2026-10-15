# GitHana（githana）

把 git / gpg 两条 CLI 与 GitHub REST 接进 HanaAgent 的 **App v2** 重制版：仓库状态与提交、GitHub PR 生命周期、隔离 GPG 签名身份。

- 形态：Hana App v2（`manifestVersion: 2`），`apply(ctx)` 单入口注册 **6 个名词工具**（`githana_git` / `githana_repo` / `githana_pr` / `githana_issue` / `githana_label` / `githana_api`）+ 3 组后端路由（status / settings / actions）
- 工具面：按**操作对象**分 6 个名词工具，各自用 `action` 路由（`githana_api` 是单动词，不填 action），用法细节在随包手册 `skills/githana/SKILL.md`。**没有只读面 / 免审路径**：每个工具整体声明 `external_side_effect`。**GPG 不在工具面**：密钥生成与公钥查看都只在设置页
- 服务端零 npm 依赖（设置页 UI 需一步构建）· 签名用随包的纯 JS OpenPGP.js（无外部二进制）· 版本见 `manifest.json`（单一事实源）
- **GitHub 域不依赖任何外部二进制**：请求由随包的 `bin/rest.worker.mjs` 在子进程里直发（Node 内置 `fetch`），PR 创建稳定带 App 角标

> 与 dshana 同级：本仓库是**源码**，宿主实际加载的是安装位 `<HANA_HOME>/apps/<id>/`（见「安装与更新」）。

## 工具面

宿主侧是**六个名词工具**，按**操作对象**分：`githana_git`（本地 git）/ `githana_repo`（仓库）/
`githana_pr`（Pull Request）/ `githana_issue`（Issue）/ `githana_label`（标签）/
`githana_api`（逃生门）。工具名不加 `git_` / `gh_` 前缀——名词就是域，再带域前缀是重复标注。
用法细节、每个 action 的参数与示例都在随包手册
[skills/githana/SKILL.md](skills/githana/SKILL.md)（工具描述只留路由信息，不写成长墙）。

| 工具 | 权限档 | action |
|------|--------|--------|
| `githana_git` | `external_side_effect` | `exec` · `commit` · `push` |
| `githana_repo` | `external_side_effect` | `create` · `list` · `view` · `clone` · `fork` · `sync` · `gitignore` · `license` · `read-dir` · `read-file` |
| `githana_pr` | `external_side_effect` | `create` · `list` · `view` · `status` · `diff` · `checks` · `merge` · `review` · `comment` · `close` · `reopen` · `revert` · `edit` · `checkout` · `lock` · `unlock` · `update-branch` |
| `githana_issue` | `external_side_effect` | `create` · `list` · `view` · `status` · `edit` · `comment` · `close` · `reopen` · `delete` · `develop` · `transfer` · `lock` · `unlock` · `pin` · `unpin` |
| `githana_label` | `external_side_effect` | `clone` · `create` · `edit` · `delete` · `list` |
| `githana_api` | `external_side_effect` | （单动词，**不填 action**）`path` + `method` |

`githana_api` 是**单动词**工具：值域只有一个时 `action` 只是占位（填了等于没填），所以不声明它，
`required` 换成真正必填的 `path`。其余五个都是多动词，`action` 是分发键、必填。

### 为什么没有只读豁免（只有一个权限档）

宿主对 `sessionPermission` 的声明粒度是**按工具**（`ctx.tools.register` 时声明一次，
`app.js` 的 `plainPermission` 把它压成一组纯数据）：一个工具只能有一档。

收敛前的 `gh_pr` 是现成的代价样本：它把 list / view（读）与 create / merge（写）放在一个工具里，
整体只能声明 `external_side_effect`——于是**读也要过审**。曾经的 `githana` / `githana_read`
两个入口按「读 / 写」切，想给只读动作一条独立免审通道；PR #23 删掉了这条路径，
**现在不再有任何只读豁免**：

- 六个名词工具**整体都声明 `external_side_effect`**（含只读动词 `view` / `list` / `status` /
  `diff` / `checks` / `read-dir` / `read-file`）：它们与同工具的写动词共用一个权限档，
  无法单独免审。
- 按「对象」切而不是按「读写」切，是因为只读豁免在当前宿主机制下无法落在单个 action 上：
  想要它就得把读动词从名词工具里再拆出去，那会把同一对象的读写分到两个工具，
  调用方每次都要先判「这件事算不算读」——形态统一与读免审二者不可兼得，本期选了前者。
- `githana_api` 作为逃生门收全量 method（`GET` / `HEAD` / `POST` / `PATCH` / `PUT` / `DELETE`），
  同样整体按写面过审；越出 App 权限面的调用由 GitHub 直接拒（403）。

### 目录形态

```
tools/
  githana-git.js        # 名词工具：ACTION 表 + createSurface + sessionPermission
  githana-repo.js
  githana-pr.js
  githana-issue.js
  githana-label.js
  githana-api.js        # 单动词：createSingleSurface（不声明 action）
  actions/              # 一个 action 一个文件，按名词分目录（git / repo / pr / issue / label / api.js）
  lib/                  # 共享层：surface（路由 + zod 参数校验的唯一入口）/ params（共用字段的 zod 定义）
                        #   / verbs（动词总表，跨工具错投指名）/ pr（PR 共用 REST 与仓库解析）
                        #   / exec / rest / context / bin / identity / github / sign-shim
skills/githana/SKILL.md # 随包手册（frontmatter name + description，正文是按 action 的参数与示例）
```

路由层（`tools/lib/surface.js`）只认三类边界，六个工具共用同一份实现：**缺 action** / **未知 action**
报错并列出本工具可用值；**走错工具**（如把 `commit` 发给 `githana_repo`）报错并按
`tools/lib/verbs.js` 的动词总表指名正确的工具（同一动词有多个持有者时列出全部，让调用方按对象选）；
**保留位** action 报错说明未实现。

同一层还是**参数定义的唯一来源**：每个 action 导出自己的 zod raw shape（不含 `action`），
`surface.js` 组合成 `z.discriminatedUnion("action", …)`。那份定义长出两样产出——运行期校验
（失败返回全部 issues 的英文原文 + 一行中文引导），以及模型面的 `parameters`
（`z.toJSONSchema` 投影成平表；顶层 `oneOf` 会让宿主的参数摘要变空，所以模型面用平表）。

> 收敛是**重构不是改语义**：commit 的 CoA 与 OpenPGP 签名、push 的 `--force-with-lease`、
> `pr_create` 缺 base 取默认分支、api 的 body / headers 透传、令牌边界，全部逐条保真。

### 已从工具面退役的名字

`gpg_keygen` / `gpg_pubkey` 不在工具面：GPG 的密钥生成与公钥查看都只在设置页（生成不可逆，
要用户点按钮确认）。实现仍在 `tools/gpg-keygen.js`（只由设置页动作调 `execute`）；公钥读取在
`lib/routes/pubkey.js`，原来的 `tools/gpg-pubkey.js` 已删。

`gh_exec` 已由 `api` action 取代：前者透传 gh 的**子命令**（`gh release create` 这类高层动词），
后者透传 **REST 端点**。多数高层动词都能由端点组合出来，但组合工作从 CLI 移到了调用方——
这是能力面的真实变化，不是等价换皮。

### CI（保留位）

`ci_status` / `ci_watch` 本期**只留位置**（action 表 + 手册里写明未实现），不实现。理由：
CI 监听不是「多一个 api 调用」——GitHub 没有面向本地 App 的 webhook，只能轮询；轮询占着工具
调用会撞宿主回调的 30 秒上限，必须注册后台任务并在完成后唤醒会话。那需要新增
`app/tasks.manage` 能力声明，且返回契约要能容纳「返回句柄而非结果」这一档。留位是为了让返回
契约现在就留出这个口。当前可用 `api` 直接查 GitHub 的 check-runs / workflow-runs 端点。

## 与 v1 插件的关键差异

| 维度 | v1 插件（`plugins/github-hanako`，已装） | 本项目（App v2） |
|------|------------------------------------------|------------------|
| 工具注册 | 宿主扫描 `tools/*.js` 自动注册 | `apply(ctx)` 内逐个 `ctx.tools.register`（无前缀，名字全局唯一） |
| 设置 | `contributes.configuration`（明文进 preferences.json） | `contributes.settings.ui` 自定义页 + App 自持存储（DPAPI 加密，不进宿主设置表） |
| 凭据来源 | 手动粘贴 PAT | **GitHub App device flow 授权**（`ghu_` 令牌，PAT 通道已删除） |
| 后端路由 | `pluginRoutes`（`/api/plugins/<id>/`） | `ctx.routes.register`（`/api/apps/<id>/routes/`） |
| 会话流卡 | 动态 route 返回整页 HTML（公钥复制卡） | **不出流内卡**：公钥的查看/复制只有设置页一处（`ui/settings.html`） |
| 外部命令 | 插件进程直接 spawn | 清单申请 `app/process.spawn` → 子进程开 `--allow-child-process` |
| GitHub 域 | gh CLI（外部二进制） | 随包 REST worker（Node 内置 fetch，见「GitHub 通道」） |
| 文件边界 | 无限制 | Node Permission Model：安装目录只读、`app-data/githana` 可写 |
| 令牌存放 | `plugin-data/<id>/config.json` 明文 | 数据目录内 DPAPI 加密（`credential.json`，`kind: "oauth"`），不进宿主设置表 |

`tools/actions/` 与 `tools/lib/` 的实现基本原样复用：`app.js` 把 App 运行上下文（`dataDir` / 安装目录）当作**第二个参数**喂给各 action 的 `run(input, ctx, options)`，因此实现代码零改动。
唯一的适配点：`tools/lib/exec.js` 的 `checkCwd` 对 `ERR_ACCESS_DENIED` 显式放行（隔离进程许可根之外不能 `fs.stat`，把校验交给 git 子进程）。

## 清单能力

- `app/tools.expose-to-model` — 让模型能主动调用这六个名词工具（`githana_git` / `githana_repo` / `githana_pr` / `githana_issue` / `githana_label` / `githana_api`）
- `app/process.spawn` — 开 `--allow-child-process`，跑外部 git / gpg，以及随包的 REST worker（**需要用户在安装审阅里批准**）
- `app/ui.clipboard-write` — 设置页的「复制公钥」按钮
- `app/ui.open-external` — 设置页开 GitHub 验证页

**没有 `network` 声明**：那是宿主代发的通道（令牌会穿 IPC）。GitHub 请求由子进程直发，
令牌经 stdin 传给 worker，不出 App 边界（见「GitHub 通道」）。

## 设置页

只贡献**一个**设置页（`contributes.settings.ui.route = /settings.html`），不开 page 卡：
同一页里既登录 GitHub 账号、又管理签名密钥，运行环境明细收在「高级」里。页面用**宿主组件**搭
（`@hana/app-sdk/components`：`AppUiProvider` / `SettingsPage` / `SettingsSection` / `SettingRow` /
`Button` / `Collapse`），而不是手抄样式。

- 清单里 `settings` 只有 `title` + `ui`，**没有 `schema`**：令牌不是宿主设置项，App 自己持有配置
  （APPS.md 的口径是 `schema` / `ui` 至少提供一个，只留 `ui` 合法）。
- 页面只展示，不收集身份参数：Client ID 是本 App 注册的那一个（常量）；提交者名字与邮箱由已登录
  账号推导。**页面没有任何令牌输入框**：OAuth 令牌只由服务端 device flow 拿到，页面只展示
  `user_code`、验证地址与账号摘要。
- 动态读取走 App 自己的已认证路由（`/routes/settings/state`）。
- **surface 凭证**：宿迁把 App 页面挂在租约路径下（`/api/apps/<id>/ui/_surface/<token>/…`），
  页面对自己后端路由的请求不会自动带凭证，页面从自身 URL 路径里取出该 token，
  以 `X-Hana-App-Surface-Session` 头发出（查询串形态 `appSurfaceSession` 优先）。
- 主题：页面先加载组件自带样式（含 Hana 默认 token），再由 `hana-css` 注入宿主当前主题覆盖；
  宿主未注入时回退到公开的 `/api/apps/theme.css`，避免 antd 变量为空导致控件透明。

### 授权与令牌存哪里（不存宿主设置表）

凭据来源是 **GitHub App device flow 授权**（App：`githana-app` / Client ID
`Iv23li0dA1IaFVs6klAc`，固定在代码里）。流程：

1. 设置页点「用 GitHub 登录」→ `POST /routes/actions/oauth/start`；
2. 服务端经 REST worker 调 `https://github.com/login/device/code`（必须带
   `Accept: application/json`，否则回 form-encoded），把 `device_code` 留在服务端内存（key = 随机 `flowId`），
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
  **不降级到其它凭据**（也没有其它凭据）：失败就是失败，后续调用如实报未授权。
- **后端可插拔**：`win32` = DPAPI（CurrentUser，密钥由登录身份派生，无需另管密钥）；
  `darwin` = Keychain、`linux` = libsecret 已留后端位与降级策略（`lib/secret.js` 的 `pickBackend`）。
- **绝不回落明文**：没有可用后端时保存直接报错，不写明文。
- **跨平台换机行为明确**：文件里的 `alg` 用来判定密文是不是本机后端写的；不匹配时设置页
  会显示「需重新授权」，而不是静默当未配置。
- **不进宿主设置表**：令牌与其它配置全由 App 自己持有，也没有明文回退。这是 v2 首个构建起的
  形态；宿主侧那格即使留有历史记录也只是空串，App 既不读也不写它。
- **Client ID 是常量**：本 App 注册的那一个，权限与发布链路都绑在它上面，不开放覆盖；
  设置页只在「高级」里展示当前值。

#### PAT 通道已删除

个人访问令牌通道**已下线删除**（不保留为备用）：设置页没有 PAT 输入框与保存按钮，
`POST /settings/token` 端点（含路由注册）已移除。旧 `schemaVersion: 1` 记录**读但不采用**——
不报错、不动文件、不参与任何调用；设置页据此提示「旧版记录」并提供显式清除入口
（`POST /routes/settings/legacy-pat/clear`）。

删 PAT 不丢能力：`gh` 认证与身份推导由 OAuth 完全替代；git push 的 https 认证本就走系统
Git Credential Manager（`credential.helper = manager`），与 PAT 无关；而 GPG 公钥上传是 PAT
本来就没有的权限，只有 OAuth 的 `gpg_keys: write` 能做。

### 手动档（用户自助）

同一个设置页里另有一组手动入口：**实现只有一份**——端点直接调同一份模块本体
（`tools/gpg-keygen.js` 的 `execute`、`lib/routes/pubkey.js` 的公钥读取），不另写并行逻辑。

| 入口 | 端点 | 实现 |
|------|------|------|
| 清除旧 PAT 记录 | `POST /routes/settings/legacy-pat/clear` | `lib/secret.js` 的 `removeSecretRecord` |
| 登录（device flow） | `POST /routes/actions/oauth/start` | `lib/oauth.js` 的 `startDeviceFlow` |
| 查询登录结果（页面自轮询） | `GET /routes/actions/oauth/poll?id=<flowId>` | `lib/oauth.js` 的 `pollDeviceFlow` |
| 退出登录 | `POST /routes/actions/oauth/revoke` | `lib/oauth.js` 的 `revokeOAuth` |
| GitHub 账号信息 | `GET /routes/actions/identity` | `GET /user`（REST worker）+ `tools/lib/identity.js` 的纯函数 |
| 生成 / 轮换密钥（带二次确认） | `POST /routes/actions/keygen` | `tools/gpg-keygen.js` 的 `execute`（**不再是 Agent 工具**） |
| 查看 / 复制公钥 | `GET /routes/actions/pubkey` | `lib/routes/pubkey.js`（**不再是 Agent 工具**） |
| 补传公钥（本地有、账号没有时） | `POST /routes/actions/gpg/publish` | `lib/gpg-publish.js` |
| 从 GitHub 移除（本机密钥一并清除） | `POST /routes/actions/gpg/unpublish` | `lib/gpg-publish.js` |
| 发布状态 | `GET /routes/actions/gpg/status` | `lib/gpg-publish.js` 的 `publishedInfo` |

轮换密钥不可逆（账号上本 App 发布的那把会被替换），所以按钮先弹确认再执行。

### GPG 公钥自动发布

借 GitHub App 的 `GPG keys: write` 账号权限，密钥生成后自动把公钥上传到 GitHub 账号，
用户不必再手动粘贴。**两端始终一致**：本机有密钥就有对应公钥，反之亦然。

- **生成 = 生成 + 上传（一个动作）**：先快照密钥文件与签名接线，再生成并接线，最后上传；
  上传不成就把本地**整体退回生成前状态**。轮换时这个回滚同样成立：新钥传不上去就继续用旧钥，
  而不是把旧的先删掉。
- **移除 = 远端删除 + 本地同步清除**：远端删成功后同步清掉 `gpg.key.json`、`.pub.asc` 与隔离
  gitconfig 里的 `user.signingkey` / `commit.gpgsign`（`user.email` / `user.name` 保留）——
  本地不该留一把账号上已经没了的密钥，那会让之后每次提交都签名失败。
- **先加后删**：轮换时先 `POST /user/gpg_keys` 传新公钥，再删旧的。GitHub 允许账号上并存多把
  公钥，先加后删让账号全程都有可用密钥；先删会留一段空窗。
- **删除前核对归属**：先 `GET /user/gpg_keys`，要求 **keyId 相等且远端 key_id 等于记录指纹
  末 16 位**，两条都成立才删。只看 keyId 不够：记录可能来自另一个账号（用户换了登录），
  那里的同号 keyId 是别人的钥匙。指纹对不上一律不动它。
- **只删自己那把**：发布状态记在密钥记录 `gpg.key.json` 的 `published` 字段（`{ keyId, fingerprint,
  uploadedAt, login, gpgKeyId, name, stale[] }`）；`stale[]` 存本次上传成功但旧钥没删掉的残留，
  下次发布或移除时逐条核对指纹后再试。
- **绝不**枚举账号 GPG 密钥后按名字/指纹模糊匹配批量删除——账号上有用户个人正主密钥，
  误删是事故。上传时用的 `name`（`<账号 id>+<login>@GitHana`，如 `61904116+ProjectNyaser@GitHana`）
  只作展示与人工辨认，**不参与删除匹配**：名字在 GitHub 页面上随时可改，只看名字等于把
  「删哪把」交给一个可变字符串。
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
pnpm install          # openpgp / zod / react 19.2.4 / react-dom 19.2.4 / @rspack/core / @hana/app-sdk（仓库内 tgz 快照）
pnpm run build        # 组装 dist/（先清空，再依次构建产物 + 拷静态交付件）
pnpm run build:ui     # 只构建设置页产物：ui/src/settings.jsx → dist/ui/settings.bundle.*
pnpm run build:server # 只构建服务端单入口：app.js → dist/bin/app.mjs
```

**构建产物直接落 `dist/`**（build-ui / build-server / build-entries 都写这里），没有 `build/` 中转层：
交付面就是它们的产物落点，中间那一层只会让“产物到底在哪”多一个需要判断的间接层。
注意三个 `build:*` 子命令产出的是 dist/ 的**一部分**，单独跑会与其它产物共存；
要一个完整交付树请跑 `pnpm run build`（它先清空 dist/）。

**构建期依赖不进包**：`@rspack/core` 是打包器，只在构建主机上跑，字节不进 `dist/`，
所以既不用系统上的构建工具（也就没有"构建主机得装对版本"的外部要求），
也不进第三方通知（只列**代码进交付面**的组件，见 `scripts/derive/thirdparty.mjs` 的边界）。
`openpgp` 与 `zod` 与上述不同：它们以**运行期独立库文件**（`bin/openpgp.min.mjs` /
`bin/zod.min.mjs`）随包，所以列在通知里。

**交付树是「单入口 + bin」形态**：服务端代码打成 `bin/app.mjs` 一个文件，
入口与另两个 spawn 出去的独立入口（`rest.worker.mjs` / `gpg.shim.mjs`）同层
——`bin/` 的语义就是「装到机器上要跑的东西」。三个入口**都是压缩后的单入口 ESM**
（`build-server` 打 app，`build-entries` 打另两个），形态一致。两份库文件以独立文件形态
放在同层，入口在**运行期** import 它们（不内联）：一份顶多份，也让 LGPL §4(d)(1) 有落点。
`openpgp.min.mjs` 是 `bin/` 下唯一不做压缩的（上游原件、合规要求原样）；`zod.min.mjs` 则由
`build-entries` 从 `node_modules/zod` 打成单文件（发行物本体是上百个 ESM 模块的目录树）。

```
dist/
  manifest.json  NOTICE  THIRD_PARTY_NOTICES.md
  bin/app.mjs             ← 服务端单入口（`.mjs` 自带 ESM 语义，不再随包 package.json）
  bin/rest.worker.mjs     ← GitHub REST 执行体（零依赖，仅用 node 全局）
  bin/gpg.shim.mjs        ← 签名 shim（OpenPGP.js 为运行期相对 import）
  bin/openpgp.min.mjs     ← OpenPGP.js 库文件（上游 dist 原样，两个入口共享）
  bin/zod.min.mjs         ← zod 库文件（build-entries 打成单文件，app.mjs 运行期共享）
  assets/
  ui/                     ← settings.html + 设置页产物（平铺，不再套 dist/）
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

**产物目录是构建中间产物**（见 `.gitignore`）：

| 目录 | 内容 | 生成者 |
|------|------|--------|
| `dist/` | App 交付树（= 安装目录形态），**产物直接写它内部** | `scripts/build-app.mjs`（调 build-ui / build-server / build-entries） |

源码与产物不混在同一层：`ui/src/` 是源，`dist/ui/` 是进包的那一份。
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
→ `package.json#version`、实装版本 + 仓库持有的法条正文 → `THIRD_PARTY_NOTICES.md`）。只写"这个文件
该长什么样"，比较与写回由框架统一做；`--check` 只读不写，CI 用它当门禁。人不定的东西不进表
（如 `NOTICE` 的措辞——它只有仓库 URL 会漂，手改即可）。

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
tgz 换内容而重算锁文件），再 `pnpm run derive` 刷新 `THIRD_PARTY_NOTICES.md`（SDK 内联的那两个包
版本读自它的声明）。

快照本身**不随包**：它是构建期依赖，由 rspack 内联进设置页产物；`build-app.mjs` 会把
`dist/vendor/hana-app-sdk/` 删掉。

## 第三方许可

许可面只有三件（对齐 DSHana 的形态）：

| 文件 | 位置 | 内容 |
|------|------|------|
| `LICENSE` | **只在仓库**，不进包 | 本项目 MPL-2.0 全文 |
| `NOTICE` | 仓库 + 包根 | 本项目声明（受 MPL 约束 + 获取副本的地址 + 源码位置） |
| `THIRD_PARTY_NOTICES.md` | 仓库 + 包根 | 第三方组件清单 + **各自的许可正文全文** |

**包里不带 `LICENSE`，为什么合规**：MPL §3.1 的原文要求是「告知接收方源码形式受本许可约束，
**以及如何取得副本**」——不是「把副本随包带上」。这两件事由 `NOTICE` 的头两句履行（声明受 MPL
约束 + 给出 `https://mozilla.org/MPL/2.0/`）。仓库里那份 `LICENSE` 服务的是源码形式。

**一份 TPN 讲完第三方**：组件清单与各自的法条正文同处一文件（不再有 `licenses/` 目录）。
旧形态是「一份汇总 + 一目录散装」，同一件事两个落点，读的人得在两处对照。

**它入库，由 `derive` 生成**：与 DSHana 同形。旧的「不入库、由 pack 现渲染」是为「包内容随 target 变」
服务的；当前无内嵌二进制、各 target 交付内容相同，那个前提不成立。

```bash
pnpm run derive            # 全部写回（含重生成 THIRD_PARTY_NOTICES.md）
pnpm run derive:check      # CI 门禁：拦住「改了版本/组件却忘了重生成」
```

### 它只列**本包真的分发**的组件

判据是「代码进不进交付面」，不是「是不是依赖」。当前七项：构建期内联的 `@hana/app-sdk`
(Apache-2.0) / `react` / `react-dom` / `scheduler` / `react-is` / `use-sync-external-store`（均 MIT），
与随包独立库 `openpgp`（LGPL-3.0-or-later）。

这里有个容易踩的坑：**`@hana/app-sdk` 自带一份 91 KB 的 `THIRD_PARTY_NOTICES.txt`（82 个包）**，
它描述的是 SDK 的 `app-ui.js` 产物（antd 生态全家桶）。本 App 只内联它的 `components` / `ui` 入口，
antd 一个字节都没进包——整份搬运就是陈述不成立的事实。所以那份文件现在只作**构建期数据源**
（取 SDK 内联的那两个包的版本），不随包、不再当通知发。

### 法条正文的来源

原文存 `scripts/derive/licenses/`（**开发件，不随包**），拼接时只 `trimEnd()`，不改正文：

- `apache-2.0.txt` / `mit-meta.txt` / `mit-zod.txt` / `lgpl-3.0.txt` / `gpl-3.0.txt` —— 由仓库持有。
  上游不提供或不随包：SDK tarball 无 Apache 正文；react 不随包；OpenPGP.js 与 zod 的库文件不自带 LICENSE 附属件。
- LGPL 与 GPL 成对：LGPL §4(b) 要求两份正文都在场（LGPL 条文引用 GPL）。
- 可与实装对齐的已核对过：`mit-meta.txt` 与 react/react-dom/scheduler 的 LICENSE 逐字节相同
  （同是 Meta 那份 1088 字节），`lgpl-3.0.txt` 与 OpenPGP.js 的 LICENSE 逐字节相同；
  `mit-zod.txt` 是 zod 的 LICENSE（Copyright (c) 2025 Colin McDonnell），正文同是标准 MIT，
  差异只在版权行。

### LGPL 组件（OpenPGP.js）的合规落点

OpenPGP.js 是包里唯一的 LGPL 组件，以**一份独立、可替换的库文件**（`bin/openpgp.min.mjs`）随包：
两个入口在**运行期**用相对路径 `import` 它，它的代码不被合并进入口。这个形态对应 LGPL §4(d)(1)。

为什么不内联：内联进 bundle 后，库与其消费者分不开，只能走 §4(d)(0) 的**重组路径**
（需要交付可重新组合的 Minimal Corresponding Source 与 Corresponding Application Code）。
独立库文件则直接满足 §4(d)(1) 的「接口兼容即可替换」。这不是合规硬性选择（两条路都合法），
而是选一条对自己与下游都更轻的路：一份库文件顶掉两份内联副本，包体更小，替换也不用重构建。

`build-app.mjs` 在每次构建时以 sha256 断言投影进 `dist/bin/` 的那份与
`node_modules/openpgp/dist/node/openpgp.min.mjs` 逐字节相同——“原样未修改”因此是可验证的事实，
不是声明。具体条款映射（§4(a)～§4(e)）写在 `THIRD_PARTY_NOTICES.md` 的 LGPL 段。

## 运行时依赖（只剩 git，靠宿主）

本包不内嵌任何二进制。唯一的外部可执行文件是 git，而它由宿主提供：

| 可执行文件 | Windows | macOS / Linux | 来源 |
|--------|---------|---------------|------|
| git | **宿主已捆绑**（`<HANA_ROOT>/resources/git`），不随包分发 | 系统 PATH | 宿主 或 系统 |

签名与 GitHub 请求都不再需要外部二进制：前者由随包的纯 JS shim（`bin/gpg.shim.mjs`）完成，
后者由随包的 `bin/rest.worker.mjs` 直发。所以 `vendor/sources.json` 的组件表为空，
`vendor/bin/` 不存在也是合法状态（不再是“少抓了”）。

**git 与 GitHub 域都不随包**：宿主始终随带 `<HANA_ROOT>/resources/git`，其自带的 `LICENSE.txt` 就在
宿主安装目录里，不由本包再带一份；GitHub 请求由随包的 `bin/rest.worker.mjs` 直发，不需要任何外部二进制。

**每个组件目录只留运行时需要的文件**：落盘把上游 `remove/*` 的内容平铺到组件根，最终形态是
`vendor/bin/<平台>/<组件>/<exe>`。上游产物里那此 `share/`（man 手册）、`LICENSE`、卸载器、
`include/` 都裁掉，不靠随包拷贝转运许可文本（许可面统一走 `THIRD_PARTY_NOTICES.md`）。
**git 不随包**：宿主始终随带 `<HANA_ROOT>/resources/git`，其自带的 `LICENSE.txt` 就在宿主
安装目录里，不由本包再带一份。

**许可面不在打包期改动**：`THIRD_PARTY_NOTICES.md` 由 `derive` 生成并入库，随交付树进入暂存；
仓库里那份就是包里那份。旧形态（pack 现渲染 + 按组件裁剪 `licenses/`）是为「包内容随 target 变」
服务的，那个前提已不成立。

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
  当前 `sources.json` 组件表为空（无内嵌二进制），所以本脚本在正常仓态下是空操作；
  解压分支（targz / zip）保留供将来需要内嵌二进制时复用。
- CI：`.github/workflows/ci.yml` 三平台矩阵各自 `pnpm run check`
  （构建设置页 UI + selfcheck）；出包与发版在 `.github/workflows/release.yml`（tag `v*` 触发）。
  官方 creator 不在本仓，所以用一个零依赖的
  `scripts/selfcheck.mjs` 兜住结构门槛
  （manifest 字段与 route 文件存在性、全部服务端 JS 语法、入口与库就绪性）。

## 跨平台与市场包（只有一个包，但它是全平台的）

**App 是 Web 应用，跨平台靠运行时解析，不逐平台出包**：

```
宿主内嵌 git（<HANA_ROOT>/resources/git，spawn 探活）
  → 本平台 bin/<platform>-<arch>/（若声明了随包组件）
    → 系统 PATH（git）
```

签名与 GitHub 请求都不依赖外部可执行文件（纯 JS shim + REST worker），所以“可执行依赖三平台一致”
现在是结构上就成立的：没有平台分支、没有平台二进制、没有“macOS 上还差个 gpg”这类运气面。

（**仅指可执行依赖这一层**：凭据与私钥的加密后端目前只有 `win32` 的 DPAPI 落地，`darwin`/`linux`
是占位（`lib/secret.js` 的 `pickBackend`）——那两个平台上签名链路本身能跑，但还缺密钥与令牌的
本地保护后端，所以“三平台可用签名”尚不成立。见上面「授权与令牌存哪里」一段。）

- CI 的 release 流水线**只出一个 `universal` 包**：它把 `vendor/sources.json` 声明的每个平台的
  随包组件都打进去（**当前组件表为空**，所以它与单平台包目前没有区别），
  **进市场的也只有它**。保留 universal 形态是因为它是唯一能覆盖将来「某个平台需要内嵌二进制」的包形。
- `node scripts/pack.mjs --target <platform>` 是点名才用的单平台构建（只留该平台 vendor），
  不进 CI、不进市场；universal 出包前会断言各平台声明为随包的组件都在，缺一个直接拒包。
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
app.js                   # apply(ctx)：注册 6 个名词工具 + 3 组路由；disposer 收尾（源码，bundle 后进 bin/app.mjs）
tools/                   # 6 个名词工具（githana-{git,repo,pr,issue,label,api}.js）+ actions/（一个 action 一个文件，按名词分目录）+ gpg-keygen.js（仅设置页动作）+ lib/（surface / params / verbs / pr / exec / bin / rest / rest.worker / context / identity / github）
skills/githana/SKILL.md  # 随包手册：每个 action 的参数、示例与边界（工具描述只留路由信息）
lib/secret.js            # 凭据加密存储（OAuth only；DPAPI 等后端可插拔）；Client ID 常量
lib/oauth.js             # GitHub App device flow 授权 + 令牌保活（刷新单飞）
lib/gpg-publish.js       # GPG 公钥发布/轮换（先加后删；删除前核对指纹，只动自己那把）
lib/routes/status.js     # 环境状态端点（账号状态 / 二进制版本 / REST 通道 / 公钥 / 发布状态）
lib/routes/settings.js   # 设置页数据端点（state / legacy-pat/clear）
lib/routes/actions.js    # 设置页「手动档」端点（oauth/* / keygen / gpg/* / identity / pubkey）
lib/routes/pubkey.js     # 公钥数据读取（无端点）：状态端点 / 设置页动作共用
ui/settings.html         # 设置页（contributes.settings.ui.route）：账号 + 签名密钥 + 高级明细
assets/icon.svg          # App 图标
vendor/                  # 内嵌运行时：bin/<平台>/（二进制，不入 git）+ sources.json（声明）+ hana-app-sdk/（SDK 快照）
scripts/                 # 分域：build（组装/出包）/ derive（派生同步）/ dev（本地装机）/ probe（能力面）
  shared/                #   共用原语：root（仓库根）/ run（直跑判定）/ args（命令行）/ err-text
  derive/index.mjs       #   派生任务表（版本对齐、SDK 声明同步），apply 与 --check 二态
  dev/install-local.mjs  #   把本地包装进宿主（卸载→提交→确认→等路由应答）
  probe/host-surface.mjs #   查宿主能力面（SDK 契约 / 宿主 bundle 里的字面）
```

## GitHub 通道（自写 REST，无外部二进制）

GitHub 域的请求不再经 gh CLI：由随包的 `bin/rest.worker.mjs` 在子进程里用 Node 内置 `fetch` 直发。

- **为什么必须是子进程**：App 的 `apply()` 跑在 AppHost 子进程里，那个进程开了 Node Permission Model
  且没有 `--allow-net`（宿主按清单能力只给 `--allow-child-process`），进程内的 `fetch` 会被运行时拒在
  DNS 那一步（实测 `getaddrinfo ERR_ACCESS_DENIED api.github.com`）。`app/process.spawn` 授权下起的
  外部进程不继承该模型——gh CLI 以前就是这么联网的。
- **为什么 spawn 时要显式补 `--allow-net`**：Node 26 的 `--permission` 会经 **NODE_OPTIONS 传染给
  子进程**（子进程继承权限模型），而放行项不会跟着走。清 NODE_OPTIONS 无效（父进程里已生效）。
  所以 `tools/lib/rest.js` 在自己 spawn 的 argv 里显式开这扇门——它不是新增清单能力，是运行时层面
  的旗标。`--allow-net` 只在权限模型下合法（单独给会报 `ERR_MISSING_OPTION`），故按
  `process.permission` 判在不在。
- **白名单在 worker 内自查**：`--allow-net=<host>` 的收窄语法在 v26.8.1 **不生效**（实测
  `--allow-net=api.github.com` 下请求 example.com 仍成功）。运行时的门只能全开，所以 worker 把门
  收窄到 `api.github.com` 与 `github.com`，其余一律在发请求前拒。
- **重定向逐跳校验**：不用 `fetch(..., { redirect: "follow" })`——那等于把起始 URL 的白名单作废，
  任意一个 302 都能把请求引到别处（`/repos/{o}/{r}/tarball/x` 就 302 到 `codeload.github.com`）。
  改为 `redirect: "manual"` 手工跟，**每一跳**都过白名单（另含 `codeload.github.com`），跳数上限 5；
  离开 `api.github.com` 后不带走 `Authorization`（内容域不需要凭据）。
- **无正文响应是一等公民**：204/304/HEAD 没有 body，`res.body` 为 `null`。这类响应按
  `{ ok: true, json: null, text: "" }` 回报，不是错误——DELETE 成功（删评论 / 删分支）本来就是 204，
  当成错误会让调用方去重试一个已经成功的写操作。
- **只重试“没到服务端”的连接层错误**：DNS 失败 / 连接被拒 / 连接超时。已拿到响应后的错误
  （包括 `UND_ERR_SOCKET`、超时）不重试——那时代码可能已经生效，重试 POST 会双写。
- **一次调用一批请求**：worker 无状态，一次工具调用的全部 HTTP 请求打包成数组交给它、顺序执行、
  返回结果数组（`pr_view` 的「PR 详情 + reviews」正好一批）。不做长驻进程：它没有需要保留的状态，
  而长驻要背生命周期收尾。
- **令牌边界不变**：仍只在 App 进程内存与 worker 之间流转（经 stdin 传，不走子进程 env，更不进宿主 IPC）。
  OAuth 的两个端点在 `github.com` 且不校验 Authorization，给它固定占位值即可（真令牌不出这道门）。

### 与 gh CLI 的两处真实行为差异

替换 gh 不是无损换皮，这两点不藏：

1. **不做「自动推分支」**：`gh pr create` 在分支未推送时会先帮你推；REST 不会。本实现因此**显式报错
   并引导先 push**，不静默失败也不悄悄退回去。
2. **`reviewDecision` 是推导的**：那是 GraphQL 专有字段，REST 没有等价单值。由 `GET /pulls/{n}/reviews`
   的评审记录聚合出「审查状态」，输出里注明它是推导值。

### App 角标（本次改造的目标）

GitHub 的 App 角标读 `performed_via_github_app`。实测：**只有走 REST 建 PR 才写这个字段**
（`POST /repos/{o}/{r}/pulls`），走 GraphQL 的 `createPullRequest`（即 `gh pr create` 的实现路径）不写。
改用自写 REST 后角标成为稳定行为。

归因字段只在 **issue 表示**上（`GET /issues/{n}`）；`POST /pulls` 与 `GET /pulls/{n}` 的响应体**都不带**
它（实测）——UI 角标读的就是 issue 表示，所以 `pr_create` 完成后单独查一次。

## 提交者身份推导

`GET /user` 返回 `{ id, login, name }`（该端点**不需要任何权限**）。名字走三级链：

   显式 name 参数 → user.name → login

`login = ProjectNyaser`、`name = Nyaser` 时，隔离 gitconfig 写 `user.name = Nyaser`；
邮箱固定为 `{id}+{login}@users.noreply.github.com`。同一组纯函数（`tools/lib/identity.js` 的
`deriveNameFromUser`）同时供 `tools/gpg-keygen.js` 与 `/routes/actions/identity` 使用，
两处不会跑偏。

## 签名隔离机制

私钥只落 `app-data/githana/gpg.key.json`（DPAPI 加密），签名/验签不碰用户个人 GPG 环，也不依赖
任何 gpg 二进制：

1. **keygen 侧**：`tools/gpg-keygen.js` 用 OpenPGP.js 现生成 ed25519 密钥，armored 私钥经 DPAPI 后端
   加密落盘（与 `credential.json` 同一套后端抽象，见 `lib/secret.js` / `lib/dpapi.js`）。
2. **签名侧（git）**：隔离 gitconfig 写 `user.signingkey` / `commit.gpgsign=true`；`gpg.program` **不写文件**，
   由 `buildBinEnv` 每次 spawn 按当前安装现算并用 `GIT_CONFIG_*` 注入，同时注入
   `GIT_CONFIG_GLOBAL` / `GIT_TERMINAL_PROMPT=0` 与 `GITHANA_KEY_FILE`（后者告诉 shim 密钥在哪）。
   注入的目标是一个 `.cmd` / `.sh` 包装脚本（运行期写在 dataDir 的 `.runtime-tmp`，每次 spawn
   现写，不跟密钥、凭据那些长期文件混在一起），内含现算的宿主 node 路径与
   `bin/gpg.shim.mjs`（见 `tools/lib/sign-shim.js`），因为 git 的 `gpg.program` 不接受带参的命令行。

shim 是纯 JS 的独立进程：它从 `GITHANA_KEY_FILE` 读密钥、解密、用 OpenPGP.js 签/验，
按 git 的接口契约把状态写到 `--status-fd`。签名前它会核对 git 传来的签名者选择
（`-bsau` 的 selector，即 `user.signingkey`）是否指向本机这把密钥（指纹 / 长短 keyID / uid / 邮箱
任一写法均可），对不上就报 `FAILURE sign` 并退 2——不让“指定的身份”与“实际签名者”不一致。
它运行期 import 同目录的 `openpgp.min.mjs`（不内联，见「第三方许可」）。

运行时注入的 `gpg.program` 不落文件（文件里的绝对路径会被安装位绑死，换布局即失效）；
GitHub 域的令牌也不进子进程 env（经 stdin 传给 REST worker）。