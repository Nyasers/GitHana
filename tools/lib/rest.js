// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/rest.js — GitHub REST 通道（App 侧）。
 *
 * ## 形状
 *
 * 本模块是「调用 REST」的唯一入口，与 exec.js 之于 git 子进程同构。它负责：
 *   · 定位并 spawn REST worker（tools/lib/rest.worker.mjs，随包进 bin/）；
 *   · **显式补 `--allow-net`**（见下）；
 *   · 把一批请求交给 worker、把结果归一成 { ok, status, json, text, error }；
 *   · 统一超时与基础设施错误的可读文案。
 *
 * 语义都在调用方（tools/actions/*.js、lib/oauth.js、lib/gpg-publish.js）：本模块不认识
 * GitHub 的路径与字段，只负责把请求发出去、把响应拿回来。
 *
 * ## 为什么 spawn 时要补 --allow-net
 *
 * AppHost 子进程开了 Node Permission Model（宿主按清单能力给 `--permission` 与
 * `--allow-child-process`），而 Node 26 的 `--permission` 会经 **NODE_OPTIONS 传染给子进程**：
 * 我们 spawn 的 worker 一启动就带着权限模型，进程内 fetch 的 DNS 解析被拒（实测
 * `getaddrinfo ERR_ACCESS_DENIED api.github.com`）。清掉 NODE_OPTIONS 无效——父进程里
 * `--permission` 已生效，旗标随环境传下去是运行时行为。
 *
 * gh CLI 之所以能联网，是因为它是外部二进制、不在 Node 权限模型的账本上。换成我们自己的
 * node 脚本，就必须在 spawn 参数里显式开 `--allow-net`。这不是新增清单能力（清单仍只有
 * `app/process.spawn`），是运行时层面的旗标。
 *
 * 收窄出站主机在 worker 内做（`--allow-net=<host>` 的语法在 v26.8.1 不生效，实测
 * `--allow-net=api.github.com` 下请求 example.com 仍成功），见 rest.worker.mjs。
 *
 * **`--allow-net` 是有条件的**：它是权限模型下的放行项，单独给会报 `ERR_MISSING_OPTION`
 * （实测：普通 node 进程加 `--allow-net` 直接启动失败）。所以只在 `process.permission` 存在时
 * 才带上它——那个对象只在 `--permission` 生效时才有，正是「本进程在权限模型下」的现成判据。
 * 源码树里跑（无权限模型）不加，装机后跑（AppHost）才加。
 *
 * ## 二进制通道要读本地文件 / 写本地文件，放行项按请求现算
 *
 * worker 是我们 spawn 的，所以宿主的许可根不约束它——但那不等于它能自由读写：权限模型下没放行的
 * 路径一样读不到。所以 spawn 之前扫一遍本批请求里点名的路径（`file` 是读、`toFile` 是写），
 * 按**目录**补 `--allow-fs-read=<dir>` / `--allow-fs-write=<dir>`。
 *
 * 放行粒度是目录而不是文件：node 的这两个旗标只收目录（给文件路径不生效）。于是「传 / 收哪个
 * 文件」这件事只有调用方说了算，我们只是把它指名的那个目录开一道门——不猜、不扩大（不会去放行
 * 盘根）。同一批里要读写的路径各自成项，重复目录只补一次。
 *
 * 这两个旗标与 `--allow-net` 一样，**只在权限模型下合法**（单独给报 `ERR_MISSING_OPTION`），
 * 所以与它同进同退，不由本次请求是否含路径决定。
 *
 * 令牌不经这条路径：worker 的 stdin 里有 token，而 argv 里只有本地目录（可能出现在进程列表里，
 * 但那不是秘密——它是调用方自己给的文件路径）。
 *
 * ## 为什么每次调用 spawn 一次
 *
 * worker 是无状态 HTTP 执行体：一次工具调用的全部请求打包成数组交给它，它顺序执行、
 * 返回结果数组。长驻进程要背生命周期收尾（App 卸载/重载/崩溃重启），而它没有需要保留的
 * 状态，收益抵不上那份复杂度（gpg-agent 的收尾麻烦是现成的教训）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot } from "./bin.js";
import { getToolSecretToken } from "./context.js";

/** worker 单次调用的缺省超时（秒）：一次工具调用可能含多个请求，留出余量。 */
export const DEFAULT_REST_TIMEOUT_SEC = 60;

