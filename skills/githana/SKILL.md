---
name: githana
description: "GitHana: local git and GitHub operations. Read before any githana_git / githana_repo / githana_pr / githana_issue / githana_release / githana_run / githana_workflow / githana_cache / githana_label / githana_api call — actions, parameters, examples, the noun-tool split, and the permission gaps."
---

# githana：用法手册

> **本手册正文待重写（阶段 2 的 2b）。** 工具面已按 gh 的组分成十个名词工具：`githana_git`
> （exec / commit / push）、`githana_repo`（create / list / view / clone / fork / sync / gitignore /
> license / read-dir / read-file）、`githana_pr`（create / list / view / status / diff / checks /
> ready / merge / review / comment / close / reopen / revert / edit / checkout / lock / unlock /
> update-branch）、`githana_issue`（create / list / view / status / edit / comment / close /
> reopen / delete / develop / transfer / lock / unlock / pin / unpin）、`githana_release`（create /
> list / view / edit / delete / upload / download / delete-asset / verify / verify-asset）、
> `githana_run`（list / view / watch / rerun / cancel / delete / download）、
> `githana_workflow`（list / view / run / enable / disable）、`githana_cache`（list / delete）、
> `githana_label`（clone / create / edit / delete / list）、`githana_api`（单动词，**不带 action**，
> 必填 `path`）。
> 下面各节仍按旧的「写面 / 只读面」两个入口描述，动词名与参数表在改名前后一致
> （`pr_create` → `githana_pr(action="create")` 等），但**工具名与分面规则已经不对**，
> 以工具自身的 `parameters` 为准。三个已补齐的能力空洞（`pr ready` / `release edit` /
> `run watch`）见下面「已补齐的三个能力空洞」一节。

## 权限缺口（登记）

工具面是权限面的投影：**动词必须有支撑它的已授权权限，权限不在，动词就不在**（不在 zod 定义
里，因此也不在模型面的 `action` 候选里）。下面这些 gh 能力本 App **做不到**，逐项写明缺哪个
权限——缺口是登记出来的，不是假装它不存在。

`repo` 组（`githana_repo` 的 zod 定义里**没有**这些值）：

| gh 动词 | 缺哪个权限 | 现在怎么做 |
|---|---|---|
| `repo edit`（改简介 / 可见性 / 默认分支） | `administration: write` | 网页操作；`githana_api` 打 `PATCH /repos/{o}/{r}` 会被 GitHub 直接 403 |
| `repo delete` | `administration: write` | 同上（删仓库在这个 App 里做不到） |
| `repo rename` | `administration: write` | 同上 |
| `repo archive` / `repo unarchive` | `administration: write` | 同上 |
| `repo set-default` | `administration: write` | 同上 |
| `repo autolink` | `administration: write` | 同上 |
| `repo deploy-key` | `administration: write` | 同上 |
| `repo create --org <org>` | `administration: write` + organization 权限 | 只能建在当前登录账号下（`POST /user/repos`）；组织下建仓库要补 `administration` 并重走一次授权 |
| `repo fork --org <org>` | organization 权限（0 项，从未申请） | 只能 fork 到当前登录账号下 |
| `repo list` 的组织形态（`/orgs/{org}/repos`） | organization 权限 | 用 `owner="<组织名>"` 走 `/users/{owner}/repos`（只含公开仓库） |

其它组的缺口（这些组**没有对应工具**，全部走 `githana_api`，GitHub 直接 403）：

| gh 组 | 缺哪个权限 |
|---|---|
| `secret` · `variable` | `secrets: write` · `actions_variables: write` |
| `ssh-key` | `keys: write`（account） |
| `gist` | `gists: write`（account） |
| `codespace` | `codespaces: write` |
| `discussion` · `project` | `discussions` · `repository_projects`（都是 GraphQL-only） |
| `attestation` | `attestations: write` |
| `webhook` | `repository_hooks: write` |
| `org` | organization 权限（**未申请**，不是被拒） |

已授权的 8 项 repository（`actions` / `checks` / `contents` / `issues` / `metadata` /
`pull_requests` / `repository_creation` / `workflows`）+ 1 项 account（`gpg_keys`）见
`specs/current/gh-cli-parity/spec.md` 的 D7。**改 App 权限后老用户要重走一次 device flow**
才拿到新范围——不重新授权时新动词会 403。

