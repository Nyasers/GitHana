---
name: githana
description: "GitHana: local git and GitHub operations. Read before any githana / githana_read call — actions, parameters, examples, and the read/write split."
---

# githana：用法手册

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
| `pr_list` / `pr_merge` / `api` | 可选（仅在没传 `repo` 时用来从 git remote 推断仓库） |

GitHub 动作的仓库上下文：**`repo`（owner/repo）显式优先**；没传就从 `cwd` 的 git remote 推断；
两者都没有 → 报错并给引导，不猜。

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
| `它属于另一个面` | 该 action 在另一个入口；报错里直接给出改用的工具与 action |
| `未实现` | 该 action 是保留位（见下），本期未实现 |
| `尚未完成 GitHub App 授权` | 到 GitHana 设置页点「用 GitHub 登录」后重试 |
| `需要重新授权` | 上次令牌刷新失败（refresh_token 失效或授权被撤销），到设置页重新授权 |
| `当前目录不是 git 仓库` | `cwd` 指错了，或目录尚未 `git init` |
| `git 未配置提交者身份` | 先 `git config user.name / user.email`（可用 `exec`） |
| `远端拒绝了快进推送` | 先拉取合并，或用 `push` 的 `force=true`（`--force-with-lease`）安全覆盖 |
| `源分支 … 在远端不存在或没有新提交` | 分支还没推：先 `githana(action="push")` 再建 PR |
| `path 必须以 / 开头` | `api` 的 `path` 是 api.github.com 之后的路径（带前导斜杠） |
| `method 只能是 GET / HEAD` | 只读面的 `api` 只收安全动词；写操作改用 `githana(action="api")` |

## 保留位：CI（本期未实现）

下面两个 action **只在 action 表与手册里留位**，调用会明确回报「未实现」，不会静默失败：

| 工具 | action | 状态 | 现在怎么做 |
|---|---|---|---|
| `githana_read` | `ci_status` | 未实现 | 用 `api(action="api")` 直接查 GitHub 的 check-runs / workflow-runs 端点 |
| `githana` | `ci_watch` | 未实现 | 同上；监听形态要等后台任务通道落地 |

`ci_watch` 不是「多一个 api 调用」：GitHub 没有面向本地 App 的 webhook，只能轮询；轮询占着
工具调用会撞宿主回调的 30 秒上限，必须注册后台任务并在完成后唤醒会话，形状与 DSHana 的
open / get 同构。那需要新增清单能力声明，且返回契约要能容纳「返回句柄而非结果」这一档——
所以留位是为了让返回契约现在就留出这个口。

## 其它约定

- 令牌与私钥**不进**工具返回值、日志与设置页回显。GitHub 请求由随包的 REST worker 在子进程里
  直发，令牌经 stdin 传给 worker，不出 App 边界。
- 本 App 只申请 `app/tools.expose-to-model` 与 `app/process.spawn`；没有 `network` 声明
  （那是宿主代发的通道，令牌会穿 IPC）。
- GPG 的密钥生成与公钥查看**不在工具面**：生成不可逆，只在设置页由用户点按钮触发。
