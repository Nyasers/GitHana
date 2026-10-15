// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/cancel：取消一次进行中的 run（githana_run 动词）。
 *
 * 走 REST `POST /repos/{o}/{r}/actions/runs/{run_id}/cancel`，支撑权限 `actions: write`
 * （D7 已授权）。
 *
 * ## 它不是「删掉」，也不是「立刻停」
 *
 * GitHub 的取消是**尽力而为**的：请求收下后，runner 会收到取消信号，但已经跑起来的步骤可能
 * 还会把当前这一步做完；终态是 `cancelled`。所以回执里写「已请求取消」并接着取一次现状，
 * 不写「已停止」——那句话在取消还没落地时是假的。
 *
 * ## 与 delete 的分界
 *
 * cancel 让 run 停下来（记录还在，状态是 cancelled）；delete 抹掉记录（日志与产物一起没）。
 * 要重跑一次用 rerun。三者的语义各不相同，所以是三个动词而不是一个带 mode 的动词。
 */
import { z } from "zod";
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, runLine } from "../../lib/ci.js";

export const command = "cancel";
export const summary = "Cancel an in-progress run (best effort)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("Optional: used to filter out the most recent run when runId is omitted (defaults to the current branch of cwd)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Cancel an in-progress workflow run on remote GitHub (interrupts running jobs and may leave half-finished deployments / pushes): confirm repo and run number before running",
  ruleId: "github-toolkit-run-cancel",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  const r = await callRest(
    [
      {
        method: "POST",
        url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/cancel"),
        timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000,
      },
    ],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  // 202 Accepted 是成功（取消是异步落地的）。
  if (!res || (!res.ok && res.status !== 202)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 409) {
      return (
        label + ": run #" + num + " is in a state that does not allow cancellation (409). It may **have finished already** —" +
        "a run that has reached a terminal state cannot be cancelled (to run it again use githana_run(action=\"rerun\")).\nGitHub raw message: " + detail
      );
    }
    return label + " execution failed: " + describeFailure(res, repoLabel);
  }

  const out = [
    label + " cancellation requested (" + repoLabel + " · run #" + num + "):",
    "HTTP " + res.status + " (GitHub accepted the cancellation request — it is **best effort**: steps already running may finish the current step, and the terminal state is cancelled)",
  ];
  if (resolved.picked) out.push("note: " + pickedNote(resolved.picked, resolved.branch));

  // 取消是异步落地的：取一次现状，让调用方看到它是不是已经变 cancelled。
  const after = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (after.ok && after.results[0] && after.results[0].ok && after.results[0].json) {
    // 变量名不叫 `run`：它会遮蔽本模块导出的 run()，读起来像递归调用。
    const runJson = after.results[0].json;
    out.push("state right after the request: " + runLine(runJson));
    if (String(runJson.status || "") !== "completed") {
      out.push("note: it is still " + String(runJson.status || "?").toUpperCase() + " at this moment, so the cancellation has not landed yet; check again shortly with githana_run(action=\"view\", runId=" + num + ").");
    }
  }

  out.push("note: cancelling only stops the run (the record remains). To erase the record and logs use githana_run(action=\"delete\"), and to run it again use githana_run(action=\"rerun\").");
  return out.join("\n");
}