GitHana 把本地 git 与 GitHub 接进模型工具面，收成**两个入口**：

| 工具 | 权限 | 动作 |
|---|---|---|
| `githana_read` | 只读（**免审**） | `status` · `log` · `pr_list` · `pr_view` · `api`（仅 GET / HEAD） |
| `githana` | `external_side_effect`（过审） | `exec` · `commit` · `push` · `pr_create` · `pr_merge` · `api`（全量） |

两个入口的 `action` 都是必填。**写动作在 `githana`，读动作在 `githana_read`**：
把写动作发给只读面（或把只读动作发给写面）会被当场拒绝，并在报错里指回正确的工具。

调用形态一律是「工具名 + action + 该 action 的参数」：

```jsonc
{ "action": "status", "cwd": "E:\\workspace\\my-repo" }              // githana_read
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "message": "…" }  // githana
```

## 只读面与写面的分界

分开是因为宿主对 `sessionPermission` 的声明粒度是**按工具**的：一个工具只能有一档。收敛前
`gh_pr` 把 list / view（读）与 create / merge（写）放在同一个工具里，整体只能声明
`external_side_effect`——于是**读也要过审**。两个入口是当前机制下唯一能同时拿到「形态统一」
和「读免审」的形状。

- **`api` 在两面都有，但白名单不同**：HTTP method 是可靠的读写判据，GET / HEAD 按语义是安全
  动词，所以只读面收下它们（issue 列表、release 列表、仓库元数据这类长尾只读查询不必每次过审）。
  只读面收到 `POST` / `PATCH` / `PUT` / `DELETE` 会拒绝并指向 `githana(action="api")`。
- **`exec` 不在只读面**：git 子命令白名单挡不住 flag——`diff --output=<file>` 写文件、
  `config` 改配置、`branch -D` 删分支。透传层是风险面，过审合理。需要任意只读 git 命令时
  走 `githana(action="exec")`，或用 `status` / `log`。
- **`status` / `log` 留在只读面**：它们不是治理层，是翻译层——把 git 输出解析成结构化字段，
  给模型省 token。

## cwd 约定

`cwd` 一律是**仓库的绝对路径**（如 `E:\\workspace\\my-repo`），不做工作目录隐式推断。

| 动作 | cwd |
|---|---|
| `status` / `log` / `exec` / `commit` / `push` | **必填** |
| `pr_create` / `pr_view` | 可选，但要拿缺省值（`pr_create` 的 head 与缺省 title、`pr_view` 的「当前分支关联 PR」）时就必填 |
| `pr_list` / `pr_merge` | 可选（仅在没传 `repo` 时用来从 git remote 推断仓库） |
| `api` | **不接受**：它只按 `path` 打端点，`repo` 也只用于替换 `path` 里的占位符，不做 cwd 推断 |

GitHub 动作的仓库上下文：**`repo`（owner/repo）显式优先**；没传就从 `cwd` 的 git remote 推断；
两者都没有 → 报错并给引导，不猜（`api` 例外：它不做推断，见上表）。

## githana_read 的参数与示例

### status — 工作区 / 分支速览

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 是 | 仓库绝对路径 |

输出当前分支、upstream、ahead/behind、已暂存 / 未暂存 / 未合并 / 未跟踪四组明细
（porcelain v1 解析，状态字母可读化），工作区干净时明确提示。

```jsonc
{ "action": "status", "cwd": "E:\\workspace\\my-repo" }
```

### log — 最近提交速览

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 是 | 仓库绝对路径 |
| `n` | 否 | 返回条数，默认 10，范围 1~100（越界自动收敛） |

输出短 hash、作者名、相对时间与首行。空仓库返回「暂无提交」，不报错。
需要 diff / 文件清单 / 完整 message 等细节请走 `githana(action="exec")`（`git show` / `git log --stat`）。

```jsonc
{ "action": "log", "cwd": "E:\\workspace\\my-repo", "n": 20 }
```

### pr_list — PR 列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `repo` | 否 | owner/repo；缺省从 `cwd` 推断 |
| `cwd` | 否 | 仓库绝对路径（推断仓库兜底） |
| `state` | 否 | `open`（默认）/ `closed` / `all` |
| `limit` | 否 | 返回条数，默认 10，上限 50 |
| `timeoutSec` | 否 | 默认 60，上限 600 |

