// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * api：GitHub REST 端点透传（两个面都有的 action）。
 *
 * 与 exec 同构：exec 透传任意 git 子命令，本 action 透传任意 GitHub REST 端点。
 * 走自写 REST 通道（tools/lib/rest.js），不经 gh CLI。
 *
 * ## 路径形态
 *
 * `path` 是 api.github.com 之后的路径（带前导斜杠），支持两种形态：
 *   · 账号级：`/user`、`/user/gpg_keys`、`/user/repos`
 *   · 仓库级：`/repos/{owner}/{repo}/issues`——`{owner}` / `{repo}` 是**占位符**，传 repo 时
 *     自动替换；不传 repo 时也可直接写死字面值。
 * 查询串直接拼在 path 里（`/repos/o/r/pulls?state=open`）。
 *
 * ## 两个面的 method 白名单不同（见 spec D7）
 *
 * HTTP method 是可靠的读写判据，GET / HEAD 按语义是安全动词，所以**只读面**收下它们，
 * 让长尾只读查询（issue 列表、release 列表、仓库元数据）不必每次过审。写面则维持收敛前
 * github_api 的集合（GET / POST / PATCH / PUT / DELETE）。
 * 白名单由 options.allowMethods 传入，本文件不判断自己在哪个面。
 */
import { z } from "zod";
import { getToolSecretToken, getToolOAuthMeta } from "../lib/context.js";
import { resolveRepo } from "../lib/github.js";
import * as params from "../lib/params.js";
import { request, errorDetail } from "../lib/rest.js";

export const command = "api";
export const summary = "任意 GitHub REST 端点透传";

export const schema = {
  // 只声明类型：前导斜杠的检查留在 run() 里做——那里先 trim 再判（" /user" 这种带空白的输入
  // 收敛前是接受的），把判据挪进 schema 会先在未归一的值上拒掉它，属于静默改语义。
  path: z
    .string()
    .describe(
      "api.github.com 之后的路径（带前导斜杠），如 \"/user\"、\"/repos/{owner}/{repo}/issues\"、\"/repos/o/r/pulls?state=open\"",
    ),
  // 本 action 同时挂在两个面上，而**两面的 method 白名单不同**（见 spec D7）：只读面只收
  // GET / HEAD，写面收全量方法。所以这里只声明"是个字符串"，取值域留给 run() 的 allowMethods
  // 判——那条拒绝要指向另一个面（边界条件点名的引导），写成 enum 会被参数校验的 issues 抢先，
  // 丢掉那句指向。模型面那两个取值域由各面的 modelFields 描述（见 tools/githana*.js）。
  method: z.string().optional().describe("HTTP 方法，缺省 GET；本面的取值域见工具描述"),
  repo: z.string().optional().describe("可选：仓库 owner/repo；传了就替换 path 里的 {owner}/{repo} 占位符"),
  body: z.object({}).loose().optional().describe("可选：请求体（JSON 对象），用于 POST / PATCH / PUT"),
  paginate: z.boolean().optional().describe("可选：跟随 Link 分页把数组结果合并（上限 10 页）"),
  timeoutSec: params.timeoutSec,
};

/** 把 path 里的 {owner}/{repo} 占位符替换成实际值。 */
function applyRepoPlaceholders(pathStr, repo) {
  if (!repo) return pathStr;
  return String(pathStr)
    .replace(/\{owner\}/g, repo.owner)
    .replace(/\{repo\}/g, repo.repo);
}

export async function run(input, ctx, { label, allowMethods, writeFaceName }) {
  const allowed = Array.isArray(allowMethods) && allowMethods.length ? allowMethods : ["GET", "POST", "PATCH", "PUT", "DELETE"];

  const rawPath = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (!rawPath) {
    return label + " 参数错误：path 必填（api.github.com 之后的路径，如 \"/user\"）。";
  }
  if (!rawPath.startsWith("/")) {
    return label + " 参数错误：path 必须以 / 开头（收到：" + rawPath + "）。";
  }

  const method = String(input?.method || "GET").toUpperCase();
  if (!allowed.includes(method)) {
    // 只读面的拒绝要指向写面（这是边界条件里点名的引导）；写面维持收敛前的枚举报错。
    const isReadFace = !allowed.includes("POST");
    if (isReadFace) {
      return (
        label + " 参数错误：method 只能是 " + allowed.join(" / ") +
        "（收到：" + method + "）。写操作请改用 " + (writeFaceName || "githana") + "(action=\"api\")。"
      );
    }
    return label + " 参数错误：method 必须是 " + allowed.join(" / ") + "（收到：" + method + "）。";
  }

  let repo = null;
  const repoRaw = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
  if (repoRaw) {
    const res = resolveRepo(repoRaw);
    if (res.error) return label + " 参数错误：" + res.error;
    repo = res;
  }

  // body 的"必须是 JSON 对象"由 schema 保证（见上方 schema）；这里只判它与方法的相容性
  // （GET / HEAD / DELETE 不接受 body），那是跨字段的业务约束，不是单字段的形状。
  const body = input?.body !== undefined && input?.body !== null ? input.body : undefined;
  if (body !== undefined && (method === "GET" || method === "HEAD" || method === "DELETE")) {
    return label + " 参数错误：method=" + method + " 不接受 body（用 POST / PATCH / PUT）。";
  }

  // 凭据前置检查：只有 OAuth 一条路，没有 keyring 兜底。
  if (!getToolSecretToken()) {
    const meta = getToolOAuthMeta();
    if (meta && meta.needsReauth === true) {
      return label + " 需要重新授权：上次令牌刷新失败（refresh_token 已失效或授权被撤销），请到 GitHana 设置页重新点「用 GitHub 登录」。";
    }
    return label + " 尚未完成 GitHub App 授权（进程内没有 OAuth 令牌）：请到 GitHana 设置页点「用 GitHub 登录」后重试。";
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
    return label + " 调用失败：" + (r.error || "未知错误");
  }

  const lines = [];
  lines.push(label + " " + method + " " + path + (repo ? "（repo=" + repo.owner + "/" + repo.repo + "）" : ""));
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