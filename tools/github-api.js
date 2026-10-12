// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * github_api：GitHub REST 端点透传工具（v2 透传层根，GitHub 域）。
 *
 * 与 git_exec 同构：git_exec 透传任意 git 子命令，本工具透传任意 GitHub REST 端点。
 * 走自写 REST 通道（tools/lib/rest.js），不经 gh CLI。
 *
 * ## 它是 gh_exec 的后继，但语义收窄了一层
 *
 * gh_exec 透传的是 gh 的**子命令**（`gh release create`、`gh issue list`…），那些是 CLI 的
 * 高层动词；本工具透传的是 **REST 端点**（`/repos/{o}/{r}/releases`、`/repos/{o}/{r}/issues`…）。
 * 多数高层动词都能由端点组合出来，但组合工作从 CLI 移到了调用方。这是真实的能力面变化，
 * 不是等价的换皮。
 *
 * ## 路径形态
 *
 * `path` 是 api.github.com 之后的路径（带前导斜杠），支持两种形态：
 *   · 账号级：`/user`、`/user/gpg_keys`、`/user/repos`
 *   · 仓库级：`/repos/{owner}/{repo}/issues`——`{owner}` / `{repo}` 是**占位符**，传 repo 时
 *     自动替换；不传 repo 时也可直接写死字面值。
 * 查询串直接拼在 path 里（`/repos/o/r/pulls?state=open`）。
 */
import { initToolContext, getToolSecretToken, getToolOAuthMeta } from "./lib/context.js";
import { resolveRepo } from "./lib/github.js";
import { request, errorDetail } from "./lib/rest.js";

export const name = "github_api";

export const description = [
  "GitHub REST 端点透传工具（base，GitHub 域）：按 path 直接调用 api.github.com 的任意端点。",
  "path 是 api.github.com 之后的路径，如 \"/user\"、\"/repos/{owner}/{repo}/issues\"、",
  "\"/repos/o/r/pulls?state=open\"；传 repo（owner/repo）时替换路径里的 {owner}/{repo} 占位符。",
  "method 缺省 GET；body（JSON 对象）用于 POST/PATCH/PUT。paginate=true 时跟随分页合并数组。",
  "PR 生命周期请用 gh_pr（action 子模块，create/list/view/merge）；issue/release/仓库管理等长尾操作经此透传。",
  "timeoutSec 可选（默认 60 秒，上限 600 秒）。本工具可能创建/修改 GitHub 远端状态，执行前请确认参数。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "github_api",
    summary:
      "调用任意 GitHub REST 端点（自写 REST 通道，带本 App 的 OAuth 令牌）：method 非 GET 时可能创建/修改 GitHub 远端状态（issue/PR/release/仓库设置等，视端点而定），执行前请确认 path/method/body",
    ruleId: "github-toolkit-github-api",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "api.github.com 之后的路径（带前导斜杠），如 \"/user\"、\"/repos/{owner}/{repo}/issues\"、\"/repos/o/r/pulls?state=open\"",
    },
    method: {
      type: "string",
      enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      description: "HTTP 方法，缺省 GET",
    },
    repo: {
      type: "string",
      description: "可选：仓库 owner/repo；传了就替换 path 里的 {owner}/{repo} 占位符",
    },
    body: {
      type: "object",
      description: "可选：请求体（JSON 对象），用于 POST / PATCH / PUT",
    },
    paginate: {
      type: "boolean",
      description: "可选：跟随 Link 分页把数组结果合并（上限 10 页）",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 60，上限 600",
    },
  },
  required: ["path"],
};

/** 把 path 里的 {owner}/{repo} 占位符替换成实际值。 */
function applyRepoPlaceholders(pathStr, repo) {
  if (!repo) return pathStr;
  return String(pathStr)
    .replace(/\{owner\}/g, repo.owner)
    .replace(/\{repo\}/g, repo.repo);
}

export async function execute(input, ctx) {
  await initToolContext(ctx);

  const rawPath = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (!rawPath) {
    return "github_api 参数错误：path 必填（api.github.com 之后的路径，如 \"/user\"）。";
  }
  if (!rawPath.startsWith("/")) {
    return "github_api 参数错误：path 必须以 / 开头（收到：" + rawPath + "）。";
  }

  const method = String(input?.method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    return "github_api 参数错误：method 必须是 GET / POST / PATCH / PUT / DELETE（收到：" + method + "）。";
  }

  let repo = null;
  const repoRaw = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
  if (repoRaw) {
    const res = resolveRepo(repoRaw);
    if (res.error) return "github_api 参数错误：" + res.error;
    repo = res;
  }

  const body = input?.body !== undefined && input?.body !== null ? input.body : undefined;
  if (body !== undefined && (typeof body !== "object" || Array.isArray(body))) {
    return "github_api 参数错误：body 必须是 JSON 对象（收到：" + typeof body + "）。";
  }
  if (body !== undefined && (method === "GET" || method === "DELETE")) {
    return "github_api 参数错误：method=" + method + " 不接受 body（用 POST / PATCH / PUT）。";
  }

  // 凭据前置检查：去 gh 之后没有 keyring 兜底，只有 OAuth 一条路。
  if (!getToolSecretToken()) {
    const meta = getToolOAuthMeta();
    if (meta && meta.needsReauth === true) {
      return "github_api 需要重新授权：上次令牌刷新失败（refresh_token 已失效或授权被撤销），请到 GitHana 设置页重新点「用 GitHub 登录」。";
    }
    return "github_api 尚未完成 GitHub App 授权（进程内没有 OAuth 令牌）：请到 GitHana 设置页点「用 GitHub 登录」后重试。";
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
    return "github_api 调用失败：" + (r.error || "未知错误");
  }

  const lines = [];
  lines.push("github_api " + method + " " + path + (repo ? "（repo=" + repo.owner + "/" + repo.repo + "）" : ""));
  lines.push("HTTP " + r.status + (r.ok ? "（成功）" : "（失败）") + (r.pages ? " · 合并 " + r.pages + " 页" : ""));
  if (r.truncated) lines.push("（响应体过大，已截断）");
  if (!r.ok) lines.push("错误：" + errorDetail(r));
  // 204/304 等无正文响应：json 与 text 都为空，不打印正文行（避免输出孤立的 null）。
  const text = r.json !== null && r.json !== undefined ? JSON.stringify(r.json, null, 2) : String(r.text || "");
  if (text !== "") {
    const MAX = 8000;
    lines.push("");
    lines.push(text.length > MAX ? text.slice(0, MAX) + "\n…（截断，共 " + text.length + " 字符）" : text);
  }
  return lines.join("\n");
}
