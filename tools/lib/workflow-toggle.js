// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * workflow/enable 与 workflow/disable 的共同实现（githana_workflow 的两个动词）。
 *
 * 走 REST `PUT /repos/{o}/{r}/actions/workflows/{workflow_id}/enable` 与
 * `DELETE .../disable`（都回 **204 No Content**），支撑权限 `actions: write`（D7 已授权）。
 * gh 的 `gh workflow enable` / `disable` 就是这一对。
 *
 * ## 为什么两份实现合成一份
 *
 * 它们的请求形状与回报完全对称，唯一差别是 HTTP 方法、路径段（enable / disable）与几句措辞。
 * 拆成两份文件后那几句措辞会各自漂（一处改了另一处忘了改，是这类对称动词最常见的问题），
 * 所以实现在这一处：actions/workflow/enable.js 与 disable.js 各自只有字段定义（那是真的每个
 * 动词自己的东西），run 都转到这里。
 *
 * ## 启用与「让它跑起来」是两件事
 *
 * 启用只改状态位（`disabled_manually` → `active`）：之后该工作流的**自然触发条件**
 * （push / pull_request / schedule…）恢复生效。要立刻跑一次是 `workflow run`（dispatch），
 * 它**不需要先启用**——停用的工作流也能被 dispatch 触发。停用同理：只挡自然触发，
 * 不挡 dispatch，也不影响已经跑着的 run。
 *
 * ## 为什么 204 之后还要回读一次
 *
 * 204 只说明请求被接受（且端点幂等：已启用的再启用还是 204）。回读一次工作流本体、把 `state`
 * 报出来，调用方才能确认它真的落到预期状态——而不是把「请求成功」当成「状态已改」。
 */
import { callRest, apiUrl, errorDetail, DEFAULT_REST_TIMEOUT_SEC } from "./rest.js";
import { describeFailure } from "./gh.js";
import { workflowStateText, workflowPath } from "./ci.js";

/**
 * 启用 / 停用的共同实现。
 *
 * @param {object} input 工具入参（读 input.workflow）
 * @param {{ repo: string, repoLabel: string, timeoutSec: * }} c resolveContext 的结果
 * @param {string} label 报错前缀（工具名(action)）
 * @param {"enable"|"disable"} mode
 * @returns {Promise<string>}
 */
export async function toggleWorkflow(input, c, label, mode) {
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const isEnable = mode === "enable";

  const wf = input?.workflow !== undefined && input?.workflow !== null ? String(input.workflow).trim() : "";
  if (!wf) return label + " invalid arguments: workflow is required (numeric ID or file name; get it from githana_workflow(action=\"list\")).";
  const path = "/actions/workflows/" + workflowPath(wf);

  const r = await callRest(
    [{ method: isEnable ? "PUT" : "DELETE", url: apiUrl(repo, path + (isEnable ? "/enable" : "/disable")), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " failed: " + r.message;
  const res = r.results[0];
  // 204 No Content 是成功（这一对端点不返回正文）。
  if (!res || (!res.ok && res.status !== 204)) {
    if (res && res.status === 404) {
      return (
        label + " failed: repository " + repoLabel + " has no workflow " + wf + " (both numeric IDs and file names are accepted).\n" +
        "GitHub response: " + errorDetail(res)
      );
    }
    return label + " failed: " + describeFailure(res, repoLabel);
  }

  // 回读一次现状：204 只说明请求被接受，state 才是能被核对的那一面。
  const after = await callRest([{ url: apiUrl(repo, path), timeoutMs }], { timeoutSec });
  const out = [label + " " + (isEnable ? "enabled" : "disabled") + " (" + repoLabel + " · " + wf + "):"];
  const ares = after.ok ? after.results[0] : null;
  if (ares && ares.ok && ares.json && typeof ares.json === "object") {
    const w = ares.json;
    out.push("workflow: " + (w.name || "(unnamed)") + " · path " + (w.path || "?") + " · state " + workflowStateText(w.state));
    const want = isEnable ? "active" : "disabled_manually";
    if (String(w.state || "") !== want) {
      out.push(
        "note: the request returned success (204), but the state read back is " + workflowStateText(w.state) + ", not the expected " +
        (isEnable ? "enabled (active)" : "disabled (disabled_manually)") + " — treat this read-back value as authoritative.",
      );
    }
    if (w.html_url) out.push("URL: " + w.html_url);
  } else {
    out.push(
      "(the request returned 204 success, but reading the workflow state back failed — " + (after.ok ? "result unavailable" : after.message) +
      "; verify with githana_workflow(action=\"view\").)",
    );
  }
  out.push(
    isEnable
      ? "note: enabling only flips the state bit — afterwards the workflow's natural triggers (push / pull_request / schedule…) take effect again. To run it once right away use githana_workflow(action=\"run\")."
      : "note: after disabling, its **natural triggers** (push / pull_request / schedule…) no longer start it, but workflow_dispatch (githana_workflow(action=\"run\")) can still trigger it manually; runs already in flight are unaffected.",
  );
  return out.join("\n");
}
