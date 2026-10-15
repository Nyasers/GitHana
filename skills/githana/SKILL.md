---
name: githana
description: "GitHana: local git and GitHub operations. Read before any githana_git / githana_repo / githana_pr / githana_issue / githana_release / githana_run / githana_workflow / githana_cache / githana_label / githana_api call — per-action parameters, when to use each action, examples, the capability boundary with its escape hatch, and the permission gaps."
---

# githana：用法手册

GitHana 是 **gh CLI 的 App 形态实现**：`gh <组> <动词>` 对应 `githana_<组>(action="<动词>")`，
`--flag` 对应该 action 的参数；`gh auth` / `gh config` 由设置页接管，TTY 交互由审批卡接管。
工具面按 **gh 的组**分成十个名词工具——每个工具一张自己的参数表。

## 工具面

| 工具 | 权限档 | 动词 |
|---|---|---|
| `githana_git` | `external_side_effect`（过审） | `exec` · `commit` · `push` |
| `githana_repo` | `external_side_effect` | `create` · `list` · `view` · `clone` · `fork` · `sync` · `gitignore` · `license` · `read-dir` · `read-file` |
| `githana_pr` | `external_side_effect` | `create` · `list` · `view` · `status` · `diff` · `checks` · `ready` · `merge` · `review` · `comment` · `close` · `reopen` · `revert` · `edit` · `checkout` · `lock` · `unlock` · `update-branch` |
| `githana_issue` | `external_side_effect` | `create` · `list` · `view` · `status` · `edit` · `comment` · `close` · `reopen` · `delete` · `develop` · `transfer` · `lock` · `unlock` · `pin` · `unpin` |
| `githana_release` | `external_side_effect` | `create` · `list` · `view` · `edit` · `delete` · `upload` · `download` · `delete-asset` · `verify` · `verify-asset` |
| `githana_run` | `external_side_effect` | `list` · `view` · `watch` · `rerun` · `cancel` · `delete` · `download` |
| `githana_workflow` | `external_side_effect` | `list` · `view` · `run` · `enable` · `disable` |
| `githana_cache` | `external_side_effect` | `list` · `delete` |
| `githana_label` | `external_side_effect` | `clone` · `create` · `edit` · `delete` · `list` |
| `githana_api` | `external_side_effect` | 单动词，**不带 `action`**，必填 `path` |

`githana_git` **不是** gh 的组，是自有工具（本地 git；gh 从不管本地 commit）。`githana_api`
是逃生门（`gh api` 的对应物，gh 自己也留着它）。

调用形态是「工具名 + action + 该 action 的参数」：

```jsonc
{ "action": "status", "repo": "liliMozi/openhanako", "prNumber": 21 }        // githana_pr
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "message": "…" }      // githana_git
{ "path": "/user/repos?per_page=50", "paginate": true }                      // githana_api（无 action）
```

`action` 仅在动词数 ≥ 2 的工具上声明；`githana_api` 只有 `path` 必填。

## 逐 action：什么时候用

工具面在每个新上下文里都被重新读一遍，没有积累下来的习惯可依赖——所以每个动词给的是
**取值选择依据**（不是参数清单的复述）。参数形状以工具自身的 `parameters` 为准。

### githana_git（本地 git）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `exec` | 任意 git 子命令透传：常见动词覆盖不到的本机操作（`pull` / `stash` / `checkout -b` / `show` / `log --stat`）。**它不追加署名**，纯透传 | `cwd` 必填；`args` 必填（数组，无 shell 拼接） |
| `commit` | 要产生提交时**一律走它**（`exec` 不追加 Co-authored-by）。自动 CoA + OpenPGP 签名 | `cwd` 必填；`message` 必填（经 stdin，多行/中文无损）；`paths` / `amend` / `allowEmpty` |
| `push` | 要把本地提交送上远端时。已登录时用 App 令牌认证（见下面「远端凭据」） | `cwd` 必填；`branch` / `remote` / `setUpstream` / `force` / `dryRun` |

`commit` 与 `exec` 的分界是**署名治理**：要 CoA 与签名就用 `commit`，要 git 原样行为就用 `exec`。
要 `git diff` 这类只读细节也是 `exec`（`commit` 不带 diff 输出）。

