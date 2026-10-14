// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/create：在**当前登录账号**下新建仓库（githana_repo 动词）。
 *
 * 走 REST `POST /user/repos`，支撑权限 `repository_creation: write`（D7 的已授权集里）。
 * gh `repo create` 的 `--org` 形态**不在本动词上**：`POST /orgs/{org}/repos` 要 `administration`
 * （未授权，见 D7），声明了就是一次注定 403 的调用；缺口登记在手册里。
 *
 * `gitignore` / `license` 两个参数直接透传给该端点的 `gitignore_template` / `license_template`，
 * 一次请求完成——它们是 gh `repo create --gitignore/--license` 的对应物，也是 `repo` 的
 * gitignore / license 两个查名动词的消费者。GitHub 要求带模板时必须 `auto_init`，所以给了模板
 * 就自动开 autoInit（不静默改语义：输出里写明）。
 */
import { z } from "zod";
import { callRest, apiRoot, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { requireAuth, describeFailure } from "../../lib/gh.js";
import { repoSummary } from "../../lib/repo.js";

export const command = "create";
export const summary = "新建仓库（当前账号下）";

export const schema = {
  name: z.string().describe("仓库名（不含 owner；如 my-repo）"),
  description: z.string().optional().describe("可选：仓库简介"),
  private: z.boolean().optional().describe("可选：true 建私有仓库（默认 false = 公开）"),
  homepage: z.string().optional().describe("可选：仓库主页 URL"),
  autoInit: z.boolean().optional().describe("可选：true 建一个带初始提交（README）的仓库；给了 gitignore / license 时自动开启"),
  gitignore: z.string().optional().describe("可选：按名字套用一个 .gitignore 模板（名字见 githana_repo(action=\"gitignore\") 的列表）"),
  license: z.string().optional().describe("可选：按 key 套用一个许可证模板（key 见 githana_repo(action=\"license\") 的列表，如 mit）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_repo",
  summary:
    "在 GitHub 当前登录账号下新建一个仓库（公开或私有；可能同时写入初始提交 / .gitignore / 许可证）：修改 GitHub 远端状态且新建的仓库默认公开可见，执行前请确认 name 与 private",
  ruleId: "github-toolkit-repo-create",
};

export async function run(input, ctx, { label }) {
  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " 参数错误：name 必填（仓库名，不含 owner）。";
  if (name.includes("/")) {
    return label + " 参数错误：name 只写仓库名，不带 owner（收到：" + name + "）。新建的仓库归当前登录账号所有。";
  }

  const gitignore = input?.gitignore !== undefined && input?.gitignore !== null ? String(input.gitignore).trim() : "";
  const license = input?.license !== undefined && input?.license !== null ? String(input.license).trim() : "";

  // 新建的仓库还不存在，所以这里没有仓库上下文可解析（repo / cwd 对本动词无意义）：
  // 只做凭据前置检查，口径与其它动词一致（只有 OAuth 一条路，没有 keyring 兜底）。
  const authErr = requireAuth(label);
  if (authErr) return authErr;

  // 模板要求 auto_init：把这条平台约束补上（不是改语义，是把 GitHub 的必填替调用方补好并说明）。
  const needsAutoInit = gitignore !== "" || license !== "";
  const autoInit = input?.autoInit === true || needsAutoInit;

  const payload = { name, auto_init: autoInit };
  if (input?.description !== undefined && input?.description !== null) payload.description = String(input.description);
  if (input?.homepage !== undefined && input?.homepage !== null) payload.homepage = String(input.homepage);
  if (input?.private === true) payload.private = true;
  if (gitignore !== "") payload.gitignore_template = gitignore;
  if (license !== "") payload.license_template = license;

  const r = await callRest(
    [{ method: "POST", url: apiRoot("/user/repos"), json: payload, timeoutMs: (input?.timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec: input?.timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " 执行失败：GitHub 拒绝这次创建（422）。常见原因：同名仓库已存在、name 含非法字符、\n" +
        "或 gitignore / license 的模板名不存在（先用 githana_repo(action=\"gitignore\") / (action=\"license\") 查可用名）。\n" +
        "GitHub 原文：" + errorDetail(res)
      );
    }
    if (res && res.status === 403) {
      return (
        label + " 执行失败：没有建仓库的权限（403）——本 App 靠 repository_creation: write 建仓库，\n" +
        "且只能建在当前登录账号下（组织下建仓库要 administration，本 App 未授权）。\nGitHub 原文：" + errorDetail(res)
      );
    }
    return label + " 执行失败：" + describeFailure(res, "");
  }

  const out = [label + " 完成："];
  out.push(...repoSummary(res.json));
  if (needsAutoInit && input?.autoInit !== true) {
    out.push("说明：给了 gitignore / license，已自动带 auto_init=true（GitHub 要求模板与初始提交同时给）。");
  }
  if (gitignore !== "") out.push("gitignore 模板：" + gitignore);
  if (license !== "") out.push("license 模板：" + license);
  out.push("下一步：githana_repo(action=\"clone\", repo=\"" + ((res.json && res.json.full_name) || name) + "\", cwd=\"<父目录>\") 取到本地。");
  return out.join("\n");
}
