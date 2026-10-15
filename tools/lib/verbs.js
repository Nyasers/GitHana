// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/verbs.js — 名词工具的动词总表（跨工具错投指名的唯一来源）。
 *
 * spec gh-cli-parity AC5 要求「跨名词的错投报错**指名正确工具**」。判据是「收到的 action 落在
 * 哪个工具上」，所以每个工具都要知道**除自己之外**还有哪些工具在收哪些动词。这张索引写在一处，
 * 各工具用 `otherVerbs(name)` 取自己那一份——否则每加一个工具都要改所有工具的动词表，迟早漂。
 *
 * 同一个动词在多个工具上是常态（`create` 在 repo / pr / issue / release / label 上都有）：
 * 那种情况下「正确的工具」由调用方要操作的对象决定，不是这份表能判的，所以报错列出全部持有者
 * 让调用方选（见 surface.js 的 misroutedMessage）。
 *
 * ## 两个字段：`commands` 是 enum，`reserved` 是保留位
 *
 *   · `commands`——该工具 action 字段 enum 的**逐字镜像**（顺序也一致）。两者不一致时以
 *     surface.js 装配出的 enum 为准（那是运行期真正生效的那份）；这个字段只服务报错文案。
 *   · `reserved`——该工具**认得出、但本期未实现**的动词（见各工具的 `createSurface({ reserved })`）。
 *     它们不在 enum 里，所以要单独列：跨工具错投时，`githana_cache(action="watch")` 报「watch 属于
 *     githana_run」比报「未知 action」有用——顺着指路过去会拿到那个工具自己的说明，那是两段式的
 *     如实回报，不是死路。
 *
 * 当前**没有一个工具**带保留位：`pr ready` / `release edit` / `run watch` 三个空洞都已实现并
 * 入 enum（见 tools/actions/pr/ready.js、release/edit.js、run/watch.js）。`reserved` 这个字段
 * 留着是因为 surface.js 的装配路径仍然支持它，下一次出现「认得出但还没有实现」的动词时用它。
 *
 * 本表只登记**已注册**的工具：把还没声明的工具写进来，会让报错指向一个宿主里不存在的工具名。
 */

/** 工具名 → 该工具的动词表（`commands` 镜像 enum；`reserved` 是保留位，当前为空）。 */
export const VERB_INDEX = [
  { name: "githana_git", commands: ["exec", "commit", "push"] },
  {
    name: "githana_repo",
    commands: ["create", "list", "view", "clone", "fork", "sync", "gitignore", "license", "read-dir", "read-file"],
  },
  {
    name: "githana_pr",
    commands: [
      "create", "list", "view", "status", "diff", "checks", "ready", "merge", "review", "comment",
      "close", "reopen", "revert", "edit", "checkout", "lock", "unlock", "update-branch",
    ],
  },
  {
    name: "githana_issue",
    commands: [
      "create", "list", "view", "status", "edit", "comment", "close", "reopen", "delete",
      "develop", "transfer", "lock", "unlock", "pin", "unpin",
    ],
  },
  {
    name: "githana_release",
    commands: [
      "create", "list", "view", "edit", "delete", "upload", "download", "delete-asset", "verify", "verify-asset",
    ],
  },
  {
    name: "githana_run",
    commands: ["list", "view", "watch", "rerun", "cancel", "delete", "download"],
  },
  { name: "githana_workflow", commands: ["list", "view", "run", "enable", "disable"] },
  { name: "githana_cache", commands: ["list", "delete"] },
  { name: "githana_label", commands: ["clone", "create", "edit", "delete", "list"] },
  {
    name: "githana_api",
    commands: ["api"],
    // 单动词工具没有 action 可填：`name(action="api")` 是错的指路，所以它自己写明调用形态。
    usage: "githana_api(path=\"/…\")——它是单动词工具，不填 action",
  },
];

/** 除自己之外的动词表（`verbs` 参数用它：surface.js 只在这里面找错投的归属）。 */
export function otherVerbs(name) {
  return VERB_INDEX.filter((v) => v.name !== name);
}

/**
 * 一个工具**认得出**的全部动词：enum 里的 + 保留位里的。
 *
 * 报错文案（surface.js 的 misroutedMessage）用这个判归属，而不是只用 `commands`——
 * 否则保留位动词在别的工具上报出来会像「没这个动作」，而它其实属于某个具体工具。
 */
export function recognizedCommands(entry) {
  const commands = Array.isArray(entry && entry.commands) ? entry.commands : [];
  const reserved = Array.isArray(entry && entry.reserved) ? entry.reserved : [];
  return commands.concat(reserved);
}
