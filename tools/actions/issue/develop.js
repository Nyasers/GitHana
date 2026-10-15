// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * issue/develop：从 issue 开一条开发分支并关联到它（githana_issue 动词）。
 *
 * ## 实现选择：GraphQL `createLinkedBranch`
 *
 * gh `issue develop` 做两件事：在远端建一条以 issue 命名的分支，并把它**关联**到该 issue
 * （issue 侧边栏出现 "Development" 条目）。关联这一步只有 GraphQL 能做
 * （`createLinkedBranch` 变更；REST 的 `POST /git/refs` 只建引用，不建立关联）。所以本动词
 * 走 lib/graphql.js，支撑权限 `contents: write`（建分支）+ `issues: write`（关联），两者都已授权。
 *
 * **不开 PR**：gh 的 `issue develop` 只建分支不建 PR，本动词同。要开 PR 请分支推上去之后
 * `githana_pr(action="create")`——把两件事合成一次调用会让"分支建了但 PR 没开成"变成半途状态。
 *
 * **不在本地建分支**：gh 的 `issue develop --checkout` 还会把分支取到本地。这里只做远端那一步——
 * 本地那份请接着 `githana_repo(action="clone")` 或 `githana_pr(action="checkout")`，
 * 否则「远端建了但本地没取到」会变成一次调用里的半途状态，混在一次审批里看不清。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { fetchIssue, notAnIssueMessage } from "../../lib/issue.js";
import { graphql } from "../../lib/graphql.js";

export const command = "develop";
export const summary = "从 issue 建关联开发分支";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  issueNumber: params.issueNumber,
  name: z.string().optional().describe("可选：分支名（缺省 <编号>-<标题的短横线形式>，与 gh issue develop 同口径）"),
  base: z.string().optional().describe("可选：从哪个分支拉（缺省取仓库默认分支）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_issue",
  summary:
    "在 GitHub 远端从 issue 建一条开发分支并把它关联到该 issue（issue 侧边栏出现 Development 条目；不改本地仓库）：修改 GitHub 远端状态，执行前请确认 repo 与编号",
  ruleId: "github-toolkit-issue-develop",
};

/** issue 标题 → 分支名的 slug（与 gh issue develop 的口径一致：小写、非字母数字转连字符）。 */
export function branchSlug(number, title) {
  const t = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return t ? number + "-" + t : String(number);
}

/**
 * 拼 `createLinkedBranch` 的变更文档。
 *
 * 起点用本地已经取到的 `oid`（分支 SHA）给出——它比 `repositoryId` 更准，而且拿到了就一定给。
 * `repositoryId` 只在能拿到时才带上：GraphQL 里声明成 `ID!` 的变量**必须**随请求给出，
 * 声明了却在 variables 里缺席会得到 "Variable $repoId of required type ID! was not provided"
 * ——一条与真实原因无关的报错。所以按手上有什么拼哪一份文档，而不是固定声明全部变量。
 */
