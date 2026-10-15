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
export const summary = "Create a repository (under the current account)";

export const schema = {
  name: z.string().describe("Repository name (without owner; e.g. my-repo)"),
  description: z.string().optional().describe("Optional: repository description"),
  private: z.boolean().optional().describe("Optional: true creates a private repository (default false = public)"),
  homepage: z.string().optional().describe("Optional: repository home page URL"),
  autoInit: z.boolean().optional().describe("Optional: true creates a repository with an initial commit (README); it is turned on automatically when gitignore / license is given"),
  gitignore: z.string().optional().describe("Optional: apply a .gitignore template by name (see the list from githana_repo(action=\"gitignore\"))"),
  license: z.string().optional().describe("Optional: apply a license template by key (see the list from githana_repo(action=\"license\"), e.g. mit)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_repo",
  summary:
    "Create a repository under the current GitHub login account (public or private; may also write an initial commit / .gitignore / license): modifies remote GitHub state and the repository it creates is publicly visible by default — confirm name and private before running",
  ruleId: "github-toolkit-repo-create",
};

export async function run(input, ctx, { label }) {
  const name = input?.name !== undefined && input?.name !== null ? String(input.name).trim() : "";
  if (!name) return label + " argument error: name is required (the repository name, without owner).";
  if (name.includes("/")) {
    return label + " argument error: name must be just the repository name without an owner (received: " + name + "). A newly created repository belongs to the current login account.";
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
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 422) {
      return (
        label + " execution failed: GitHub rejected this creation (422). Common causes: a same-named repository already exists, name contains invalid characters,\n" +
        "or the gitignore / license template name does not exist (look up available names first with githana_repo(action=\"gitignore\") / (action=\"license\")).\n" +
        "GitHub raw message: " + errorDetail(res)
      );
    }
    if (res && res.status === 403) {
      return (
        label + " execution failed: no permission to create a repository (403) — this App creates repositories via repository_creation: write,\n" +
        "and can only create them under the current login account (creating one under an organization needs administration, which this App is not authorized for).\nGitHub raw message: " + errorDetail(res)
      );
    }
    return label + " execution failed: " + describeFailure(res, "");
  }

  const out = [label + " done:"];
  out.push(...repoSummary(res.json));
  if (needsAutoInit && input?.autoInit !== true) {
    out.push("note: gitignore / license was given, so auto_init=true was added automatically (GitHub requires a template and an initial commit together).");
  }
  if (gitignore !== "") out.push("gitignore template: " + gitignore);
  if (license !== "") out.push("license template: " + license);
  out.push("next step: githana_repo(action=\"clone\", repo=\"" + ((res.json && res.json.full_name) || name) + "\", cwd=\"<parent directory>\") to get it locally.");
  return out.join("\n");
}