```jsonc
{ "action": "pr_list", "repo": "liliMozi/openhanako", "state": "open", "limit": 20 }
```

### pr_view — PR 详情（含 reviews）

| 参数 | 必填 | 说明 |
|---|---|---|
| `prNumber` | 否 | 正整数；缺省 = 当前分支关联 PR（此时需要 `cwd`） |
| `repo` / `cwd` / `timeoutSec` | 否 | 同上 |

输出状态 / 分支 / 审查状态 / 合并状态 / URL / 正文（截断 2000 字符）。

> **审查状态是推导值**：`reviewDecision` 是 GraphQL 专有字段，REST 没有等价单值。这里由
> `GET /pulls/{n}/reviews` 的评审记录聚合而成，输出里会注明。

```jsonc
{ "action": "pr_view", "repo": "liliMozi/openhanako", "prNumber": 21 }
```

### api — 任意 REST 端点（仅 GET / HEAD）

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | api.github.com 之后的路径，带前导斜杠 |
| `method` | 否 | 只读面只有 `GET`（默认）/ `HEAD` |
| `repo` | 否 | 传了就替换 `path` 里的 `{owner}` / `{repo}` 占位符 |
| `paginate` | 否 | 跟随 Link 分页合并数组（上限 10 页） |
| `timeoutSec` | 否 | 默认 60，上限 600 |

查询串直接拼在 `path` 里。长尾只读查询走这里，不必为它加 action。

```jsonc
{ "action": "api", "path": "/user" }
{ "action": "api", "path": "/repos/{owner}/{repo}/releases", "repo": "liliMozi/openhanako", "paginate": true }
{ "action": "api", "path": "/repos/o/r/issues?state=all&per_page=50" }
```

## githana 的参数与示例

### exec — 任意 git 子命令透传

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 是 | 仓库绝对路径 |
| `args` | 是 | git 完整参数数组（**无 shell 拼接**），首元素为子命令 |
| `timeoutSec` | 否 | 默认 120，上限 600 |

返回命令、exit code 与 stdout / stderr 原文（分通道截断 200KB，CRLF 归一 LF）。
非零退出保留 git 原始输出并附中文引导。

```jsonc
{ "action": "exec", "cwd": "E:\\workspace\\my-repo", "args": ["status", "--porcelain"] }
{ "action": "exec", "cwd": "E:\\workspace\\my-repo", "args": ["add", "src/a.js"] }
{ "action": "exec", "cwd": "E:\\workspace\\my-repo", "args": ["log", "--oneline", "-5"] }
{ "action": "exec", "cwd": "E:\\workspace\\my-repo", "args": ["diff", "--cached"] }
```

需要交互 TTY 的流程（交互式 rebase 等）本 action 跑不了——它是非交互参数化执行。
**提交署名治理请走 `commit`**（`exec` 是纯净透传，不追加 Co-authored-by）。

### commit — 提交（自动 CoA + 签名）

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 是 | 仓库绝对路径 |
| `message` | 是 | 提交说明；经 stdin 传（`git commit -F -`），多行 / 中文无损。amend 且需沿用原说明时可传空串 |
| `paths` | 否 | 相对 cwd 的路径列表；缺省提交全部已暂存内容。文件未暂存会先 `git add` 再按 pathspec 提交，**其他已暂存内容不会被带入** |
| `amend` | 否 | 改写最近一次提交；`message` 为空时沿用 HEAD 完整说明 |
| `allowEmpty` | 否 | 允许空提交；缺省 false |

- **自动追加署名**：message 尾部补空行后写死一行
  `Co-authored-by: HanaAgent <…@users.noreply.github.com>`
  （`@HanaAgent` 是协作署名实体，不承担登录/认证）。message 已含 `Co-authored-by:` 行则跳过
  （去重），amend 沿用原说明时同样去重。
- **自动 OpenPGP 签名**：由隔离 gitconfig 的 `user.signingkey` + `commit.gpgsign=true` 驱动，
  签名 shim 随包（纯 JS，无外部 gpg 二进制）。密钥在设置页生成 / 轮换。