### githana_repo（仓库）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `view` | 看**一个已知仓库**的元数据（默认分支、可见性、fork 关系）。要从当前目录反推仓库时用它 | `repo` 或 `cwd` |
| `list` | **找**仓库 / 列一批（自己的、某 owner 的）。想知道「有哪些」而不是「这个是什么」 | `owner` / `visibility` / `limit`；**不吃 `repo`** |
| `create` | 新建仓库（**只在当前登录账号下**）。组织下建仓库不在能力面，见「能力边界」 | `name` 必填；`private` / `autoInit` / `gitignore` / `license` / `homepage` / `description` |
| `clone` | 要把仓库**落到本机磁盘**（唯一能产生「可继续 commit / push 的本地仓库」的手段）。注意 `cwd` 在这里是**父目录** | `repo` 必填（不推断）；`cwd` 必填；`directory` / `branch` / `depth` |
| `fork` | 把别人的仓库 fork 到**自己账号下**。fork 到组织不在能力面 | `repo` 或 `cwd`；`name` / `defaultBranchOnly` |
| `sync` | fork 与上游对齐（本地 `fetch` + 合并）。**只动本地克隆，不推送** —— 之后还要 `push` | `cwd` 必填；`branch` / `strategy`（`merge` / `ff-only` / `rebase`）/ `remote` |
| `gitignore` | 建仓库前查 `.gitignore` 模板名（不给 `template` 列全部名，给了看该模板正文） | `template` 可选；别的键都不吃 |
| `license` | 建仓库前查许可证模板 key（`create` 的 `license` 参数取这里的值，如 `mit`） | `full`（默认只列 key / 名称 / SPDX ID 三列，`true` 打完整响应）；`timeoutSec` |
| `read-dir` | 读**远端**仓库某目录的文件清单（不用先 clone） | `repo` 或 `cwd`；`path` / `ref` |
| `read-file` | 读**远端**仓库某文件正文（不用先 clone） | `repo` 或 `cwd`；`path` 必填；`ref` |

`view` / `list` 常被混用：**找用 `list`，看用 `view`**。`list` 不接受 `repo`（它列的是集合），
`view` 要一个具体仓库。`read-dir` / `read-file` 与 `clone` 的分界是**要不要本地副本**：
只看内容用前者，要改代码用后者。

### githana_pr（Pull Request）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `view` | **看**一个 PR 的详情（含 reviews）：要正文、审查状态、合并状态 | `prNumber`（缺省 = 当前分支关联 PR，此时要 `cwd`） |
| `list` | **找** PR：列一批按状态过滤，还不知道编号 | `state` / `limit`；不接受 `prNumber` |
| `status` | PR **状态速览**（含审查与检查计数）：只要一眼结论、不要正文 | `prNumber` 可缺省 |
| `diff` | 要看**补丁正文**（改了什么） | `prNumber`；`format`（`diff` / `patch`） |
| `checks` | 只看 **CI 检查**状态（不看代码、不看审查） | `prNumber` 可缺省 |
| `create` | 开新 PR。**不自动推分支**：head 分支没推上去会显式报错并引导先 `push` | `cwd` 实际必填（取 head 与缺省 title）；`base` 缺省取默认分支；`title` / `body` / `draft` |
| `ready` | 草稿 PR ↔ 可审查的**状态位切换**（`undo=true` 反向转回草稿）。改标题/正文不是它 | `prNumber`；`undo` |
| `merge` | 合并（**不可撤销**）。要放弃改动请用 `close` | `prNumber` 必填；`method`（`merge` / `squash` / `rebase`）；`deleteBranch` |
| `review` | 提交**审查结论**（批准 / 请求修改 / 留意见），可带行内意见 | `event` 必填；`body`（`request-changes` 必填）；`comments[]` |
| `comment` | 只在时间线上**留一条评论**（不是审查结论，不影响 reviewDecision） | `body` 必填 |
| `close` | 关闭 PR（可 `reopen` 还原）。**不删分支与历史** | `prNumber` 可缺省 |
| `reopen` | 重开已关闭的 PR | `prNumber` 可缺省 |
| `edit` | 改 PR 的**元数据**：标题 / 正文 / 目标分支 / 状态位 | `title` / `body` / `base` / `state` 至少给一个 |
| `revert` | 回退**已合并**的 PR（本地 revert + 新分支 + 开回退 PR）。没合并没有可回退的东西 | `cwd` 必填；`prNumber` 必填；`branch` / `title` / `body` / `draft` / `remote` |
| `checkout` | 把 PR 的源分支**取到本地并检出**（要在本机改这个 PR 的代码时） | `cwd` 必填；`prNumber` 必填；`branch` / `remote` / `force` |
| `lock` / `unlock` | 锁定 / 解锁对话（挡非协作者评论） | `prNumber`；`lock` 另有 `reason` |
| `update-branch` | 把**目标分支合进 PR 源分支**（「Update branch」按钮的等价物） | `prNumber`；`expectedHeadSha`（乐观并发保护） |

