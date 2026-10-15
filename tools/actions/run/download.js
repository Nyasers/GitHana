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
import { callRest, apiUrl, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { resolveContext, describeFailure } from "../../lib/gh.js";
import { resolveRunId, pickedNote, formatBytes } from "../../lib/ci.js";
import { normalizeAbsolutePath, transferFailureText, safeFileName } from "../../lib/transfer.js";

export const command = "download";
export const summary = "取 run 的日志 / 产物到本地（流式写盘 zip）";

export const schema = {
  repo: params.repo,
  cwd: params.cwdOptional,
  runId: params.runIdOptional,
  branch: z.string().optional().describe("可选：runId 缺省时用它过滤出最近一次 run（缺省取 cwd 的当前分支）"),
  what: z
    .enum(["logs", "artifacts"])
    .optional()
    .describe("可选：取日志（logs，整个 run 打包成一个 zip）还是产物（artifacts）；缺省 logs"),
  artifactName: z.string().optional().describe("可选：what=artifacts 时要取哪个产物（缺省取全部）"),
  path: z.string().optional().describe("可选：目标文件绝对路径（what=logs 时用；与 dir 二选一，path 优先）"),
  dir: z.string().optional().describe("可选：目标目录（缺省 = 本进程 cwd）；落盘文件名取资产/产物名"),
  overwrite: z.boolean().optional().describe("可选：目标文件已存在时是否覆盖（缺省 false：不覆盖，报错让你改名或显式覆盖）"),
  timeoutSec: params.timeoutSec,
};

export const sideEffect = {
  kind: "github_actions",
  summary:
    "读取 GitHub 远端 run 的日志 / 产物并写入本地磁盘（新建本地文件）：不修改远端状态，但会写本地文件，执行前请确认 repo、run 编号与目标路径",
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

  const what = input?.what !== undefined && input?.what !== null ? String(input.what) : "logs";
  const artifactName = input?.artifactName !== undefined && input?.artifactName !== null ? String(input.artifactName).trim() : "";
  const overwrite = input?.overwrite === true;
  const out = [label + "（" + repoLabel + " · run #" + num + " · " + what + "）："];
  if (resolved.picked) out.push("说明：" + pickedNote(resolved.picked, resolved.branch));

  if (what === "logs") {
    const target = targetPathFor(input, "run-" + num + "-logs.zip");
    if (target.error) return label + " 参数错误：" + target.error;

    const r = await callRest(
      [
        {
          id: "logs",
          url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/logs"),
          toFile: target.path,
          overwrite,
          timeoutMs,
        },
      ],
      { timeoutSec },
    );
    if (!r.ok) return label + " 执行失败：" + r.message;
    const res = r.results[0];
    const byCode = transferFailureText(res);
    if (byCode) {
      return [
        label + " 落盘失败 —— " + target.path,
        byCode,
        "日志端点返回一个 zip 字节流，这里要求一个可写目录；显式传 dir 或 path 指到一个能写的地方。",
      ].join("\n");
    }
    if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, repoLabel);

    pushLogResult(out, target.path, res, target.explicit);
    return out.join("\n");
  }

  // what=artifacts：先列清单（纯 JSON），再按名字或全量逐个下。
  const ar = await callRest(
    [{ url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/artifacts") + "?per_page=100", timeoutMs }],
    { timeoutSec },
  );
  if (!ar.ok) return label + " 执行失败：" + ar.message;
  const ares = ar.results[0];
  if (!ares || !ares.ok) return label + " 执行失败：" + describeFailure(ares, repoLabel);

  const body = ares.json && typeof ares.json === "object" ? ares.json : {};
  const all = Array.isArray(body.artifacts) ? body.artifacts : [];
  const items = artifactName ? all.filter((a) => a && String(a.name) === artifactName) : all;

  if (all.length === 0) {
    out.push("这条 run 没有留下产物（0 个）。");
    return out.join("\n");
  }
  if (items.length === 0) {
    out.push("没有名为 " + artifactName + " 的产物（共 " + all.length + " 个）：");
    for (const a of all) out.push("  " + (a.name || "?"));
    return out.join("\n");
  }

  const singlePath = input?.path !== undefined && input?.path !== null && String(input.path).trim() !== "";
  if (singlePath && items.length > 1) {
    return [
      label + " 参数错误：path 只能配一个产物，而这次选中了 " + items.length + " 个。",
      "要么传 artifactName 点名一个，要么改用 dir（每个产物各落在它自己的文件名下）。",
    ].join("\n");
  }

  let done = 0;
  let failed = 0;
  out.push("");
  for (const a of items) {
    const name = a && a.name ? String(a.name) : "";
    if (!name || a.id === undefined || a.id === null) {
      out.push("  ! 一个产物的响应里缺 name 或 id，跳过。");
      failed += 1;
      continue;
    }
    const sizeNote = a.size_in_bytes !== undefined ? "（" + formatBytes(a.size_in_bytes) + "）" : "";
    if (a.expired === true) {
      out.push("  ! " + name + sizeNote + "：**已过期**（GitHub 按仓库设置的保留期删掉了内容），跳过。");
      failed += 1;
      continue;
    }
    const target = targetPathFor(input, name + ".zip");
    if (target.error) {
      out.push("  ! " + name + "：" + target.error);
      failed += 1;
      continue;
    }

    const r = await callRest(
      [
        {
          id: "artifact-" + String(a.id),
          url: apiUrl(repo, "/actions/runs/" + encodeURIComponent(num) + "/artifacts/" + encodeURIComponent(String(a.id)) + "/zip"),
          toFile: target.path,
          overwrite,
          timeoutMs,
        },
      ],
      { timeoutSec },
    );
    if (!r.ok) {
      out.push("  ! " + name + "：执行失败：" + r.message);
      failed += 1;
      continue;
    }
    const res = r.results[0];
    const byCode = transferFailureText(res);
    if (byCode) {
      out.push("  ! " + name + "：落盘失败 —— " + target.path);
      out.push("    " + byCode);
      failed += 1;
      continue;
    }
    if (!res || !res.ok) {
      out.push("  ! " + name + "：GitHub 返回 HTTP " + (res ? res.status : "?") + " —— " + describeFailure(res, repoLabel));
      failed += 1;
      continue;
    }
    out.push("  ✓ " + name + sizeNote + " → " + target.path +
      (res.bytes !== null && res.bytes !== undefined ? "（写入 " + res.bytes + " 字节）" : ""));
    if (target.explicit === false) out.push("     说明：没给 path / dir，落在本进程的当前目录。");
    done += 1;
  }

  out.push("");
  out.push(done === items.length ? "完成：" + done + " 个产物已写盘。" : "完成 " + done + " 个 / 失败 " + failed + " 个（逐条见上）。");
  return out.join("\n");
}

/** 日志那一跳的回执（单独一段：它只有一次请求，不需要逐条排版）。 */
function pushLogResult(out, targetPath, res, explicit) {
  out.push("  ✓ → " + targetPath);
  if (res.bytes !== null && res.bytes !== undefined) out.push("     写入 " + res.bytes + " 字节（" + formatBytes(res.bytes) + "）");
  if (explicit === false) out.push("     说明：没给 path / dir，落在本进程的当前目录。");
  out.push("");
  out.push("这是一个 zip（GitHub 把整个 run 的日志打包成一个字节流，不打 302）。解开它就看到逐作业的日志。");
}