function developMutation(withRepoId) {
  const args = ["issueId: $issueId", "name: $name", "oid: $oid"];
  const decls = ["$issueId: ID!", "$name: String!", "$oid: GitObjectID"];
  if (withRepoId) {
    args.push("repositoryId: $repoId");
    decls.push("$repoId: ID!");
  }
  return [
    "mutation(" + decls.join(", ") + ") {",
    "  createLinkedBranch(input: { " + args.join(", ") + " }) {",
    "    linkedBranch { ref { name } }",
    "  }",
    "}",
  ].join("\n");
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const numStr = String(input.issueNumber);
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const cur = await fetchIssue(repo, repoLabel, numStr, timeoutSec);
  if (cur.error) return label + cur.error;
  if (cur.isPullRequest) {
    return notAnIssueMessage(
      label,
      numStr,
      repoLabel,
      cur.issue,
      "PR 已经有自己的源分支（不必再从它开分支）；要把它取到本地用 githana_pr(action=\"checkout\", prNumber=" +
        numStr + ")。",
    );
  }

  const issue = cur.issue;
  const issueNodeId = issue.node_id ? String(issue.node_id) : "";
  if (!issueNodeId) return label + "：issue #" + numStr + " 的响应里没有 node_id，无法走 GraphQL 建关联分支。";

  // 分支名：缺省按 gh 的口径从标题生成；显式给的照用（合法性交给 GitHub 判，原文回报）。
  const name =
    input?.name !== undefined && input?.name !== null && String(input.name).trim() !== ""
      ? String(input.name).trim()
      : branchSlug(numStr, issue.title);

  // 仓库本体取一次：默认分支（base 的缺省值）与 node_id（GraphQL 的 repositoryId）都在它里面，
  // 分两次请求没有信息增益。
  const repoR = await callRest([{ url: apiUrl(repo, ""), timeoutMs }], { timeoutSec });
  if (!repoR.ok) return label + " 执行失败：" + repoR.message;
  const rres = repoR.results[0];
  if (!rres || !rres.ok) return label + " 执行失败：" + describeFailure(rres, repoLabel);
  const repoJson = rres.json && typeof rres.json === "object" ? rres.json : {};
  const repoNodeId = repoJson.node_id ? String(repoJson.node_id) : "";

  // 起点：base 给了就取它的 SHA；没给取默认分支的 SHA。
  let base = input?.base !== undefined && input?.base !== null ? String(input.base).trim() : "";
  if (!base) {
    base = repoJson.default_branch ? String(repoJson.default_branch) : "";
    if (!base) return label + "：无法确定仓库默认分支（响应里没有 default_branch），请显式传 base。";
  }

  const refR = await callRest(
    [{ url: apiUrl(repo, "/git/ref/heads/" + base.split("/").map(encodeURIComponent).join("/")), timeoutMs }],
    { timeoutSec },
  );
  if (!refR.ok) return label + " 执行失败：" + refR.message;
  const refRes = refR.results[0];
  if (!refRes || !refRes.ok) {
    return label + " 执行失败：取不到分支 " + base + " 的引用。" + describeFailure(refRes, repoLabel);
  }
  const oid = refRes.json && refRes.json.object && refRes.json.object.sha ? String(refRes.json.object.sha) : "";
  if (!oid) return label + "：分支 " + base + " 的引用响应里没有 object.sha，无法确定起点。";

  // 起点用 oid（拿得到就一定用它，比 repositoryId 更准）；repositoryId 拿得到就一并带上。
  // 变量集必须与文档形态**逐字对齐**：`developMutation` 声明了 `$repoId: ID!` 就一定要在这里给出
  // 值，否则 GraphQL 报 "Variable $repoId of required type ID! was not provided"（见上方注释）；
  // 反过来，仓库没有 node_id 时文档里不声明它，这里也就**不能**多传一个未声明的键。
  const variables = { issueId: issueNodeId, name, oid };
  if (repoNodeId) variables.repoId = repoNodeId;
  const g = await graphql(developMutation(!!repoNodeId), variables, { timeoutSec });
  if (g.error) {
    // 分支已存在是这条路上最常见的失败：GitHub 报 "already exists"，单独给引导。
    if (/already exists/i.test(g.error)) {
      return (
        label + " 执行失败：分支 " + name + " 已经存在（GitHub 报 already exists）。\n" +
        "换一个 name，或直接用它继续开发（githana_pr(action=\"checkout\") / githana_git(action=\"exec\", args=[\"checkout\", \"" + name + "\"])）。\n" +
        "GitHub 原文：" + g.error
      );
    }
    if (/could not resolve to a node|not found/i.test(g.error) && !repoNodeId) {
      return (
        label + " 执行失败：" + g.error + "\n" +
        "提示：createLinkedBranch 需要 repositoryId（仓库的 node_id），而取它时失败了。可用 githana_api(path=\"/repos/" + repo + "\") 核对 node_id 是否可读。"
      );
    }
    return label + " 执行失败：" + g.error;
  }
  const created =
    g.data && g.data.createLinkedBranch && g.data.createLinkedBranch.linkedBranch && g.data.createLinkedBranch.linkedBranch.ref
      ? String(g.data.createLinkedBranch.linkedBranch.ref.name)
      : name;

  return [
    label + " 完成（issue #" + numStr + " · " + repoLabel + "）：",
    "分支：" + created + "（起点 " + base + " · " + oid.slice(0, 7) + "）",
    "关联：已记到 issue #" + numStr + " 的 Development 条目上（GraphQL createLinkedBranch）。",
    "说明：不在本地建分支、也不开 PR。要本地那份接着 githana_repo(action=\"clone\")，",
    "要在已有克隆里取这条分支：githana_git(action=\"exec\", cwd=\"<仓库>\", args=[\"fetch\", \"origin\", \"" + created + "\"])。",
  ].join("\n");
}