四个易混分界：**找 `list` / 看 `view` / 速览 `status` / 补丁 `diff`**。
要「等 CI 到终态」用 `githana_run(action="watch")`，不是 `checks`（后者只报此刻）。

### githana_issue（Issue）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `view` | 看 issue 详情（含评论） | `issueNumber` 必填；`comments` |
| `list` | 列 issue（默认**不含 PR**；要 PR 用 `githana_pr(action="list")`） | `state` / `labels` / `assignee` / `includePrs` / `limit` |
| `status` | issue 状态速览（只报状态，不拉正文与评论） | `issueNumber` 必填 |
| `create` | 新建 issue | `title` 必填；`body` / `labels` / `assignees` |
| `edit` | 改标题 / 正文 / 标签 / 指派 / 里程碑 | `issueNumber` 必填；`labels`（整体替换）与 `addLabels` / `removeLabels` 互斥 |
| `comment` | 给 issue 加评论 | `body` 必填 |
| `close` / `reopen` | 关闭 / 重开（可选附一条说明评论，先评论再改状态） | `issueNumber`；`comment` |
| `delete` | 删除 issue（**不可撤销**，需 `confirm=true`） | `issueNumber` 必填；`confirm` |
| `develop` | 从 issue **建关联开发分支**（分支名缺省 `<编号>-<标题短横线形式>`） | `issueNumber` 必填；`name` / `base` |
| `transfer` | 把 issue 转到**另一个仓库** | `issueNumber` 必填；`targetRepo` 必填 |
| `lock` / `unlock` | 锁定 / 解锁对话 | `issueNumber`；`lock` 另有 `reason` |
| `pin` / `unpin` | 固定 / 解除固定到仓库顶部 | `issueNumber` 必填 |

`comment` 与 `edit` 的分界：`comment` 只往时间线追加，`edit` 改的是 issue 本体字段。

### githana_release（发布）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `view` | 看**一个**发布的详情（含资产清单） | `tag` 缺省 = 最近一次发布的（不含草稿/预发布）；或 `releaseId` |
| `list` | 列发布（默认**滤掉草稿**；要草稿传 `includeDrafts=true`） | `limit` / `includeDrafts` |
| `create` | 新建发布（tag 不存在时按 `target` 新建） | `tag` 必填；`name` / `body` / `draft` / `prerelease` / `target` / `generateNotes` / `latest` |
| `edit` | 只改**状态位**：`draft` / `prerelease` / `latest`（改标题正文不属它） | 至少给一个状态位；`tag` 或 `releaseId` **必须点名** |
| `delete` | 删除发布（**不可撤销**，需 `confirm=true`；**不删 tag**） | `tag` 必填；`confirm` |
| `upload` | **本期不可用**（二进制通道不存在）——见「能力边界」 | `file` 要本地绝对路径 |
| `download` | **不写盘**：回执给 `browser_download_url` 与 API 取字节地址 | `tag` 必填；`assetName` / `assetId` |
| `delete-asset` | 删发布里的一个资产（**不可撤销**，需 `confirm=true`） | `tag` + `assetName` 必填 |
| `verify` | 核对发布的**完整性**：资产 sha256 清单，可选与本地文件比对 | `tag` 必填；`files[]` |
| `verify-asset` | 核对**一个**资产的摘要（可选与本地文件比对） | `tag` + `assetName` 必填；`file` |