- 无 `paths` 且无已暂存内容 → 返回引导提示，**不空提交**；确需空提交才传 `allowEmpty=true`。
- `amend` 与 `paths` 不能同用（git 限制）。
- 返回短 hash + 首行 + 文件数 + 署名动作说明。

```jsonc
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "message": "fix: 修正超时归一" }
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "message": "feat: 新入口\\n\\n正文…", "paths": ["tools/githana.js"] }
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "amend": true, "message": "" }
```

### push — 推送

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 是 | 仓库绝对路径 |
| `branch` | 否 | 缺省 = 当前分支 |
| `remote` | 否 | 默认 `origin` |
| `setUpstream` | 否 | 带 `-u` 建立上游跟踪 |
| `force` | 否 | **映射 `--force-with-lease`**（安全 force，拒绝覆盖他人新提交） |
| `dryRun` | 否 | 只做 `--dry-run` 演练，不真推 |

裸 `--force` 不提供：需要它请走 `githana(action="exec")` 显式传，让意图写在参数里。
远端 https 认证走系统 Git Credential Manager，本 App 不注入 git 凭据。

```jsonc
{ "action": "push", "cwd": "E:\\workspace\\my-repo" }
{ "action": "push", "cwd": "E:\\workspace\\my-repo", "branch": "fix/x", "setUpstream": true }
{ "action": "push", "cwd": "E:\\workspace\\my-repo", "force": true, "dryRun": true }
```

### pr_create — 创建 PR

| 参数 | 必填 | 说明 |
|---|---|---|
| `repo` | 否 | owner/repo；缺省从 `cwd` 推断 |
| `cwd` | 否 | **实际必填**：head 取它的当前分支；`title` 缺省也读它 |
| `base` | 否 | 目标分支；**缺省取仓库默认分支** |
| `title` | 否 | 缺省取 cwd 内 HEAD commit 首行 |
| `body` | 否 | PR 正文（Markdown / 中文） |
| `draft` | 否 | 以草稿创建 |
| `timeoutSec` | 否 | 默认 60，上限 600 |

- **不自动推分支**：`gh pr create` 在分支未推送时会先帮你推，REST 不会。本 action 因此
  **显式报错并引导先 `githana(action="push")`**，不静默失败。
- 走 REST `POST /repos/{o}/{r}/pulls`——这是 **App 角标的来源**（GraphQL 的 createPullRequest
  不写 `performed_via_github_app`）。创建后单独查一次 issue 表示并**如实回报**归因结果
  （查不到就说未确认，不假装）。

```jsonc
{ "action": "pr_create", "cwd": "E:\\workspace\\my-repo", "base": "main", "title": "feat: 工具面收敛", "body": "…" }
```

### pr_merge — 合并 PR（不可撤销）

| 参数 | 必填 | 说明 |
|---|---|---|
| `prNumber` | 是 | 正整数 |
| `repo` / `cwd` / `timeoutSec` | 否 | 同上 |
| `method` | 否 | `merge`（默认）/ `squash` / `rebase` |
| `deleteBranch` | 否 | 合并后删源分支 |

- 合并**不可撤销**，执行前请确认 `repo` 与 `prNumber`。本 action 无交互提示。
- `deleteBranch` 前先取源分支的**来源仓库**：源分支来自 fork 时**跳过删除**（不跨仓库删分支，
  否则会在 base 仓库的同名无关分支上动手）。删的是 `DELETE /repos/{o}/{r}/git/refs/heads/{branch}`。
- 成功后取一次终态确认（合并是异步落地）。

```jsonc
{ "action": "pr_merge", "repo": "liliMozi/openhanako", "prNumber": 21, "method": "squash", "deleteBranch": true }
```

### api — 任意 REST 端点（全量方法）

参数同只读面，`method` 额外接受 `POST` / `PATCH` / `PUT` / `DELETE`。
`body` 是 JSON 对象，只用于 `POST` / `PATCH` / `PUT`（`GET` / `HEAD` / `DELETE` 不接受 body）。
PR 生命周期请用 `pr_*` 动作；issue / release / 仓库管理等长尾操作经此透传。

```jsonc
{ "action": "api", "path": "/repos/{owner}/{repo}/issues", "repo": "liliMozi/openhanako",
  "method": "POST", "body": { "title": "问题标题", "body": "正文" } }
```

## 错误引导

