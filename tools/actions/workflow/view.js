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
export const summary = "View a workflow (its definition, without the YAML body)";

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
  if (!wf) return label + " argument error: workflow is required (a numeric ID or a file name, get it from githana_workflow(action=\"list\")).";

  const r = await callRest(
    [
      {
        url: apiUrl(repo, "/actions/workflows/" + workflowPath(wf)),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return (
        label + ": repository " + repoLabel + " has no workflow " + wf + " (both numeric IDs and file names are accepted).\n" +
        "Use githana_workflow(action=\"list\") to see what this repository has."
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const w = res.json && typeof res.json === "object" ? res.json : {};
  const out = [];
  out.push("workflow: " + (w.name || "(unnamed)"));
  out.push("repository: " + repoLabel + " · state " + workflowStateText(w.state));
  out.push("ID: " + (w.id !== undefined ? w.id : "?") + " · path: " + (w.path || "?"));
  if (w.created_at) out.push("created: " + fmtTime(w.created_at) + (w.updated_at ? " · updated " + fmtTime(w.updated_at) : ""));
  if (w.html_url) out.push("URL: " + w.html_url);
  if (w.badge_url) out.push("badge: " + w.badge_url);

  out.push("");
  out.push("note: this is the workflow's **definition** (state and path), not the YAML body.");
  out.push("To see the YAML content: githana_repo(action=\"read-file\", repo=\"" + repo + "\", path=\"" + (w.path || ".github/workflows/<file name>") + "\") — that is the `contents: read` permission, different from this one.");
  out.push("To see what it has run: githana_run(action=\"list\", repo=\"" + repo + "\", workflow=\"" + (w.id !== undefined ? w.id : wf) + "\").");
  return out.join("\n");
}
