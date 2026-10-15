// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * api：GitHub REST 端点透传（githana_api 的唯一动作，见 spec gh-cli-parity D2）。
 *
 * 与 exec 同构：exec 透传任意 git 子命令，本工具透传任意 GitHub REST 端点。
 * 走自写 REST 通道（tools/lib/rest.js），不经 gh CLI。
 *
 * ## 它是单动词工具，所以没有 action
 *
 * `action` 是分发键，只在动词数 ≥ 2 的工具上声明（D3）；单数时它只是占位（填了等于没填），
 * 删掉。`required` 随之从平表的 `["action"]` 换成真正必填的 `path`——收敛前 `path` 只在
 * run() 里校验，模型面看不见它必填（AC2）。装配走 surface.js 的 createSingleSurface。
 *
 * ## 路径形态
 *
 * `path` 是 api.github.com 之后的路径（带前导斜杠），支持两种形态：
 *   · 账号级：`/user`、`/user/gpg_keys`、`/user/repos`
 *   · 仓库级：`/repos/{owner}/{repo}/issues`——`{owner}` / `{repo}` 是**占位符**，传 repo 时
 *     自动替换；不传 repo 时也可直接写死字面值。
 * 查询串直接拼在 path 里（`/repos/o/r/pulls?state=open`）。
 * `POST /graphql` 同样经这里可达（GraphQL 也是 api.github.com 上的端点，见 D5）。
 *
 * ## method 收全量
 *
 * HTTP method 是可靠的读写判据，但本工具是**逃生门**：只读的长尾查询与越出类型化动词面的写操作
 * 都从这里走，所以不做 method 白名单收窄，收全量（GET / POST / PATCH / PUT / DELETE）。
 * 越过 App 权限面的调用由 GitHub 直接拒（403），错误原文照实回报。
 */
import { z } from "zod";
import { getToolSecretToken, getToolOAuthMeta } from "../lib/context.js";
import { resolveRepo } from "../lib/github.js";
import * as params from "../lib/params.js";
import { request, errorDetail } from "../lib/rest.js";

export const command = "api";
export const summary = "Passthrough for any GitHub REST endpoint (escape hatch)";

export const schema = {
  // 只声明类型：前导斜杠的检查留在 run() 里做——那里先 trim 再判（" /user" 这种带空白的输入
  // 是接受的），把判据挪进 schema 会先在未归一的值上拒掉它，属于静默改语义。
  path: z
    .string()
    .describe(
      "Path after api.github.com (with a leading slash), e.g. \"/user\", \"/repos/{owner}/{repo}/issues\", \"/repos/o/r/pulls?state=open\"",
    ),
  // 取值域写成 enum：本工具只有一个面，没有「另一个面收别的值」这件事要表达，
  // 非法值由参数校验当场拒（不必像收敛前那样留给 run() 好指向另一个面）。
  //
  // 但归一化必须在**进 enum 之前**完成：收敛前 method 由 run() 里的 `String(x).toUpperCase()`
  // 归一，小写 `"post"` 是能用的；直接挂 enum 会把它当成非法值拒掉，这是一处行为回归。
  // `z.preprocess` 正是「先归一、再校验」的形状（它编译成 pipe(input: transform, output: enum)），
  // 于是 `"post"` → `"POST"` 被接受，而 `"TRACE"` / 数字 / null 归一后仍不在 enum 里，
  // 照样被拒——归一化不会放过非法值。
  //
  // 为什么不写成 `z.string().transform(...).pipe(z.enum(...))`：模型面 `parameters` 由
  // `z.toJSONSchema(…, { io: "input" })` 投影，而投影在 `io: "input"` 下**只有当 pipe 的输入侧是
  // transform 时才取输出侧**（见 zod 的 pipeProcessor）。`z.preprocess` 的输入侧恰是 transform，
  // 所以模型面仍看得见 enum 与这段描述；换那种写法会把取值域投影成一个光秃秃的 string。
  method: z
    .preprocess(
      // 只归一字符串（大小写），不做 trim / 不做类型强转：`" POST "` 这种在收敛前也过不了
      // fetch，别在这里悄悄把语义放宽。
      (v) => (typeof v === "string" ? v.toUpperCase() : v),
      z.enum(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]),
    )
    .optional()
    .describe("HTTP method, defaults to GET (case-insensitive); accepts GET / HEAD / POST / PATCH / PUT / DELETE"),
  repo: z.string().optional().describe("Optional: repository owner/repo; when given, the {owner}/{repo} placeholders in path are replaced"),
  body: z.object({}).loose().optional().describe("Optional: request body (JSON object), for POST / PATCH / PUT"),
  paginate: z.boolean().optional().describe("Optional: follow Link pagination and merge array results (max 10 pages)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_api",
  summary:
    "Send any REST (or GraphQL) request to api.github.com: GET is read-only, POST / PATCH / PUT / DELETE modify remote GitHub state — confirm path, method and body before running",
  ruleId: "github-toolkit-api",
};