`list` 与 `view` 的取舍同 PR：列一批用 `list`，看一个用 `view`。
`verify` 核的是**发布自身完整性**（GitHub 记录的 `digest` vs 本地 sha256），**不是** gh 的
「来源证明（attestation）」校验——那一层做不到（见「能力边界」）。

### githana_run（Actions run）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `view` | 看**此刻**一个 run 的详情（含各作业状态）。要「等它跑完」用 `watch` | `runId` 或 `branch`；`job`（按名字过滤） |
| `list` | 列 run（按分支 / 状态 / 工作流 / 触发人过滤） | `branch` / `workflow` / `actor` / `limit` |
| `watch` | 要**等 CI 到终态**并拿结论。**返回后台任务句柄，不返回结论** | `runId` 或 `branch`；`intervalSec` / `watchSec` |
| `rerun` | 重跑（`failedOnly=true` 只重跑失败作业） | `runId` 或 `branch`；`failedOnly` / `debugLogging` |
| `cancel` | 取消进行中的 run（尽力而为） | `runId` 或 `branch` |
| `delete` | 删除 run 记录（**不可撤销**，需 `confirm=true`） | `runId` **必填**（不吃「最近一个」缺省）；`confirm` |
| `download` | **不写盘**：列日志 / 产物清单与地址 | `runId` 或 `branch`；`what`（`logs` / `artifacts`）/ `artifactName` |

`view` 与 `watch` 的分界是**要不要等**：`view` 报此刻（要更新就自己再看一次），
`watch` 报到终态那一刻的结论、且不占调用方的回合。`watch` 的细节见
下面「三个形态特殊的动词」。

### githana_workflow（工作流）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `list` | 列仓库里的工作流（默认含被停用的；只看启用的传 `enabledOnly=true`） | `enabledOnly` / `limit` |
| `view` | 看**一个**工作流的定义（不含 YAML 正文） | `workflow` 必填（数字 ID 或文件名） |
| `run` | **手动触发**（`workflow_dispatch`）。同步触发、**不等 CI**（要等就接着 `githana_run(action="watch")`） | `workflow` 必填；`ref` |
| `enable` | 启用（恢复它的自然触发） | `workflow` 必填 |
| `disable` | 停用（挡自然触发，**不挡手动 dispatch**） | `workflow` 必填 |

`workflow run` 与 `run rerun` 的分界：前者按**工作流**起一次新的，后者按**已有 run 编号**再来一遍。

### githana_cache（构建缓存）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `list` | 看仓库有哪些缓存（按 key / ref 过滤、按大小或时间排序，通常为了腾配额） | `key` / `ref` / `sort` / `direction` / `limit` |
| `delete` | 删缓存：按 `id` 删一条，或按 `key`（+`ref`）删一族 | `id` 或 `key`；按 key 且不给 `ref` 时需 `confirm=true` |

### githana_label（标签）

| action | 什么时候用 | 关键参数 |
|---|---|---|
| `list` | 列仓库标签（拿准名字，别的动词要按名字引用标签） | `limit` |
| `create` | 新建标签（同名已存在会 422） | `name` 必填；`color` / `description` |
| `edit` | 改**现有**标签（改名用 `newName`） | `name` 必填（定位用）；`newName` / `color` / `description` |
| `delete` | 删除标签（会从所有已打它的 issue / PR 上摘掉；需 `confirm=true`） | `name` 必填；`confirm` |
| `clone` | 把**另一个仓库**的标签整套搬过来 | `fromRepo` **必填**（源）；`repo`（目标，缺省从 cwd 推断） |

### githana_api（逃生门，单动词）

| 什么时候用 | 关键参数 |
|---|---|
| 类型化动词覆盖不到的长尾能力（见「能力边界」的端点表）。**不填 `action`** | `path` 必填（api.github.com 之后的路径，带前导斜杠）；`method`（缺省 `GET`）；`body`（JSON，`POST` / `PATCH` / `PUT`）；`repo`（替换 `path` 里的 `{owner}` / `{repo}` 占位符）；`paginate`（跟随 Link 分页，上限 10 页） |

查询串直接拼在 `path` 里（`/repos/o/r/issues?state=all&per_page=50`）。它**不做 cwd 推断**：
`repo` 只用于替换占位符。`POST /graphql` 走同一个 `path`（GraphQL 与 REST 都是端点，
动作内部按「哪个能实现」选，对外不暴露通道差异）。

