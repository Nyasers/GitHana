// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * run/download：取 run 的日志或产物到本地。
 *
 * ## 两条路的落地方式不同，都走二进制通道
 *
 *   · **日志**（`what=logs`）：`GET /repos/{o}/{r}/actions/runs/{run_id}/logs` **不打 302**——
 *     GitHub 直接返回一个 ZIP 的字节流（`application/zip`，`Content-Disposition` 里带文件名），
 *     就在 api.github.com 上。落盘文件名用 `run-<id>-logs.zip`：**不用** Content-Disposition 那个
 *     名字——写盘路径要在发请求之前定下来（那是 spawn 参数里要放行的目录），而那个头得等响应到
 *     才有。要别的名字就传 path / dir。
 *   · **产物**（`what=artifacts`）：`GET .../artifacts/{artifact_id}/zip` 会 302 到
 *     `*.blob.core.windows.net`（Azure 存储，子域是存储账号名）。worker 用后缀白名单放行这一档
 *     ——精确 `Set` 列不全这种子域（见 rest.worker.mjs 的 REDIRECT_HOST_SUFFIXES）。
 *
 * 两条都由 worker 流式写盘（`toFile`）：ZIP 从第 4 个字节起就不是合法 UTF-8，按文本读回来只会
 * 得到一串被改写过的字符——所以这里一个字节都不经过 `toString("utf8")`。
 *
 * ## 先列清单再取，是为了让「取哪个」有据可依
 *
 * `what=artifacts` 不给 `artifactName` 时会先列一次清单（纯 JSON，完全可用）：产物有 id、名字、
 * 体积与过没过期。取全部产物是**多个请求**（每个产物一个 zip），所以这里逐个下、逐个报，
 * 一个失败不影响其余。
 *
 * ## 无可写目录时不猜
 *
 * 落点由 `path`（完整文件路径）或 `dir`（目录，文件名取资产/产物名）给；都不给就落到本进程 cwd。
 * App 进程的 cwd 未必在 worker 的可写范围里，所以那种失败会明确报出来并请调用方显式给 `dir`。
 */