/**
 * 给 OAuth 端点的固定占位令牌。
 *
 * `github.com/login/*` 两个端点不校验 Authorization，但对空值的响应形态不一致；给一个非空
 * 常量让请求走通。它是常量、不是凭据，所以「真令牌送到非 API 端点」这个风险仍然被挡住。
 */
export const INERT_REST_TOKEN = "hana-githana-rest-placeholder";

/** worker 的候选位置：交付树（bin/）优先，源码树（tools/lib/）兜底。 */
function workerCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = [path.join(pluginRoot(), "bin", "rest.worker.mjs")];
  const src = path.join(here, "rest.worker.mjs");
  if (!out.includes(src)) out.push(src);
  return out;
}

/** 定位 worker 文件；找不到返回 null（调用方给可读错误，不抛裸异常）。 */
export function resolveRestWorker() {
  for (const p of workerCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 许可根外或路径不可读：试下一个候选 */
    }
  }
  return null;
}

/** 归一化超时（秒）：非法/缺省回落 DEFAULT_REST_TIMEOUT_SEC，下限 1 秒。 */
function normalizeTimeoutSec(timeoutSec) {
  if (timeoutSec === undefined || timeoutSec === null || timeoutSec === "") return DEFAULT_REST_TIMEOUT_SEC;
  const n = Number(timeoutSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REST_TIMEOUT_SEC;
  return Math.max(1, Math.floor(n));
}

/** 单条结果的缺省形状（worker 的字段缺失时补空）。 */
function normalizeResult(r, index) {
  const o = r && typeof r === "object" ? r : {};
  return {
    id: o.id === undefined ? index : o.id,
    ok: o.ok === true,
    status: typeof o.status === "number" ? o.status : null,
    json: o.json === undefined ? null : o.json,
    text: typeof o.text === "string" ? o.text : "",
    truncated: o.truncated === true,
    pages: typeof o.pages === "number" ? o.pages : undefined,
    link: o.link || null,
    error: typeof o.error === "string" ? o.error : null,
    // 二进制通道的两组字段：`bytes` 是写盘写进去的字节数（下载侧），`code`/`size` 是失败时的
    // 可判据（file_unreadable / file_too_large / target_exists / target_unwritable…），
    // 调用方据它拼可读文案而不是去解析英文错误串；`sha256` 是上传时顺带算的本地摘要。
    bytes: typeof o.bytes === "number" ? o.bytes : null,
    code: typeof o.code === "string" ? o.code : null,
    size: typeof o.size === "number" ? o.size : null,
    sha256: typeof o.sha256 === "string" ? o.sha256 : null,
  };
}

/**
 * 从一批请求里收集要放行的本地目录。
 *
 * `file` 是**读**（上传时 worker 要读它）、`toFile` 是**写**（下载时 worker 要写它）。
 * 两条都只取所在**目录**：node 的 `--allow-fs-read/write` 只收目录，给文件路径不生效。
 *
 * @param {Array<object>} list 请求数组
 * @returns {{ read: string[], write: string[] }}
 */
function collectFsGrants(list) {
  const read = new Set();
  const write = new Set();
  for (const req of list) {
    if (!req || typeof req !== "object") continue;
    if (typeof req.file === "string" && req.file !== "") {
      const dir = path.dirname(path.resolve(req.file));
      if (dir) read.add(dir);
    }
    if (typeof req.toFile === "string" && req.toFile !== "") {
      const dir = path.dirname(path.resolve(req.toFile));
      if (dir) write.add(dir);
    }
  }
  return { read: [...read], write: [...write] };
}

/**
 * 执行一批 REST 请求。
 *
 * @param {Array<{ id?: string|number, method?: string, url: string, headers?: object,
 *   json?: any, form?: object, body?: string, file?: string, contentType?: string,
 *   maxFileBytes?: number, toFile?: string, overwrite?: boolean,
 *   auth?: boolean, timeoutMs?: number, paginate?: boolean, maxPages?: number }>} requests
 *   `file` 是**二进制请求体**（本地绝对路径，worker 流式读它、原样发出去，带显式
 *   Content-Length）；`toFile` 是**二进制响应体**（本地绝对路径，worker 流式写它，不按 UTF-8
 *   解码）。两者与 json / form / body 互斥，且会触发对相应目录的 spawn 放行（见 collectFsGrants）。
 * @param {{ token?: string, timeoutSec?: number }} [options]
 *   token 缺省取进程内缓存（DPAPI 解密结果）；显式传 "" 表示不带凭据（OAuth 端点的占位值
 *   由调用方传固定常量，不走这里）。
 * @returns {Promise<{ ok: boolean, results: Array<object>, message: string|null }>}
 *   ok=false 时 message 是可读的基础设施错误（worker 缺失/启动失败/超时/输出非法）；
 *   单条请求的失败体现在 results[i].ok / .status / .error，不影响 ok。
 */
export async function callRest(requests, { token, timeoutSec } = {}) {
  const list = Array.isArray(requests) ? requests : [];
  if (list.length === 0) return { ok: true, results: [], message: null };

  const worker = resolveRestWorker();
  if (!worker) {
    return {
      ok: false,
      results: [],
      message:
        "REST worker 缺失（找不到 bin/rest.worker.mjs）：安装包不完整或布局与预期不一致，请重装本 App。",
    };
  }

  const effToken = token === undefined ? String(getToolSecretToken() || "") : String(token || "");
  const sec = normalizeTimeoutSec(timeoutSec);
  const payload = JSON.stringify({ token: effToken, requests: list });

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let out = "";
    let err = "";
    let timedOut = false;
    const OUT_LIMIT = 4 * 1024 * 1024;
    const ERR_LIMIT = 64 * 1024;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let timer = setTimeout(() => {
      timedOut = true;
      try {
        child && child.kill();
      } catch {
        /* 已退出 */
      }
    }, sec * 1000);
    timer.unref?.();

    // `--allow-net` 是本模块存在的理由（见文件头注）：不补它，worker 里的 fetch 会被
    // Node 权限模型拒在 DNS 那一步。但它只在权限模型下合法，所以按 process.permission 判。
    const args = [];
    if (process.permission) args.push("--allow-net");
    // 二进制通道的读写放行：按本批请求点名的路径补对应目录（见 collectFsGrants 与文件头注）。
    // 与 --allow-net 同门槛——这三个都是权限模型下的放行项，无权限模型时给了会启动失败。
    if (process.permission) {
      const grants = collectFsGrants(list);
      for (const dir of grants.read) args.push("--allow-fs-read=" + dir);
      for (const dir of grants.write) args.push("--allow-fs-write=" + dir);
    }
    args.push(worker);
    try {
      child = spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // NODE_NO_WARNINGS：抑制子进程的 PERM0002 / ExperimentalWarning 噪声
        // （worker 的 stdout 只走协议，stderr 只作诊断，噪声不参与解析，但没必要留）。
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
    } catch (e) {
      finish({
        ok: false,
        results: [],
        message: "启动 REST worker 失败：" + String((e && e.message) || e),
      });
      return;
    }

    child.stdout.on("data", (d) => {
      if (out.length < OUT_LIMIT) out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (err.length < ERR_LIMIT) err += d.toString("utf8");
    });

    child.on("error", (e) => {
      finish({
        ok: false,
        results: [],
        message: "启动 REST worker 失败：" + String((e && e.message) || e),
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          results: [],
          message:
            "GitHub REST 调用超时（" + sec + " 秒）：已终止。若属正常长任务，请增大 timeoutSec 后重试。",
        });
        return;
      }
      const text = out.trim();
      if (!text) {
        const diag = err.trim().split("\n").slice(-4).join("\n");
        finish({
          ok: false,
          results: [],
          message:
            "REST worker 无输出（exit " + code + "）" + (diag ? "：\n" + diag : "。"),
        });
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 走下方非法输出分支 */
      }
      if (!parsed || typeof parsed !== "object") {
        finish({
          ok: false,
          results: [],
          message: "REST worker 输出非 JSON：" + text.slice(0, 400),
        });
        return;
      }
      if (parsed.fatal) {
        finish({ ok: false, results: [], message: "REST worker 失败：" + String(parsed.fatal) });
        return;
      }
      const results = Array.isArray(parsed.results) ? parsed.results.map(normalizeResult) : [];
      finish({ ok: true, results, message: null });
    });

    try {
      child.stdin.end(payload);
    } catch {
      /* stdin 已关闭（进程快速退出），忽略 */
    }
  });
}