| 现象 | 含义与做法 |
|---|---|
| `缺少 action` / `未知 action` | 报错会**列出本面可用值**；不猜、不回落默认分支 |
| `参数校验失败（共 N 处）` | 参数形状不对（多余键、类型不符、超出 enum）。下面是**全部** issues，每行 `字段路径 [code] 英文原文`——`path` 指到具体字段，`code` 是 zod 的错误码；按路径逐条改正后重试 |
| `它属于另一个面` | 该 action 在另一个入口；报错里直接给出改用的工具与 action |
| `未实现` | 该 action 是保留位（当前为空；见文末「受限动词」一节）。这条通路留着给下一次「认得出但参数契约还没定」的动词 |
| `无法建立后台任务：宿主没有授予 app/tasks.manage 能力` | `githana_run(action="watch")` 需要宿主后台任务面。用 `githana_run(action="view")` 看此刻状态；要恢复本动词需在宿主里批准该能力后重装 / 重启本 App |
| `尚未完成 GitHub App 授权` | 到 GitHana 设置页点「用 GitHub 登录」后重试 |
| `需要重新授权` | 上次令牌刷新失败（refresh_token 失效或授权被撤销），到设置页重新授权 |
| `当前目录不是 git 仓库` | `cwd` 指错了，或目录尚未 `git init` |
| `git 未配置提交者身份` | 先 `git config user.name / user.email`（可用 `exec`） |
| `远端拒绝了快进推送` | 先拉取合并，或用 `push` 的 `force=true`（`--force-with-lease`）安全覆盖 |
| `源分支 … 在远端不存在或没有新提交` | 分支还没推：先 `githana(action="push")` 再建 PR |
| `path 必须以 / 开头` | `api` 的 `path` 是 api.github.com 之后的路径（带前导斜杠） |
| `method 只能是 GET / HEAD` | 只读面的 `api` 只收安全动词；写操作改用 `githana(action="api")` |

> **每个 action 只接受自己声明的字段。** 参数表由 zod 定义生成、运行期也用同一份校验，
> 所以多传一个不属于该 action 的键会被当场拒（并列出 issues），不会被静默忽略。

## 已补齐的三个能力空洞（阶段 2a）

这三个动词此前是「认得出但没实现」的保留位，现在都是真实动词、都在各自工具的 `action`
候选里。它们的共同点是**形态与同工具的其它动词不同**，所以逐个写清怎么调、边界在哪。

### `githana_pr(action="ready")` — 草稿 PR 转 ready（可反向）

| 参数 | 必填 | 说明 |
|---|---|---|
| `repo` | 否 | owner/repo；缺省从 `cwd` 推断 |
| `cwd` | 否 | 仓库绝对路径（`prNumber` 缺省时用它取当前分支） |
| `prNumber` | 否 | 正整数；缺省 = 当前分支关联的打开 PR（此时需要 `cwd`） |
| `undo` | 否 | `true` = 反向：把 PR **转回草稿**（`convertPullRequestToDraft`）；缺省 / `false` = 转 ready |
| `timeoutSec` | 否 | 默认 60，上限 600 |

```jsonc
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42 }                    // 草稿 → 可审查
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42, "undo": true }       // 可审查 → 草稿
```

- **不暴露通道差异**：内部先 REST `GET /pulls/{n}` 取 `node_id`，再发 GraphQL 变更
  （`markPullRequestReadyForReview` / `convertPullRequestToDraft`）。原因是一条实测事实：
  **un-draft 只有 GraphQL 能做**——REST `PATCH /pulls/{n}` 带 `{draft:false}` 返回 200 但
  `isDraft` 仍是 `true`（静默不生效），而 `POST /pulls/{n}/ready_for_review` 返回 404。
- **幂等**：已经是目标状态就不发变更，如实回报「本来就是」，不发一次注定被拒的请求。
- **什么时候用**：草稿 PR 写完了要请人审查用这个（`undo` 缺省）；写完但还不能合、
  要先藏起来用 `undo=true`。只是改标题 / 正文用 `edit`，要合并不是它。
- 支撑权限 `pull_requests: write`。

### `githana_release(action="edit")` — 改发布的状态位