import path from "node:path";
import { z } from "zod";
import { apiUrl, callRest, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import { taskCapabilityError } from "../../lib/tasks.js";
import { startTransferTask, makeRestTransfer } from "../../lib/transfer-task.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, formatBytes } from "../../lib/ci.js";
import { normalizeAbsolutePath, safeFileName } from "../../lib/transfer.js";

export const command = "download";
export const summary = "Fetch a run's logs / artifacts to the local disk (streamed zip write)";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("Optional: used to filter out the most recent run when runId is omitted (defaults to the current branch of cwd)"),
  what: z
    .enum(["logs", "artifacts"])
    .optional()
    .describe("Optional: fetch logs (logs — the whole run packed into one zip) or artifacts (artifacts); defaults to logs"),
  artifactName: z.string().optional().describe("Optional: which artifact to fetch when what=artifacts (defaults to all)"),
  path: z.string().optional().describe("Optional: absolute path of the target file (used when what=logs; mutually exclusive with dir, path wins)"),
  dir: z.string().optional().describe("Optional: target directory (default = this process's cwd); the file name on disk is taken from the asset/artifact name"),
  overwrite: z.boolean().optional().describe("Optional: whether to overwrite an existing target file (default false: do not overwrite; the error tells you to pick another name or overwrite explicitly)"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "Read a remote GitHub run's logs / artifacts and write them to the local disk (creates local files): does not modify remote state, but writes local files — confirm repo, run number and target path before running",
  ruleId: "github-toolkit-run-download",
};

/**
 * 组落点：path 优先；否则 dir（或 cwd）+ 建议文件名。
 *
 * 日志那一跳现在给的是固定名（`run-<id>-logs.zip`），产物那一跳给的是 `<产物名>.zip`——后者是
 * 远端来的字符串，落盘文件名要收成安全的一段（见 transfer.js 的 safeFileName）。
 */
function targetPathFor(input, suggestedName) {
  const p = input?.path !== undefined && input?.path !== null ? String(input.path).trim() : "";
  if (p) {
    const norm = normalizeAbsolutePath(p, "path");
    return norm.error ? { error: norm.error } : { path: norm.path, explicit: true };
  }
  const safe = safeFileName(suggestedName, "run-download.zip");
  const d = input?.dir !== undefined && input?.dir !== null ? String(input.dir).trim() : "";
  if (d) {
    const norm = normalizeAbsolutePath(d, "dir");
    if (norm.error) return { error: norm.error };
    return { path: path.join(norm.path, safe), explicit: true };
  }
  return { path: path.resolve(process.cwd(), safe), explicit: false };
}

export async function run(input, ctx, { label }) {
  const c = await resolveContext(input, label);
  if (c.error) return c.error;
  const { repo, repoLabel, timeoutSec } = c;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;

  const resolved = await resolveRunId(input, c, label);
  if (resolved.error) return resolved.error;
  const num = resolved.runId;

  const callToken = input && input.context && input.context.callToken ? String(input.context.callToken) : "";
  if (!callToken) {
    return (
      label + " cannot start: this call did not carry the host-injected callToken (which binds the background task to the source session).\n" +
      "This verb downloads in the background so the tool callback does not hit its 30s limit; without a token the result has no session to come back to."
    );
  }
  const capErr = taskCapabilityError(label);
  if (capErr) return capErr;

  const what = input?.what !== undefined && input?.what !== null ? String(input.what) : "logs";
  const artifactName = input?.artifactName !== undefined && input?.artifactName !== null ? String(input.artifactName).trim() : "";
  const overwrite = input?.overwrite === true;
  const out = [label + " (" + repoLabel + " · run #" + num + " · " + what + "):"];
  if (resolved.picked) out.push("note: " + pickedNote(resolved.picked, resolved.branch));

  if (what === "logs") {
    const target = targetPathFor(input, "run-" + num + "-logs.zip");
    if (target.error) return label + " argument error: " + target.error;

    const started = await startTransferTask(input, {
      label: label + " logs #" + num,
      callToken,
      repo,
      repoLabel,
      scenario: "run #" + num + " · logs",
      items: [
        {
          name: "run-" + num + "-logs.zip",
          target: target.path,
          run: makeRestTransfer({
            id: "logs",
            url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/logs"),
            target: target.path,
            overwrite,
            timeoutSec,
          }),
        },
      ],
      overwrite,
      timeoutSec,
      meta: { verb: "run.download", what: "logs", runId: num },
      describeResult: (r) =>
        r && r.ok
          ? [
              label + " logs (" + repoLabel + " · run #" + num + "):",
              "  ✓ → " + target.path + (r.bytes !== null && r.bytes !== undefined ? " (" + r.bytes + " bytes written)" : ""),
              "",
              "This is a zip (GitHub packs the whole run's logs into one byte stream, with no 302). Unpack it to see the per-job logs.",
            ].join("\n")
          : label + " logs write failed: " + (r ? r.message : "not attempted"),
    });
    if (started.error) return label + " execution failed: " + started.error;

    return [
      label + " logs download started (" + repoLabel + " · run #" + num + ") — **it does not wait for the zip to land**; this call ends here:",
      "handle: taskId " + started.taskId + " (host background task; delivery=" + String(started.record && started.record.delivery ? started.record.delivery : "next-step") + ")",
      "target: " + target.path,
      "",
      "where the conclusion goes: the host posts the result back to **this session**'s next input point when the transfer settles.",
      "to stop it midway: cancel it from this session's background task item — a transfer already in flight runs to completion.",
    ].join("\n");
  }

  // what=artifacts：先列清单（纯 JSON），再按名字或全量逐个下。
  const ar = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/artifacts") + "?per_page=100", timeoutMs }],
    { timeoutSec },
  );
  if (!ar.ok) return label + " execution failed: " + ar.message;
  const ares = ar.results[0];
  if (!ares || !ares.ok) return label + " execution failed: " + describeFailure(ares, repoLabel);

  const body = ares.json && typeof ares.json === "object" ? ares.json : {};
  const all = Array.isArray(body.artifacts) ? body.artifacts : [];
  const items = artifactName ? all.filter((a) => a && String(a.name) === artifactName) : all;

  if (all.length === 0) {
    out.push("this run left no artifacts (0).");
    return out.join("\n");
  }
  if (items.length === 0) {
    out.push("no artifact named " + artifactName + " (" + all.length + " in total):");
    for (const a of all) out.push("  " + (a.name || "?"));
    return out.join("\n");
  }

  const singlePath = input?.path !== undefined && input?.path !== null && String(input.path).trim() !== "";
  if (singlePath && items.length > 1) {
    return [
      label + " argument error: path can only go with a single artifact, but this selection contains " + items.length + ".",
      "Either name one with artifactName, or switch to dir (each artifact then lands under its own file name).",
    ].join("\n");
  }

  // 目标集先收成任务项（纯本地计算 + 已拿到的清单，耗时可忽略），再把字节那段交给后台。
  const transferItems = [];
  const skipped = [];
  for (const a of items) {
    const name = a && a.name ? String(a.name) : "";
    if (!name || a.id === undefined || a.id === null) {
      skipped.push("  ! an artifact's response is missing name or id; skipping.");
      continue;
    }
    const sizeNote = a.size_in_bytes !== undefined ? " (" + formatBytes(a.size_in_bytes) + ")" : "";
    if (a.expired === true) {
      skipped.push(
        "  ! " + name + sizeNote + ": **expired** (GitHub deleted the content under the repository's retention setting); skipping.",
      );
      continue;
    }
    const target = targetPathFor(input, name + ".zip");
    if (target.error) {
      skipped.push("  ! " + name + ": " + target.error);
      continue;
    }
    transferItems.push({
      name: name + sizeNote,
      target: target.path,
      run: makeRestTransfer({
        id: "artifact-" + String(a.id),
        url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/artifacts/" + encodeURIComponent(String(a.id)) + "/zip"),
        target: target.path,
        overwrite,
        timeoutSec,
      }),
    });
  }

  if (transferItems.length === 0) {
    out.push("");
    out.push(...skipped);
    out.push("nothing to download.");
    return out.join("\n");
  }

  const started = await startTransferTask(input, {
    label: label + " artifacts #" + num,
    callToken,
    repo,
    repoLabel,
    scenario: "run #" + num + " · artifacts",
    items: transferItems,
    overwrite,
    timeoutSec,
    meta: { verb: "run.download", what: "artifacts", runId: num },
  });
  if (started.error) return label + " execution failed: " + started.error;

  out.push(label + " artifact download started (" + repoLabel + " · run #" + num + ") — **it does not wait for the bytes to land**; this call ends here:");
  out.push("handle: taskId " + started.taskId + " (host background task; delivery=" + String(started.record && started.record.delivery ? started.record.delivery : "next-step") + ")");
  out.push("targets: " + transferItems.length);
  for (const it of transferItems) out.push("  · " + it.name + " → " + it.target);
  if (skipped.length) {
    out.push("");
    out.push("skipped (not handed to the background task):");
    out.push(...skipped);
  }
  out.push("");
  out.push("where the conclusion goes: the host posts the result back to **this session**'s next input point when every artifact settles.");
  out.push("to stop it midway: cancel it from this session's background task item — remaining artifacts are skipped.");
  return out.join("\n");
}
