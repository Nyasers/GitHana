// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/delete：删除一条 run 记录（githana_run 动词，不可撤销）。
 *
 * 走 REST `DELETE /repos/{o}/{r}/actions/runs/{run_id}`，支撑权限 `actions: write`（D7 已授权）。
 *
 * ## 删掉的是什么
 *
 * 一条 run 记录连带它的**日志与产物**（GitHub 文档：Delete a workflow run；日志与 artifacts 一同
 * 消失）。删了之后那个 commit 的检查记录也不再指向任何东西——所以本动词要 `confirm=true`，
 * 与 issue/release 的删除同一档。
 *
 * ## 与 cancel 的分界
 *
 * cancel 让 run 停下来（记录还在，状态 cancelled）；delete 抹掉记录。所以 cancel 一个进行中的
 * run 是合法的（先停再删也行），而 delete 一个还在跑的 run 会连它的进行中状态一起消失——
 * 那是另一个动词要管的事，本动词不代劳（不隐式先 cancel）。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { runLine } from "../../lib/ci.js";

export const command = "delete";
export const summary = "Delete a run record (irreversible, requires confirm=true)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runId.describe("Required: the run number to delete (this verb offers no \"most recent\" default — an irreversible action does not get a dangerous default)"),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually delete: deleting a run makes its logs and artifacts disappear with it; without it you get guidance instead"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "**Delete** a workflow run record on remote GitHub (its logs and artifacts disappear with it; irreversible): confirm repo and run number again before running",
  ruleId: "github-toolkit-run-delete",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  // 运行期必填由 schema 保证（runId 是必填项，没有 optional）；这里只做归一。
  const num = String(input.runId);

  // 先取一次 run 本体：确认它存在，并让回执里有东西可写（删掉之后就查不到了）。
  const before = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (!before.ok) return label + " execution failed: " + before.message;
  const bres = before.results[0];
  if (!bres || !bres.ok) {
    if (bres && bres.status === 404) return label + ": run #" + num + " does not exist or is not visible (" + repoLabel + ").";
    return label + " execution failed: " + describeFailure(bres, repoLabel);
  }
  // 变量名不叫 `run`：它会遮蔽本模块导出的 run()（函数体作用域 vs 模块作用域），读起来像
  // 递归调用——改名省掉这份误会。
  const runJson = bres.json && typeof bres.json === "object" ? bres.json : {};

  if (input?.confirm !== true) {
    const out = [
      label + " confirmation required (nothing deleted yet):",
      "Will delete run: " + runLine(runJson) + " (" + repoLabel + ")",
    ];
    if (runJson.status && String(runJson.status) !== "completed") {
      out.push("note: this run is **still running** (" + String(runJson.status).toUpperCase() + "). To stop it use githana_run(action=\"cancel\"); deleting an in-progress run makes its state and logs disappear together.");
    }
    out.push("Deletion is **irreversible**: the run record disappears together with its **logs and artifacts**, and the check record for that commit no longer points at anything.");
    out.push("To merely stop it (keeping the record) use githana_run(action=\"cancel\"); to run it again use githana_run(action=\"rerun\").");
    out.push("To confirm, resend the same call with confirm=true.");
    return out.join("\n");
  }

  const r = await callRest(
    [
      {
        method: "DELETE",
        url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " execution failed: " + describeFailure(res, repoLabel);

  return [
    label + " deleted (" + repoLabel + "):",
    "run: " + runLine(runJson),
    "note: the record disappears together with its logs and artifacts (irreversible). To run the same one again use githana_run(action=\"rerun\") — but that requires an existing run (the one deleted here will not come back on its own).",
  ].join("\n");
}