| 参数 | 必填 | 说明 |
|---|---|---|
| `repo` / `cwd` / `timeoutSec` | 否 | 同上 |
| `tag` | 否 | 要改的发布 tag（如 `v1.2.0`）；与 `releaseId` 二选一 |
| `releaseId` | 否 | 按数字 id 定位（与 `tag` 二选一；`tag` 优先） |
| `draft` | 否 | `true` = 转成草稿，`false` = 发布出去 |
| `prerelease` | 否 | `true` = 标为预发布，`false` = 取消预发布 |
| `latest` | 否 | **三值**：`true` / `false` / `legacy`（旧式算法决定哪个是 latest） |

```jsonc
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "draft": false }        // 草稿 → 发布
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "prerelease": true, "latest": "false" }
{ "action": "edit", "repo": "liliMozi/openhanako", "releaseId": 12345678, "latest": "legacy" }
```

- **`legacy` 不是「取消 latest」**：它的原文含义是「用旧式算法决定哪个 release 是 latest」
  （REST 的 `make_latest` 就是这三个值）。把它当 `false` 处理会改掉语义。
- **一次调用至少给一个状态位**；一个都不给会返回引导，不发一次注定 422 的请求。
- **不给「最近一个发布」的缺省**：改状态位不吃危险默认值，必须点名 `tag` 或 `releaseId`
  （`githana_release(action="list")` 看有哪些）。
- **同时设 `latest=true` 与 `draft` / `prerelease` 会被当场拒**：GitHub 不接受草稿或预发布
  作为 latest。分两次调用——先定 `draft` / `prerelease`，再单独设 `latest`。
- **只改状态位**：标题 / 正文 / 移动 tag 是发布**内容**，不属这个动词。要改它们走
  `githana_api` 打 `PATCH /repos/{owner}/{repo}/releases/{id}`（端点在能力面上），
  或到 GitHub 网页的 releases 页。
- 支撑权限 `contents: write`。

### `githana_run(action="watch")` — 盯 CI 到终态（**返回句柄，不返回结论**）

| 参数 | 必填 | 说明 |
|---|---|---|
| `repo` / `cwd` | 否 | 同上 |
| `runId` | 否 | 正整数；缺省 = 最近一次 run（`branch` 过滤，缺省取 `cwd` 的当前分支） |
| `branch` | 否 | `runId` 缺省时用来挑「最近一次」 |
| `intervalSec` | 否 | 轮询间隔秒，默认 15（范围 5~300） |
| `watchSec` | 否 | 盯守窗口秒，默认 3600（范围 60~21600）；到点仍未终结会如实回报，不无限盯 |
| `timeoutSec` | 否 | 单次 REST 请求的超时，默认 60 |

```jsonc
{ "action": "watch", "repo": "liliMozi/openhanako", "runId": 1234567890 }
{ "action": "watch", "repo": "liliMozi/openhanako", "branch": "fix/x", "intervalSec": 30, "watchSec": 7200 }
```

- **它返回的是一个任务句柄，不是 CI 结论。** 回执里给 `taskId` 与此刻的 run 状态，调用到此
  结束；CI 到终态时宿主把**结论贴回本会话的下一个输入点**（宿主后台任务的 `next-step` 档位）。
  所以不要为等它而结束回合、也不要隔一会儿再 `watch` 一次。
- **为什么不能直接等**：CI 以分钟计，占着工具回调等会堵住宿主通道（工具回调有超时）。
  本动词因此把「等」放进宿主后台任务：`ctx.tasks.create({ scope: "session",
  delivery: "next-step", chipVisibility: "show" })`。这条路径需要清单能力 `app/tasks.manage`。
- **能力未授予时**：返回可读错误，指明缺 `app/tasks.manage` 并给出替代做法（用 `view` 看
  此刻状态），**不空转**（不会建出一个永远没有东西推进的任务）。
- **中途要停**：在会话的后台任务项里取消。轮询器每一跳先读宿主任务记录，看到任务已经是终态
  就停止取数、也不再回投。
- **App 重载后恢复**：盯守坐标（repo / runId / 间隔 / 截止时刻）写在宿主任务记录的
  `metadata.githana` 里，App 换代后在 `apply` 阶段用 `ctx.tasks.list()` 把未终结的记录接回去。
  本 App **不落私有状态文件**——宿主任务记录就是事实源。
