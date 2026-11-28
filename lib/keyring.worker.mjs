// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/keyring.worker.mjs — 系统钥匙环的 JSON 行协议 worker（一次一进程，不常驻）。
 *
 * ## 为什么要有这个子进程
 *
 * AppHost 主进程在 Node 权限模型下，**进程内 require 原生 addon 直接失败**（实测报
 * "Cannot find native binding"，平台二进制齐全也一样——权限模型挡的是 dlopen，不是文件缺失）。
 * 而 spawn 出去的子进程**不继承**权限模型，里面 require('@napi-rs/keyring') 完全正常
 * （本机实测 setSecret / getSecret / deletePassword 均可用）。所以钥匙环读写只能在子进程里做。
 *
 * ## 协议
 *
 * stdin 逐行一个 JSON 请求，stdout 逐行一个 JSON 响应，一一对应：
 *
 *   { "id"?: any, "op": "get",    "service": "hana-githana", "account": "kek" }
 *   { "id"?: any, "op": "set",    "service": "hana-githana", "account": "kek", "secret": "<base64>" }
 *   { "id"?: any, "op": "delete", "service": "hana-githana", "account": "kek" }
 *
 * 响应：
 *   get    → { "id"?, "ok": true, "value": "<base64>" | null }     // null = 条目不存在
 *   set    → { "id"?, "ok": true }
 *   delete → { "id"?, "ok": true, "deleted": true|false }          // false = 条目本就不存在
 *   失败   → { "id"?, "ok": false, "kind": "...", "error": "..." }
 *
 * ## 「钥匙环被锁/拒绝访问」与「条目不存在」是两件事
 *
 * @napi-rs/keyring 的语义：getSecret 对**不存在**的条目返回 null（不抛），deletePassword 返回
 * false（不抛）；只有在钥匙环**被锁或拒绝访问**时才抛。这对本 App 很关键——「条目不存在」是
 * 正常的首次状态（要生成 DEK），「被锁」是必须先修的环境问题，绝不能混成「未登录」。
 * 所以：null/false 走 ok:true 的正常分支；抛出的异常按 kind 分类（locked / ambiguous / error）。
 *
 * ## stdout 只走协议
 *
 * stdout 只允许 JSON 行；任何诊断（包括原生模块加载失败的完整原因）一律走 stderr，
 * 由调用方（lib/envelope.js）在进程退出码为 0 但响应缺失时读取，拼成可读错误。
 */
import { createInterface } from "node:readline";

let keyring = null;
let loadError = null;
try {
  // 放在 try 里：原生模块加载失败（缺二进制 / 权限）要变成可读的逐行响应，而不是让进程直接崩。
  // @napi-rs/keyring 是 CJS，这里用 require 语义拿默认导出（createRequire 保证在 ESM 里可用）。
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  keyring = require("@napi-rs/keyring");
} catch (e) {
  loadError = String((e && e.message) || e);
}

/** 把底层异常归成可区分的 kind（见文件头注）。 */
function classify(err) {
  const raw = String((err && (err.message || err)) || "unknown keyring error").trim();
  const m = raw.toLowerCase();
  let kind = "keyring_error";
  if (/no entry|not found|no such|item not found|the specified item|could not be found|no matching|no credential/.test(m)) {
    kind = "not_found";
  } else if (/locked|denied|access is denied|permission|eacces|blocked|locked out/.test(m)) {
    kind = "keyring_locked";
  } else if (/ambiguous/.test(m)) {
    kind = "ambiguous";
  }
  return { kind, error: raw };
}

/** 处理一条请求，返回响应对象（永不抛：异常都转成 ok:false）。 */
function handle(req) {
  const id = req && Object.prototype.hasOwnProperty.call(req, "id") ? req.id : undefined;
  const withId = (o) => (id === undefined ? o : { id, ...o });

  if (!keyring) {
    return withId({
      ok: false,
      kind: "native_binding_unavailable",
      error:
        "the keyring native binding could not be loaded in the worker process: " +
        (loadError || "unknown error") +
        " (the @napi-rs/keyring platform binary must ship under bin/node_modules/)",
    });
  }

  const op = req && req.op;
  const service = req && typeof req.service === "string" ? req.service : "";
  const account = req && typeof req.account === "string" ? req.account : "";
  if (!service || !account) {
    return withId({ ok: false, kind: "bad_request", error: "service and account are required" });
  }

  try {
    const entry = new keyring.Entry(service, account);
    if (op === "get") {
      const secret = entry.getSecret();
      // getSecret 对不存在的条目返回 null（不抛）。原样区分：value=null 即「条目不存在」。
      if (secret === null || secret === undefined) return withId({ ok: true, value: null });
      return withId({ ok: true, value: Buffer.from(secret).toString("base64") });
    }
    if (op === "set") {
      const b64 = req && typeof req.secret === "string" ? req.secret : "";
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) {
        return withId({ ok: false, kind: "bad_request", error: "secret must be a non-empty base64 buffer" });
      }
      entry.setSecret(bytes);
      return withId({ ok: true });
    }
    if (op === "delete") {
      const deleted = entry.deletePassword();
      return withId({ ok: true, deleted: deleted === true });
    }
    return withId({ ok: false, kind: "bad_request", error: "unknown op: " + String(op) });
  } catch (e) {
    const c = classify(e);
    return withId({ ok: false, kind: c.kind, error: c.error });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = String(line || "").trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, kind: "bad_request", error: "invalid JSON line: " + String((e && e.message) || e) }) + "\n");
    return;
  }
  const res = handle(req);
  process.stdout.write(JSON.stringify(res) + "\n");
});
rl.on("close", () => {
  // stdin 结束即收工：worker 不常驻（见文件头注）。
  // **不调 process.exit**：对管道 stdout，process.exit 可能在缓冲尚未刷出时就终止进程，把响应截断，
  // 父进程于是读到 "no output"。stdin 已关、readline 已闭，事件循环自然会空，进程自行退出即可。
});