## 三个形态特殊的动词

这三个的形态与同工具其它动词不同，容易按惯性调错，所以单独写清。

### `githana_pr(action="ready")` — 草稿 PR 转 ready（可反向）

```jsonc
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42 }              // 草稿 → 可审查
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42, "undo": true } // 可审查 → 草稿
```

- **不暴露通道差异**：内部先 REST `GET /pulls/{n}` 取 `node_id`，再发 GraphQL 变更
  （`markPullRequestReadyForReview` / `convertPullRequestToDraft`）。原因是一条实测事实：
  **un-draft 只有 GraphQL 能做**——REST `PATCH /pulls/{n}` 带 `{draft:false}` 返回 200 但
  `isDraft` 仍是 `true`（静默不生效），而 `POST /pulls/{n}/ready_for_review` 返回 404。
- **幂等**：已经是目标状态就不发变更，如实回报「本来就是」，不发一次注定被拒的请求。
- **什么时候用**：草稿写完了要请人审查用这个（`undo` 缺省）；写完但还不能合、要先藏起来用
  `undo=true`。改标题 / 正文用 `edit`，要合并不是它。
- 支撑权限 `pull_requests: write`。

### `githana_release(action="edit")` — 改发布的状态位

```jsonc
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "draft": false }        // 草稿 → 发布
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "prerelease": true, "latest": "false" }
{ "action": "edit", "repo": "liliMozi/openhanako", "releaseId": 12345678, "latest": "legacy" }
```

- **`legacy` 不是「取消 latest」**：原文含义是「用旧式算法决定哪个 release 是 latest」
  （REST 的 `make_latest` 就是这三个值）。把它当 `false` 处理会改掉语义。
- **一次调用至少给一个状态位**；一个都不给会返回引导，不发一次注定 422 的请求。
- **不给「最近一个发布」的缺省**：改状态位不吃危险默认值，必须点名 `tag` 或 `releaseId`。
- **同时设 `latest=true` 与 `draft` / `prerelease` 会被当场拒**：GitHub 不接受草稿或预发布
  作为 latest。分两次调用。
- **只改状态位**：标题 / 正文 / 移动 tag 是发布**内容**，走 `githana_api` 打
  `PATCH /repos/{owner}/{repo}/releases/{id}`（端点在能力面上）。
- 支撑权限 `contents: write`。

### `githana_run(action="watch")` — 盯 CI 到终态（**返回句柄，不返回结论**）

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
  此刻状态），**不空转**。
- **中途要停**：在会话的后台任务项里取消。轮询器每一跳先读宿主任务记录，看到任务已经是终态
  就停止取数、也不再回投。
- **App 重载后恢复**：盯守坐标写在宿主任务记录的 `metadata.githana` 里，App 换代后在 `apply`
  阶段用 `ctx.tasks.list()` 把未终结的记录接回去。本 App **不落私有状态文件**。
- **到点没终结**：窗口结束时任务结算为失败并给出原文（「盯守窗口已到点」），说明这不是 CI
  失败、要继续盯就再调一次 `watch`。
- 支撑权限 `actions: write`（轮询只读 run 与 jobs）。

## cwd 约定

`cwd` 一律是**仓库的绝对路径**（如 `E:\\workspace\\my-repo`），不做工作目录隐式推断。

| 动词 | cwd |
|---|---|
| `githana_git` 的 `exec` / `commit` / `push` | **必填** |
| `githana_repo` 的 `clone`（**父目录**）/ `sync` | **必填** |
| `githana_pr` 的 `checkout` / `revert` | **必填**（要在本地做 git 操作） |
| `githana_pr` 的 `create` | 实际必填（head 取它的当前分支；`title` 缺省也读它） |
| `githana_pr` 的 `view` / `status` / `ready` 等 | 可选，但要拿「当前分支关联 PR」这个缺省时必填 |
| 其余 GitHub 动词 | 可选（仅在没传 `repo` 时用来从 git remote 推断仓库） |
| `githana_api` | **不接受**：它只按 `path` 打端点，`repo` 只用于替换占位符 |

GitHub 动作的仓库上下文：**`repo`（owner/repo）显式优先**；没传就从 `cwd` 的 git remote 推断；
两者都没有 → 报错并给引导，不猜（`githana_api` 例外）。

