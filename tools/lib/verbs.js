// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/verbs.js — 名词工具的动词总表（跨工具错投指名的唯一来源）。
 *
 * spec gh-cli-parity AC5 要求「跨名词的错投报错**指名正确工具**」。判据是「收到的 action 落在
 * 哪个工具上」，所以每个工具都要知道**除自己之外**还有哪些工具在收哪些动词。这张索引写在一处，
 * 各工具用 `otherVerbs(name)` 取自己那一份——否则每加一个工具都要改所有工具的动词表，迟早漂。
 *
 * 同一个动词在多个工具上是常态（`create` 在 repo / pr / issue / label 上都有）：那种情况下
 * 「正确的工具」由调用方要操作的对象决定，不是这份表能判的，所以报错列出全部持有者让调用方选
 * （见 surface.js 的 misroutedMessage）。
 *
 * 本表只登记**已注册**的工具：把还没声明的工具写进来，会让报错指向一个宿主里不存在的工具名。
 * 下批（release / run / workflow / cache）落地时在这里追加各自一行。
 */

/** 工具名 → 该工具的完整动词表（顺序与该工具 action 字段的 enum 顺序一致）。 */
export const VERB_INDEX = [
  { name: "githana_git", commands: ["exec", "commit", "push"] },
  {
    name: "githana_repo",
    commands: ["create", "list", "view", "clone", "fork", "sync", "gitignore", "license", "read-dir", "read-file"],
  },
  {
    name: "githana_pr",
    commands: [
      "create", "list", "view", "status", "diff", "checks", "merge", "review", "comment",
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
