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
export const summary = "取消一次进行中的 run（尽力而为）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("可选：runId 缺省时用它过滤出最近一次 run（缺省取 cwd 的当前分支）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "取消 GitHub 远端正进行中的 workflow run（会中断正在跑的作业，可能留下半完成的部署 / 推送）：执行前请确认 repo 与 run 编号",
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 202 Accepted 是成功（取消是异步落地的）。
  if (!res || (!res.ok && res.status !== 202)) {
    const detail = errorDetail(res);
    const st = res && res.status;
    if (st === 409) {
      return (
        label + "：run #" + num + " 当前状态不允许取消（409）。它可能**已经跑完**了——" +
        "已经到终态的 run 不能取消（要重跑用 githana_run(action=\"rerun\")）。\nGitHub 原文：" + detail
      );
    }
    return label + " 执行失败：" + describeFailure(res, repoLabel);
  }

  const out = [
    label + " 已请求取消（" + repoLabel + " · run #" + num + "）：",
    "HTTP " + res.status + "（GitHub 收下了取消请求——它是**尽力而为**：跑起来的步骤可能把当前这一步做完，终态是 cancelled）",
  ];
  if (resolved.picked) out.push("说明：" + pickedNote(resolved.picked, resolved.branch));

  // 取消是异步落地的：取一次现状，让调用方看到它是不是已经变 cancelled。
  const after = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num)), timeoutMs: (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000 }],
    { timeoutSec },
  );
  if (after.ok && after.results[0] && after.results[0].ok && after.results[0].json) {
    // 变量名不叫 `run`：它会遮蔽本模块导出的 run()，读起来像递归调用。
    const runJson = after.results[0].json;
    out.push("请求后的现状：" + runLine(runJson));
    if (String(runJson.status || "") !== "completed") {
      out.push("说明：此刻标识仍是 " + String(runJson.status || "?").toUpperCase() + "，取消还没落地；隔一会儿用 githana_run(action=\"view\", runId=" + num + ") 再看。");
    }
  }

  out.push("说明：取消只让 run 停下来（记录还在）。要抹掉记录与日志用 githana_run(action=\"delete\")，要重跑用 githana_run(action=\"rerun\")。");
  return out.join("\n");
}