## 能力边界与逃生门

工具面的边界由 **App 权限**定：每个类型化的动词都有一个支撑它的已授权权限。所以
「gh 有而我们没有」（无权限 / 无对应语义）与「动词在但做不到」（通道不存在）都逐项登记在下，
分五档——**缺什么、怎么绕，都能在这里查到**，不必靠碰壁。

逃生门是 `githana_api`：它把 `path` 直接打到 `api.github.com`。**端点的路径、参数与返回形状
以 GitHub REST 文档为准**（`https://docs.github.com/rest`）——下面的端点是定位用的索引，
不是契约的替代品。**越出权限面的端点会被 GitHub 直接拒（403）**，`api` 透传也越不过去。

### 一、未类型化：有 gh 语义，但我们不为它声明工具（走 `githana_api`）

| gh 组 | 主要 REST 端点 | 缺的权限 |
|---|---|---|
| `secret` | `PUT /repos/{o}/{r}/actions/secrets/{name}`、`GET …/actions/secrets` | `secrets: write` |
| `variable` | `POST/PATCH/DELETE /repos/{o}/{r}/actions/variables` | `actions_variables: write` |
| `ssh-key` | `GET/POST /user/keys`、`DELETE /user/keys/{id}` | `keys: write`（account） |
| `gist` | `GET/POST /gists`、`PATCH/DELETE /gists/{id}` | `gists: write`（account） |
| `codespace` | `GET/POST /user/codespaces`、`POST …/{name}/start` | `codespaces: write` |
| `webhook` | `GET/POST /repos/{o}/{r}/hooks`、`PATCH/DELETE …/hooks/{id}` | `repository_hooks: write` |
| `attestation` | `GET /repos/{o}/{r}/attestations/{subject_digest}` | `attestations: write`（端点仍是 Preview） |
| `discussion` | GraphQL：`repository.discussions`（REST 覆盖很少） | `discussions` |
| `project` | GraphQL：`POST /graphql`（Projects V2） | `repository_projects` |
| `ruleset` | `GET/POST /repos/{o}/{r}/rulesets` | 部分无需权限（只读公开仓库可用） |
| `gpg-key` | `GET/POST /user/gpg_keys`、`DELETE /user/gpg_keys/{id}` | **有** `gpg_keys: write`——但已由设置页链路接管（见下） |
| `licenses` | `GET /licenses`、`GET /licenses/{license}` | 无（公开端点）；已类型化为 `githana_repo(action="license")` |
| `org` | `GET /orgs/{org}`、`GET /orgs/{org}/repos` | organization 权限 **0 项（从未申请）** |
| `status` | `GET /repos/{o}/{r}/commits/{ref}/status` | `statuses` 未授权 |

`gpg-key` 是这一档里唯一的例外：**它有权限，但不进工具面**——密钥生成与公钥发布由设置页
一条链路做完（生成 = 生成 + 上传，移除 = 远端删 + 本地清），比拆成动词让模型分步调更安全。
要直接看 / 补公钥用上面两个端点。

### 二、无权限的动词：从 zod 定义里删掉了（`action` 候选里没有它们）

已授权集里**没有** `administration`，所以仓库本体操作不在能力面上。这些动词**不在**
`githana_repo` 的 `action` 候选里（zod 是模型面与运行期校验的同一来源，删掉即两边同时消失），
因此调用它们会被报成「未知 action」——那是刻意的：省掉一次注定 403 的调用。

| gh 动词 | 缺哪个权限 | 现在怎么做 |
|---|---|---|
| `repo edit`（改简介 / 可见性 / 默认分支） | `administration: write` | 网页操作；`githana_api` 打 `PATCH /repos/{o}/{r}` 也会被 403 |
| `repo delete` / `rename` | `administration: write` | 同上（删仓库、改仓库名在这个 App 里做不到） |
| `repo archive` / `unarchive` | `administration: write` | 同上 |
| `repo set-default` / `autolink` / `deploy-key` | `administration: write` | 同上 |
| `repo create --org <org>` | `administration: write` + organization 权限 | 只能建在当前登录账号下（`POST /user/repos`） |
| `repo fork --org <org>` | organization 权限（0 项） | 只能 fork 到当前登录账号下 |
| `repo list` 的组织形态 | organization 权限 | 用 `owner="<组织名>"` 走 `/users/{owner}/repos`（只含公开仓库） |

