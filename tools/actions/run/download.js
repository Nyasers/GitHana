// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/download：取 run 的日志或产物到本地。
 *
 * ## 与 upload / release download 同一档：入 enum，但网络那一半不可用
 *
 * 三条硬限制见 tools/lib/transfer.js。这里值得补一条**这一族特有的**现状：
 * `GET /repos/{o}/{r}/actions/runs/{run_id}/logs` **不分 302**——GitHub 直接返回一个 ZIP 的
 * 字节流（`application/zip`，Content-Disposition 里带文件名）。这意味着它连「跳到白名单外的域」
 * 那一关都不过（它在 api.github.com 上），却仍然过不了第三条：worker 的 readBounded 上限 2MB
 * 且把字节 `toString("utf8")` —— ZIP 从第 4 个字节起就不是合法 UTF-8，取回来的是一个被改写过的
 * 字符串，长度还可能被截断。
 *
 * 产物（artifacts）那条路更早断：`GET .../artifacts/{artifact_id}/zip` 会 302 到
 * `*.blob.core.windows.net`（不在 REDIRECT_HOSTS），起跳即被拒。
 *
 * ## 为什么入 enum
 *
 * 与 release 的 upload / download 同一理由（见 actions/release/upload.js 头注的那段分辨）：
 * 参数形态是清楚的（runId + 要日志还是要产物 + 产物名），只是本期跑不通。入候选的好处是
 * 调用时能拿到**具体**的限制与替代路径——包括先把这条 run 的产物清单列出来（那是纯 JSON，
 * 完全可用），让人知道有什么可取。
 *
 * ## 做什么 / 不做什么
 *
 * 起点（定位 run）与「列产物清单」都是真的可用的：`GET .../artifacts` 返回的是 JSON，
 * 不受三条限制影响。所以本动词的回报不是一句「做不到」，而是**清单 + 地址 + 三条限制 + 替代做法**。
 */
import { z } from "zod";
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, formatBytes } from "../../lib/ci.js";
import { binaryUnavailableText } from "../../lib/transfer.js";

export const command = "download";
export const summary = "取 run 的日志 / 产物（本期只列清单与地址：二进制通道不存在）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("可选：runId 缺省时用它过滤出最近一次 run（缺省取 cwd 的当前分支）"),
  what: z
    .enum(["logs", "artifacts"])
    .optional()
    .describe("可选：取日志（logs，整个 run 打包成一个 zip）还是产物（artifacts）；缺省 logs"),
  artifactName: z.string().optional().describe("可选：what=artifacts 时要取哪个产物（缺省列出全部）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "读取 GitHub 远端 run 的日志 / 产物清单与地址（本期不写本地磁盘）：不修改远端状态，执行前请确认 repo 与 run 编号",
  ruleId: "github-toolkit-run-download",
};

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  const what = input?.what !== undefined && input?.what !== null ? String(input.what) : "logs";
  const artifactName = input?.artifactName !== undefined && input.artifactName !== null ? String(input.artifactName).trim() : "";
  const out = [label + " 未写盘（本期不下载二进制）：" + repoLabel + " · run #" + num + " · " + what];
  if (resolved.picked) out.push("说明：" + pickedNote(resolved.picked, input?.branch));

  if (what === "logs") {
    // 日志端点在这里是**纯地址**：不请求它（请求了也是一个被 UTF-8 破坏的体）。
    out.push("");
    out.push("日志地址：GET /repos/" + repo + "/actions/runs/" + num + "/logs（返回整个 run 的 zip 字节流，Content-Disposition 带文件名）");
    out.push("这一条不打 302（字节直出），所以卡住它的只有第三条硬限制：");
  } else {
    // 产物清单是 JSON，完全可用——先把它列出来（这是本动词真正交付的那一部分）。
    const ar = await callRest(
      [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/artifacts") + "?per_page=100", timeoutMs }],
      { timeoutSec },
    );
    if (!ar.ok) return label + " 执行失败：" + ar.message;
    const ares = ar.results[0];
    if (!ares || !ares.ok) return label + " 执行失败：" + describeFailure(ares, repoLabel);

    const body = ares.json && typeof ares.json === "object" ? ares.json : {};
    const all = Array.isArray(body.artifacts) ? body.artifacts : [];
    const nameWanted = artifactName;
    const items = nameWanted ? all.filter((a) => a && String(a.name) === nameWanted) : all;

    out.push("");
    if (all.length === 0) {
      out.push("产物（0 个）：这条 run 没有留下产物。");
    } else if (items.length === 0) {
      out.push("产物（0 个匹配 " + nameWanted + " / 共 " + all.length + " 个）：");
      for (const a of all) out.push("  " + (a.name || "?"));
    } else {
      out.push("产物（" + items.length + " 个" + (nameWanted ? "匹配 " + nameWanted + " / 共 " + all.length : "") + "）：");
      for (const a of items) {
        out.push(
          "  " + (a.name || "?") +
          (a.size_in_bytes !== undefined ? "  " + formatBytes(a.size_in_bytes) : "") +
          (a.expired === true ? "  [已过期]" : "") +
          (a.id !== undefined ? "  id " + a.id : ""),
        );
        if (a.id !== undefined) {
          out.push("      地址：GET /repos/" + repo + "/actions/runs/" + num + "/artifacts/" + a.id + "/zip（会 302 到 *.blob.core.windows.net）");
        }
      }
    }
    if (items.length === 1 && items[0] && items[0].expired === true) {
      out.push("说明：这个产物**已过期**（GitHub 按仓库设置的保留期删除内容），地址会取不到内容。");
    }
    out.push("");
    out.push("这一族卡在两处：");
  }

  out.push(binaryUnavailableText());
  out.push("本期可行的替代做法：");
  if (what === "logs") {
    out.push("  · gh run view " + num + " --log --repo " + repoLabel + "（外部二进制，不受上述限制）；");
  } else {
    out.push("  · gh run download " + num + " --repo " + repoLabel + (artifactName ? " --name \"" + artifactName + "\"" : "") + "（外部二进制，不受上述限制）；");
  }
  out.push("  · 或在浏览器里打开 run 页面（" + (resolved.picked && resolved.picked.html_url ? resolved.picked.html_url : "https://github.com/" + repo + "/actions/runs/" + num) + "）逐条看日志 / 下载产物。");
  out.push("githana_api 不是逃生门：它走同一条 worker、同一份主机白名单，响应体同样按 UTF-8 有界截断读取。");
  return out.join("\n");
}
