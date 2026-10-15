// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/issue.js — githana_issue 各动词共用的编号解析与渲染。
 *
 * 跨名词共用（仓库上下文、失败说明、时间渲染）在 tools/lib/gh.js；这里只放 **issue 专有**的
 * 部分：issue 本体读取、状态/标签渲染、PR 混入的识别。每个动词自己那份请求编排留在
 * tools/actions/issue/<verb>.js。
 *
 * ## PR 与 issue 是同一层，但要分清
 *
 * GitHub 上 PR 就是一种 issue（时间线、标签、评论、锁定都在 issues 这层），`GET /issues` 默认
 * **两种都返回**。所以：
 *   · `issue list` 默认只报 issue（`pull_request` 键为空的是 issue），要连 PR 一起看传 `includePrs=true`；
 *   · `issue view / edit / ...` 收到一个 PR 编号时会**如实说明**「这是 PR，不是 issue」，并指向
 *     githana_pr——不假装成功、也不静默按 issue 处理。
 */
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";
import { describeFailure } from "./gh.js";

/**
 * 取 issue 本体；顺带判出它其实是 PR 的情况。
 *
 * @returns {{ error: string } | { issue: object, isPullRequest: boolean, numStr: string }}
 */
export async function fetchIssue(repo, repoLabel, numStr, timeoutSec) {
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const r = await callRest(
    [{ id: "issue", url: apiUrl(repo, "/issues/" + numStr), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return { error: " failed: " + r.message };
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return { error: ": #" + numStr + " does not exist or is not visible (" + repoLabel + ")." };
    }
    return { error: " failed: " + describeFailure(res, repoLabel) };
  }
  const issue = res.json && typeof res.json === "object" ? res.json : {};
  return { issue, isPullRequest: !!(issue.pull_request && issue.pull_request.url), numStr };
}

/**
 * 收到的是 PR 时的统一引导（不假装它是 issue）。
 *
 * 默认指向 githana_pr——多数动词（view / edit / comment / close / lock …）在那边有对应物。
 * 但 `pin` / `unpin` / `delete` / `transfer` / `develop` 在 githana_pr 上**没有**对应动词
 * （PR 的这几个操作不在本 App 的类型化面上），所以那些动词用 `instead` 给出真实去向，
 * 而不是指一个不存在的用法。
 *
 * @param {object} [issue] 取到的那份表示（只用来拿 URL）
 * @param {string} [instead] 覆盖默认指路的整句（如「PR 的固定不在工具面上…」）
 */
export function notAnIssueMessage(label, numStr, repoLabel, issue, instead) {
  const url = issue && issue.html_url ? issue.html_url : "";
  return (
    label + ": #" + numStr + " is a **Pull Request**, not an issue (on GitHub, PRs and issues share one number space).\n" +
    (instead || "to operate on it, use githana_pr(action=\"view\", prNumber=" + numStr + ").") +
    (url ? "\nURL: " + url : "")
  );
}

/** issue 状态渲染（state / state_reason / 锁定）。 */
export function issueStateText(issue) {
  const state = String((issue && issue.state) || "?").toUpperCase();
  const reason = issue && issue.state_reason ? " (" + issue.state_reason + ")" : "";
  const locked = issue && issue.locked ? " · locked (locked)" : "";
  return state + reason + locked;
}

/** 标签渲染：`name` 列表；空数组返回 ""（调用方自己决定怎么显示"无标签"）。 */
export function labelText(issue) {
  const arr = issue && Array.isArray(issue.labels) ? issue.labels : [];
  return arr
    .map((l) => (l && typeof l === "object" ? String(l.name || "") : String(l || "")))
    .filter(Boolean)
    .join(" · ");
}

/** 指派人渲染。 */
export function assigneeText(issue) {
  const arr = issue && Array.isArray(issue.assignees) ? issue.assignees : [];
  return arr.map((u) => (u && u.login ? "@" + u.login : "?")).join(" · ");
}