// ───────────────────────────── 便捷封装 ─────────────────────────────

/** 由 repo（owner/repo）与路径片段拼 REST 地址。 */
export function apiUrl(repo, pathAndQuery) {
  const p = String(pathAndQuery || "");
  const suffix = p.startsWith("/") ? p : "/" + p;
  return "https://api.github.com/repos/" + repo + suffix;
}

/** 由路径片段拼 api.github.com 地址（账号级端点，如 /user/gpg_keys）。 */
export function apiRoot(pathAndQuery) {
  const p = String(pathAndQuery || "");
  return "https://api.github.com" + (p.startsWith("/") ? p : "/" + p);
}

/** github.com 的 OAuth 端点地址（device flow 用，不是 api.github.com）。 */
export function webUrl(pathAndQuery) {
  const p = String(pathAndQuery || "");
  return "https://github.com" + (p.startsWith("/") ? p : "/" + p);
}

/**
 * uploads.github.com 的地址（发布资产上传端点）。
 *
 * GitHub 把资产上传单独摆在 uploads 域上，与 api.github.com 同凭据但不同主机——所以它既是一条
 * 独立的 URL 拼法，也是 worker 出站白名单里单独的一格。
 */
export function uploadsUrl(pathAndQuery) {
  const p = String(pathAndQuery || "");
  return "https://uploads.github.com" + (p.startsWith("/") ? p : "/" + p);
}