这一档与第一档的**区别在动作**：第一档是「工具不存在，用 `api` 打端点」；这一档是「工具存在，
但那个动词被删了，用 `api` 打端点会 403」。两档的共同点是缺口都写在这里，不伪装成不存在。

### 三、丢弃：无对应远端语义或已由 App 形态接管（**不适用**，不必找）

| gh 组 | 为什么 |
|---|---|
| `auth` · `config` | 设置页接管（登录 / 签名身份 / 运行环境） |
| `alias` | 动词表固定，没有别名需求 |
| `completion` · `extension` · `preview` · `copilot` | gh 的 CLI 本机特性，无远端语义 |
| `browse` | 开浏览器是 UI 插槽的事 |
| `skill` | Hana 侧有自己的 skill 体系 |

### 四、通道受限：动词在，但**取不到字节**（不是没实现，是通道不存在）

| 工具 | action | 现状 | 替代路径 |
|---|---|---|---|
| `githana_release` | `upload` | 不写盘（通道不存在） | 用 `gh release upload`，或网页拖文件 |
| `githana_release` | `download` | 不写盘（通道不存在） | 回执给 `browser_download_url` 与 API 取字节地址，用 curl / 浏览器取 |
| `githana_run` | `download` | 不写盘（通道不存在） | 产物清单**真的可用**（纯 JSON）；取字节用 `gh run download` / `gh run view --log` |

三条硬限制（逐条可在源码里核对）：

1. **载荷是 JSON 报文，不是 multipart**：`rest.worker.mjs` 从 stdin 读一行 JSON，请求只能带
   `json` / `form` / `body` 字符串；二进制进不去，worker 也不把 base64 解回字节。
2. **主机不在出站白名单**：上传端点 `uploads.github.com` 不在 `ALLOWED_HOSTS`；下载侧 302 到
   `objects.githubusercontent.com` / `*.blob.core.windows.net` 等，也不在 `REDIRECT_HOSTS`。
3. **响应体按 UTF-8 有界读取**：`readBounded` 上限 2MB 并 `toString("utf8")`——即使主机放行，
   二进制也会被破坏。

`githana_api` **不是**这一档的逃生门：它走同一条 worker、同一份主机白名单。

> `githana_release` 的 `verify` / `verify-asset` **不在这一档**：它们完全可用，只是口径与 gh
> 那个同名命令不同——核对的是**发布自身的完整性**（GitHub 记录的 `digest` 与本地文件的 sha256），
> 而 gh 的「来源证明（attestation）」校验做不到：`attestations` 权限不在授权集里，且 sigstore
> 验签需要一个签名验证实现，与「服务端零 npm 依赖」冲突。要那一层用 `gh attestation verify`。

### 五、保留位：当前为空

`createSurface` 的 `reserved` 通路仍然留着（`tools/lib/surface.js`），留给下一次出现
「认得出、但参数契约还没定」的动词：那种值放进候选只是给模型一个试错入口，它既说不清怎么用、
调用也只能得到「未实现」。旧 `githana_read` / `githana` 两个入口上的 `ci_status` / `ci_watch`
保留位随那两个工具一起移除——CI 现在是 `githana_run` / `githana_workflow` / `githana_cache`
三组真实动词。

### 对照面：已授权的权限（上面五档按它核）

8 项 repository：`actions` / `checks` / `contents` / `issues` / `metadata` /
`pull_requests` / `repository_creation` / `workflows`（write/read 见 spec D7）；
1 项 account：`gpg_keys`；organization 与 enterprise **各 0 项**。
**改 App 权限后老用户要重走一次 device flow** 才拿到新范围——不重新授权时新动词会 403。

## 远端凭据（git 子进程）

`githana_git(action="push")` / `clone` / `sync` / `pr checkout` / `pr revert` 都要访问远端。

- **已登录时**：GitHub App 令牌经 **credential helper** 注入 git 子进程，**只对 github.com 的
  https 远端生效**。令牌不进命令行、不进 `git remote -v` 可见的配置、不进隔离 gitconfig——
  它是经子进程 env 递给一个只回 `username` / `password` 的 helper 片段
  （`tools/lib/git-cred.js`）。所以换台机器、本机没有该远端凭据时也能推。
