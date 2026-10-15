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
export const summary = "删除一条 run 记录（不可撤销，需 confirm=true）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runId.describe("必填：要删的 run 编号（本动词不给「最近一个」的缺省——不可撤销的动作不吃危险默认值）"),
  confirm: z
    .boolean()
    .optional()
    .describe("必须为 true 才真删：删除 run 会连带它的日志与产物一起消失，缺它会返回引导"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "**删除** GitHub 远端的 workflow run 记录（日志与产物一起消失，不可撤销）：执行前请再次确认 repo 与 run 编号",
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
  if (!before.ok) return label + " 执行失败：" + before.message;
  const bres = before.results[0];
  if (!bres || !bres.ok) {
    if (bres && bres.status === 404) return label + "：run #" + num + " 不存在或不可见（" + repoLabel + "）。";
    return label + " 执行失败：" + describeFailure(bres, repoLabel);
  }
  // 变量名不叫 `run`：它会遮蔽本模块导出的 run()（函数体作用域 vs 模块作用域），读起来像
  // 递归调用——改名省掉这份误会。
  const runJson = bres.json && typeof bres.json === "object" ? bres.json : {};

  if (input?.confirm !== true) {
    const out = [
      label + " 需要确认（未执行删除）：",
      "将删除 run：" + runLine(runJson) + "（" + repoLabel + "）",
    ];
    if (runJson.status && String(runJson.status) !== "completed") {
      out.push("注意：这个 run **还在跑**（" + String(runJson.status).toUpperCase() + "）。要停它用 githana_run(action=\"cancel\")；删掉进行中的 run 会让它的状态与日志一起消失。");
    }
    out.push("删除**不可撤销**：run 记录连带**日志与产物**一起消失，那个 commit 的检查记录也不再指向任何东西。");
    out.push("只想让它停下来（记录保留）用 githana_run(action=\"cancel\")；想重跑用 githana_run(action=\"rerun\")。");
    out.push("确认后请重发同一次调用并带上 confirm=true。");
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
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（删除不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) return label + " 执行失败：" + describeFailure(res, repoLabel);

  return [
    label + " 已删除（" + repoLabel + "）：",
    "run：" + runLine(runJson),
    "说明：记录与它的日志、产物一起消失（不可撤销）。要重跑同一条用 githana_run(action=\"rerun\")——但那要先有 run（删掉的这条不会自己回来）。",
  ].join("\n");
}