/** 单请求的便捷入口：返回归一化结果（失败时 ok=false 且带 error/status）。 */
export async function request(one, options) {
  const r = await callRest([one], options);
  // 基础设施失败的形状与 normalizeResult 对齐（含二进制通道的 bytes / code / size），
  // 这样调用方不必为「失败来自 worker 还是来自 GitHub」写两套取值。
  if (!r.ok) {
    return { ok: false, status: null, json: null, text: "", error: r.message, bytes: null, code: null, size: null };
  }
  return r.results[0] || { ok: false, status: null, json: null, text: "", error: "无结果", bytes: null, code: null, size: null };
}

/**
 * 从 REST 结果里取可读错误原文。
 * GitHub 的 4xx 响应体是 `{ message, errors: [...] }`，优先取它；否则取文本首行。
 */
export function errorDetail(result) {
  const data = result && result.json;
  if (data && typeof data === "object" && data.message) {
    const errs = Array.isArray(data.errors) ? data.errors : [];
    const extra = errs
      .map((e) =>
        e && typeof e === "object"
          ? [e.resource, e.field, e.code, e.message].filter(Boolean).join(" ")
          : String(e || ""),
      )
      .filter(Boolean)
      .join("；");
    return extra ? String(data.message) + "（" + extra + "）" : String(data.message);
  }
  const first = String((result && result.text) || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return first || (result && result.error) || "未知错误";
}