- **只在确实要访问远端的 git 调用上注入**（`push` / `fetch` / `pull` / `clone` / `ls-remote`，
  且命令行不带 `-c` / `--exec-path` / `ext::` 这类能改写运行环境的形态）。`githana_git(action="exec")`
  跑只读命令（`status` / `log` / `diff` / `remote -v`）时子进程里**没有**令牌，所以顺带把令牌
  打出来的做法行不通。
- **未登录时**：不注入任何凭据，git 回落**系统 Git 凭据**（Git Credential Manager）——
  与登录之前的行为一致。认证失败会给出「去设置页点『用 GitHub 登录』」的引导，不静默失败。
- **本机已有有效的 github.com 凭据时**：系统那份 helper 可能先应答，那次就用系统凭据；本机没有
  该远端凭据时（换台机器）落到 App 令牌这条。
- **非 github.com 的远端**（GitLab、自建、ssh）：不注入 App 令牌，走系统凭据；ssh 远端本就不
  经 credential helper。
- 带 `.github/workflows/*` 改动的推送需要 `workflows: write`。它在当前授权集里，**已在位**；
  若被 GitHub 拒，说明令牌是加该权限之前签发的——到设置页重新登录即可。

## 错误引导

| 现象 | 含义与做法 |
|---|---|
| `缺少 action` / `未知 action` | 报错会**列出本工具的可用值**；不猜、不回落默认分支 |
| `… 属于 githana_x` | 跨名词错投：该 action 在**另一个工具**上，报错里直接给出该用的工具（同名的动词有多处时全部列出，按要操作的对象选） |
| `参数校验失败（共 N 处）` | 参数形状不对（多余键、类型不符、超出 enum）。下面是**全部** issues，每行 `字段路径 [code] 英文原文`——按路径逐条改正后重试 |
| `未实现` | 该 action 是保留位（当前为空，见「能力边界」第五节） |
| `无法建立后台任务：宿主没有授予 app/tasks.manage 能力` | `githana_run(action="watch")` 需要宿主后台任务面。用 `githana_run(action="view")` 看此刻状态 |
| `尚未完成 GitHub App 授权` | 到 GitHana 设置页点「用 GitHub 登录」后重试 |
| `需要重新授权` | 上次令牌刷新失败（refresh_token 失效或授权被撤销），到设置页重新授权 |
| `当前目录不是 git 仓库` | `cwd` 指错了，或目录尚未 `git init` |
| `git 未配置提交者身份` | 先 `git config user.name / user.email`（可用 `exec`） |
| `远端拒绝了快进推送` | 先拉取合并，或用 `push` 的 `force=true`（`--force-with-lease`）安全覆盖 |
| 远端认证失败 | 见上面「远端凭据」：已登录用 App 令牌，未登录走系统凭据；两者都给出对应引导 |
| `源分支 … 在远端不存在或没有新提交` | 分支还没推：先 `githana_git(action="push")` 再建 PR |
| `path 必须以 / 开头` | `api` 的 `path` 是 api.github.com 之后的路径（带前导斜杠） |
| GitHub 403 | 越过 App 权限面了：查「能力边界」看该端点缺哪个权限，别重试 |

> **每个 action 只接受自己声明的字段。** 参数表由 zod 定义生成、运行期也用同一份校验，
> 所以多传一个不属于该 action 的键会被当场拒（并列出 issues），不会被静默忽略。

## 其它约定

- 令牌与私钥**不进**工具返回值、日志与设置页回显。GitHub 请求由随包的 REST worker 在子进程里
  直发，令牌经 stdin 传给 worker；git 子进程的凭据经 env 递给 credential helper（同样不进
  命令行与配置文件）。
- 本 App 申请 `app/tools.expose-to-model`、`app/process.spawn` 与 `app/tasks.manage`
  （最后一项给 `githana_run(action="watch")` 的后台任务用），**没有** `network` 声明
  （那是宿主代发的通道，令牌会穿 IPC）。
- GPG 的密钥生成与公钥查看**不在工具面**：生成不可逆，只在设置页由用户点按钮触发。