/** 把 path 里的 {owner}/{repo} 占位符替换成实际值。 */
function applyRepoPlaceholders(pathStr, repo) {
  if (!repo) return pathStr;
  return String(pathStr)
    .replace(/\{owner\}/g, repo.owner)
    .replace(/\{repo\}/g, repo.repo);
}

export async function run(input, ctx, { label }) {
  const rawPath = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (!rawPath) {
    return label + " argument error: path is required (the path after api.github.com, e.g. \"/user\").";
  }
  if (!rawPath.startsWith("/")) {
    return label + " argument error: path must start with / (received: " + rawPath + ").";
  }

  // method 的取值域由 schema 保证（enum，且已在 schema 里先归一大小写）；这里留下的 toUpperCase
  // 只是兜底，走到这儿的值必然已是 enum 里的那一个。
  const method = String(input?.method || "GET").toUpperCase();

  let repo = null;
  const repoRaw = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
  if (repoRaw) {
    const res = resolveRepo(repoRaw);
    if (res.error) return label + " argument error: " + res.error;
    repo = res;
  }

  // body 的"必须是 JSON 对象"由 schema 保证（见上方 schema）；这里只判它与方法的相容性
  // （GET / HEAD / DELETE 不接受 body），那是跨字段的业务约束，不是单字段的形状。
  const body = input?.body !== undefined && input?.body !== null ? input.body : undefined;
  if (body !== undefined && (method === "GET" || method === "HEAD" || method === "DELETE")) {
    return label + " argument error: method=" + method + " does not accept a body (use POST / PATCH / PUT).";
  }

  // 凭据前置检查：只有 OAuth 一条路，没有 keyring 兜底。
  if (!getToolSecretToken()) {
    const meta = getToolOAuthMeta();
    if (meta && meta.needsReauth === true) {
      return label + " reauthorization required: the last token refresh failed (refresh_token expired or the authorization was revoked). Go to the GitHana settings page and click \"Sign in with GitHub\" again.";
    }
    return label + " GitHub App authorization is not complete yet (no OAuth token in this process): go to the GitHana settings page, click \"Sign in with GitHub\", then retry.";
  }

  const path = applyRepoPlaceholders(rawPath, repo);
  const url = "https://api.github.com" + path;
  const timeoutSec = input?.timeoutSec;
  const timeoutMs = (Number(timeoutSec) > 0 ? Number(timeoutSec) : 60) * 1000;

  const req = { method, url, timeoutMs, paginate: input?.paginate === true };
  if (body !== undefined) req.json = body;

  const r = await request(req, { timeoutSec });
  if (r.status === null) {
    // 基础设施失败（worker 缺失 / 网络层 / 白名单拒绝）
    return label + " call failed: " + (r.error || "unknown error");
  }

  const lines = [];
  lines.push(label + " " + method + " " + path + (repo ? " (repo=" + repo.owner + "/" + repo.repo + ")" : ""));
  lines.push("HTTP " + r.status + (r.ok ? " (ok)" : " (failed)") + (r.pages ? " · merged " + r.pages + " pages" : ""));
  if (r.truncated) lines.push("(response body too large, truncated)");
  if (!r.ok) lines.push("error: " + errorDetail(r));
  // 204/304 等无正文响应：json 与 text 都为空，不打印正文行（避免输出孤立的 null）。
  const text = r.json !== null && r.json !== undefined ? JSON.stringify(r.json, null, 2) : String(r.text || "");
  if (text !== "") {
    const MAX = 8000;
    lines.push("");
    lines.push(text.length > MAX ? text.slice(0, MAX) + "\n…(truncated, " + text.length + " chars total)" : text);
  }
  return lines.join("\n");
}
