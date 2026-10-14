// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/view：看一个工作流（githana_workflow 动词）。
 *
 * 走 REST `GET /repos/{o}/{r}/actions/workflows/{workflow_id}`（工作流本体的定义：
 * name / path / state / 触发分支 / 时间戳 / URL）。支撑权限 `actions: write`（D7 已授权）。
 *
 * ## 不取 YAML 正文
 *
 * 「看工作流」有两种意思：看它的**定义**（name / path / state…，本动词做的），与看它的
 * **YAML 文件内容**（那是仓库里的一个文件，走 `githana_repo(action="read-file",
 * path=".github/workflows/ci.yml")`）。两件事的取数端点不同（后者是 contents 端点，
 * 支撑权限是 `contents: read`），所以不在这里合并——合了会把「看 CI 配置」变成一次
 * 依赖两个权限的调用。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure, fmtTime } from "../../lib/gh.js";
import { workflowStateText, workflowPath } from "../../lib/ci.js";

export const command = "view";
export const summary = "看一个工作流（定义，不含 YAML 正文）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  workflow: params.workflowRef,
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const wf = input?.workflow !== undefined && input?.workflow !== null ? String(input.workflow).trim() : "";
  if (!wf) return label + " 参数错误：workflow 必填（数字 ID 或文件名，从 githana_workflow(action=\"list\") 取）。";

  const r = await callRest(
    [
      {
        url: apiUrl(repo, "/actions/workflows/" + workflowPath(wf)),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return (
        label + "：仓库 " + repoLabel + " 里没有工作流 " + wf + "（数字 ID 与文件名都认）。\n" +
        "用 githana_workflow(action=\"list\") 看这个仓库有哪些。"
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const w = res.json && typeof res.json === "object" ? res.json : {};
  const out = [];
  out.push("工作流：" + (w.name || "（无名）"));
  out.push("仓库：" + repoLabel + " · 状态 " + workflowStateText(w.state));
  out.push("ID：" + (w.id !== undefined ? w.id : "?") + " · 路径：" + (w.path || "?"));
  if (w.created_at) out.push("创建于：" + fmtTime(w.created_at) + (w.updated_at ? " · 更新于 " + fmtTime(w.updated_at) : ""));
  if (w.html_url) out.push("URL：" + w.html_url);
  if (w.badge_url) out.push("徽标：" + w.badge_url);

  out.push("");
  out.push("说明：这是工作流的**定义**（状态与路径），不含 YAML 正文。");
  out.push("要看 YAML 内容：githana_repo(action=\"read-file\", repo=\"" + repo + "\", path=\"" + (w.path || ".github/workflows/<文件名>") + "\")——那是 `contents: read` 那条权限，与这里不同。");
  out.push("要看它跑过什么：githana_run(action=\"list\", repo=\"" + repo + "\", workflow=\"" + (w.id !== undefined ? w.id : wf) + "\")。");
  return out.join("\n");
}