- **到点没终结**：窗口结束时任务结算为失败并给出原文（「盯守窗口已到点」），说明这不是 CI
  失败、要继续盯就再调一次 `watch`。run 中途被 `delete` 掉同理，会明确说 run 已不存在。
- **与 `view` 的分界**：`view` 报**此刻**的状态（要「等」就自己隔一会儿再看一次）；
  `watch` 报**到终态那一刻**的结论，且不占调用方的回合。
- 支撑权限 `actions: write`（轮询只读 run 与 jobs）。

## 受限动词（本期）

`action` 候选里有几个动词**能定位、能给地址，但取不到字节**。这一档与上面「已补齐的三个能力
空洞」不同：那些是**没实现**，这些是**通道不存在**——参数形态清楚（文件路径、tag、资产名…），
调用时给出**具体**的限制与替代路径。两档的分辨见 `tools/lib/surface.js` 的 `reserved` 与
`tools/actions/release/upload.js` 头注。

**二进制受限期：在 `action` 候选里，调用时给具体限制与替代路径**

| 工具 | action | 状态 | 现在怎么做 |
|---|---|---|---|
| `githana_release` | `upload` | 不写盘（通道不存在） | 用 `gh release upload`，或网页拖文件 |
| `githana_release` | `download` | 不写盘（通道不存在） | 回执里给 `browser_download_url` 与 API 取字节地址，用 `gh release download` / curl / 浏览器取 |
| `githana_run` | `download` | 不写盘（通道不存在） | 产物清单是**真的可用**（纯 JSON）；取字节用 `gh run download` / `gh run view --log` |

三条硬限制（逐条可在源码里核对）：

1. **载荷是 JSON 报文，不是 multipart**：`rest.worker.mjs` 从 stdin 读一行 JSON，请求只能带
   `json` / `form` / `body` 字符串；二进制进不去，worker 也不把 base64 解回字节。
2. **主机不在出站白名单**：上传端点 `uploads.github.com` 不在 `ALLOWED_HOSTS`；下载侧 302 到
   `objects.githubusercontent.com` / `*.blob.core.windows.net` 等，也不在 `REDIRECT_HOSTS`。
3. **响应体按 UTF-8 有界读取**：`readBounded` 上限 2MB 并 `toString("utf8")`——即使主机放行，
   二进制也会被破坏。

`githana_api` **不是**逃生门：它走同一条 worker、同一份主机白名单。

> `githana_release` 的 `verify` / `verify-asset` **不在这一档**：它们完全可用，只是口径与 gh
> 那个同名命令不同——核对的是**发布自身的完整性**（GitHub 记录的 `digest` 与本地文件的 sha256），
> 而 gh 的「来源证明（attestation）」校验做不到：`attestations` 权限不在授权集里，且 sigstore
> 验签需要一个签名验证实现，与「服务端零 npm 依赖」冲突。要那一层用 `gh attestation verify`。

**保留位：当前为空。** 前一批的三个能力空洞（`pr ready` / `release edit` / `run watch`）都已
实现并进 `action` 候选，见上面「已补齐的三个能力空洞」。`createSurface` 的 `reserved` 通路仍然
留着（`tools/lib/surface.js`），留给下一次出现「认得出、但参数契约还没定」的动词：那种值放进
候选只是给模型一个试错入口，它既说不清怎么用、调用也只能得到「未实现」。

> 旧的 `githana_read` / `githana` 两个入口上的 `ci_status` / `ci_watch` 保留位随那两个工具一起
> 移除：CI 现在是 `githana_run` / `githana_workflow` / `githana_cache` 三组真实动词，
> `githana_run(action="watch")` 就是其中的「等 CI 到终态」。

## 其它约定

- 令牌与私钥**不进**工具返回值、日志与设置页回显。GitHub 请求由随包的 REST worker 在子进程里
  直发，令牌经 stdin 传给 worker，不出 App 边界。
- 本 App 申请 `app/tools.expose-to-model`、`app/process.spawn` 与 `app/tasks.manage`
  （最后一项给 `githana_run(action="watch")` 的后台任务用），**没有** `network` 声明
  （那是宿主代发的通道，令牌会穿 IPC）。
- GPG 的密钥生成与公钥查看**不在工具面**：生成不可逆，只在设置页由用户点按钮触发。
