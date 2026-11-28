// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/envelope.js — 标准信封加密（钥匙环 KEK 只包 DEK，数据用 AES-256-GCM）。
 *
 * ## 密钥模型（上层已定）
 *
 *   钥匙环 hana-githana / kek   ← 32 字节 KEK，只用来包 DEK，永不导出、永不落盘
 *   每个受保护对象               ← 自带 32 字节 DEK，wrapped DEK 与密文存在同一个自包含块里
 *
 * 为什么要两层：轮换 KEK 只需重包每个对象的 wrapped DEK，不用重新加密密文。KEK 泄漏或
 * 用户想定期轮换时，改的是钥匙环里那一个条目 + 重写各对象头部 48 字节，密文（可能很大，
 * 例如整把 gpg 私钥）原封不动。单层（直接用 KEK 加密数据）做不到这一点——换 KEK 等于全量重加密。
 *
 * ## 信封格式（自包含，v2 = 0x02）
 *
 *   offset  len           字段
 *   0       1             version = 0x02
 *   1       12            wrapNonce        （AES-256-GCM 包 DEK 用的 nonce）
 *   13      32            wrappedDEK 密文   （DEK 用 KEK 加密，无 AAD）
 *   45      16            wrappedDEK tag    （GCM 认证标签）
 *   61      12            dataNonce        （AES-256-GCM 加密数据用的 nonce）
 *   73      N             ciphertext       （数据密文）
 *   73+N    16            tag              （数据 GCM 认证标签）
 *
 * 定长头 = 1 + 12 + (32+16) + 12 = 73 字节；尾部固定 16 字节 tag。
 * wrapped DEK 段 = 48 字节（32B 密文 + 16B tag），排在 wrapNonce 之后、dataNonce 之前。
 *
 * ## wrapped DEK 用 AES-256-GCM 包裹，而不是 AES-KW（RFC 3394）
 *
 * 二选一，这里明确选 GCM，理由：
 *   · 数据侧已经是 AES-256-GCM，包 DEK 复用同一套 node:crypto 原语（createCipheriv +
 *     getAuthTag），不引入第二套算法路径，代码与审计面更小；
 *   · AES-KW 在 node:crypto 里只有 wrap/unwrap 两个面向对称密钥的接口，且不带 nonce、
 *     没有认证标签可读，调试与「被篡改/KEK 不对」的报错不如 GCM 的认证失败直观；
 *   · 代价是 wrapped DEK 多 16B tag（48B vs 40B），相对每对象几十字节可忽略；
 *   · 安全性上两者都够（DEK 是 32 字节随机量，GCM 的 12B 随机 nonce 在这个用量下足够了）。
 *
 * ## KEK 从哪来、DEK 存在哪
 *
 *   · ensureKek()：读钥匙环 hana-githana/kek；不存在就生成 32 字节随机量写回一次。
 *     钥匙环不可用（例如 Linux 没有 Secret Service、或钥匙环被锁）抛出明确错误，
 *     绝不静默降级成无加密——凭据/私钥一旦明文落盘就回不去了。
 *   · 每个对象的 DEK 封在它自己的信封里（凭据在 cipher BLOB、gpg 在 gpg.key.bin），
 *     钥匙环里始终只有 KEK 一条：shim 只需「文件 + 钥匙环」，不读数据库。
 *
 * ## 为什么在 Node 里也走 worker 子进程
 *
 * AppHost 主进程在权限模型下 require 原生 addon 会失败（lib/keyring.worker.mjs 头注有实测）。
 * 本文件在主进程中只做 AES（node:crypto 内置，无权限限制），只有钥匙环读写经 worker 子进程。
 * 打包后的 gpg.shim 进程不在权限模型下，但为保持「一处实现」，同样复用这里的 worker 调用。
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 钥匙环服务名（与 lib/secret.js 同口径）。 */
export const KEYRING_SERVICE = "hana-githana";
/** KEK 在钥匙环里的账户名。 */
export const KEK_ACCOUNT = "kek";

const VERSION = 0x02;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;
const WRAPPED_DEK_LEN = DEK_LEN + TAG_LEN; // 48
const HEADER_LEN = 1 + NONCE_LEN + WRAPPED_DEK_LEN + NONCE_LEN; // 73

/**
 * worker 文件的候选位置：源码树（lib/ 旁）优先，交付树（bin/ 下平铺）兜底。
 * 交付时 build-app 把 lib/keyring.worker.mjs 打到 bin/keyring.worker.mjs；源码树里它与本文件同在 lib/。
 */
function workerCandidates() {
  // 1) 环境变量优先：bin.js 在给 git 注入签名接线时一并把 worker 绝对路径传下来
  //    （shim 是打包后的单文件，import.meta.url 经打包器处理后未必可靠，env 是保底）。
  const out = [];
  try {
    const fromEnv = process.env.GITHANA_KEYRING_WORKER;
    if (typeof fromEnv === "string" && fromEnv) out.push(fromEnv);
  } catch {
    /* AppHost 里读不存在的 env 键会抛错，忽略 */
  }
  // 2) 运行期入口同目录（交付树 bin/ 与源码树 lib/ 都命中）。
  let here = null;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = null;
  }
  if (here) {
    out.push(path.join(here, "keyring.worker.mjs"));
    out.push(path.join(here, "bin", "keyring.worker.mjs"));
  }
  return [...new Set(out)];
}

export function resolveKeyringWorker() {
  for (const p of workerCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 许可根外：试下一个 */
    }
  }
  return null;
}

/**
 * 跑一次 worker，逐行收发（一次调用开一次进程，见 keyring.worker.mjs 头注）。
 *
 * @param {Array<object>} requests 请求数组（每条一个 op）
 * @returns {Promise<Array<object>>} 与请求一一对应的响应
 */
export function runKeyringWorker(requests) {
  const list = Array.isArray(requests) ? requests : [];
  if (list.length === 0) return Promise.resolve([]);
  const worker = resolveKeyringWorker();
  if (!worker) {
    return Promise.reject(new Error("keyring worker missing (lib/keyring.worker.mjs not found): the installation is incomplete."));
  }
  const NL = String.fromCharCode(10);
  const payload = list.map((r, i) => JSON.stringify({ id: i, ...r })).join(NL) + NL;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let out = "";
    let err = "";
    const OUT_LIMIT = 1 * 1024 * 1024;
    const ERR_LIMIT = 64 * 1024;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    let timer = setTimeout(() => {
      try {
        child && child.kill();
      } catch {
        /* 已退出 */
      }
    }, 30_000);
    timer.unref?.();
    try {
      // 权限模型下 require 原生 addon 需要 --allow-addons 且能读到 .node 文件（--allow-fs-read 指向
      // worker 所在目录，覆盖 bin/node_modules）。这两个旗标只在权限模型下合法（单给会 ERR_MISSING_OPTION），
      // 所以与 rest.js 同口径：按 process.permission 是否存在决定是否带上。shim 进程不在权限模型下 → 不带。
      const args = [];
      if (process.permission) {
        args.push("--allow-addons");
        try {
          args.push("--allow-fs-read=" + path.dirname(worker));
        } catch {
          /* 忽略：路径异常时退回无放行，worker 会以可读错误返回 */
        }
      }
      args.push(worker);
      child = spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
    } catch (e) {
      finish(reject, new Error("failed to start the keyring worker: " + String((e && e.message) || e)));
      return;
    }
    child.stdout.on("data", (d) => {
      if (out.length < OUT_LIMIT) out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (err.length < ERR_LIMIT) err += d.toString("utf8");
    });
    child.on("error", (e) => finish(reject, new Error("failed to start the keyring worker: " + String((e && e.message) || e))));
    child.on("close", (code) => {
      const lines = out.split(NL).map((l) => l.trim()).filter(Boolean);
      const byId = new Map();
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o && typeof o === "object") byId.set(o.id, o);
        } catch {
          /* 非协议行：忽略 */
        }
      }
      if (byId.size === 0) {
        const diag = err.trim().split(NL).slice(-4).join(NL);
        finish(reject, new Error("keyring worker produced no output (exit " + code + ")" + (diag ? ": " + diag : ".")));
        return;
      }
      finish(resolve, list.map((_, i) => byId.get(i) || { ok: false, kind: "no_response", error: "no response for request " + i }));
    });
    try {
      child.stdin.end(payload);
    } catch {
      /* 已关闭 */
    }
  });
}

/** 单请求便捷包装：返回该条响应（失败则抛可读错误，区分 kind）。 */
async function callOne(req) {
  const [res] = await runKeyringWorker([req]);
  if (!res || res.ok !== true) {
    const kind = (res && res.kind) || "keyring_error";
    const msg = (res && res.error) || "unknown keyring error";
    const e = new Error(msg);
    e.kind = kind;
    throw e;
  }
  return res;
}

/** 读一个钥匙环条目，返回 Buffer 或 null（不存在）。被锁/拒绝访问会抛（kind=keyring_locked）。 */
export async function keyringGet(service, account) {
  const res = await callOne({ op: "get", service, account });
  if (res.value === null || res.value === undefined) return null;
  return Buffer.from(String(res.value), "base64");
}

/** 写一个钥匙环条目（Buffer）。 */
export async function keyringSet(service, account, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  await callOne({ op: "set", service, account, secret: buf.toString("base64") });
}

/** 删一个钥匙环条目；返回是否真的删掉了（false = 本就不存在）。 */
export async function keyringDelete(service, account) {
  const res = await callOne({ op: "delete", service, account });
  return res.deleted === true;
}

/** 判断一个错误是不是「钥匙环被锁/拒绝访问」——调用方据它给不同文案，不当成「未配置」。 */
export function isKeyringLocked(err) {
  return !!(err && (err.kind === "keyring_locked" || err.kind === "ambiguous"));
}

/** 判断一个错误是不是「钥匙环不可用」（原生绑定未加载 / worker 缺失）。 */
export function isKeyringUnavailable(err) {
  return !!(err && (err.kind === "native_binding_unavailable" || /keyring worker missing|failed to start/i.test(String((err && err.message) || ""))));
}

// ───────────────────────────── KEK ─────────────────────────────

/** 进程内缓存 KEK（一次调用内多次封/解不必反复开 worker）。 */
let cachedKek = null;

/**
 * 取 KEK：读钥匙环 hana-githana/kek；不存在就生成 32 字节写回一次。
 * 钥匙环不可用/被锁 → 抛明确错误（不静默降级成无加密）。
 * @returns {Promise<Buffer>} 32 字节
 */
export async function ensureKek({ create = true } = {}) {
  if (cachedKek && cachedKek.length === DEK_LEN) return cachedKek;
  let buf = null;
  try {
    buf = await keyringGet(KEYRING_SERVICE, KEK_ACCOUNT);
  } catch (e) {
    const hint = isKeyringUnavailable(e)
      ? "the keyring native binding is unavailable"
      : isKeyringLocked(e)
        ? "the OS keyring is locked or access was denied"
        : "the keyring could not be read";
    throw new Error("cannot obtain the key-encryption key (" + hint + "): " + String((e && e.message) || e));
  }
  if (buf && buf.length === DEK_LEN) {
    cachedKek = buf;
    return buf;
  }
  // 读路径（create=false）遇到 KEK 不存在要报错，**不能顺手生成新的**：那会在一次「解密」里
  // 悄悄把 KEK 换掉，让所有旧的 wrapped DEK 全部解不开（等于自毁数据）。只有加密/首次建立才创建。
  if (!create) {
    throw new Error("the key-encryption key is missing from the OS keyring; cannot decrypt (the keyring was reset or its KEK item was removed)");
  }
  // 不存在（或长度不对 = 损坏）→ 生成一次并写回。写不进去（被锁）同样如实抛出。
  const fresh = crypto.randomBytes(DEK_LEN);
  try {
    await keyringSet(KEYRING_SERVICE, KEK_ACCOUNT, fresh);
  } catch (e) {
    throw new Error("cannot create the key-encryption key in the OS keyring: " + String((e && e.message) || e));
  }
  cachedKek = fresh;
  return fresh;
}

/** 仅供测试/诊断：清掉进程内 KEK 缓存。 */
export function _resetKekCache() {
  cachedKek = null;
}

// ───────────────────────────── 信封（纯 AES，不碰钥匙环） ─────────────────────────────

/** 用 KEK 包一段 DEK，返回 48 字节（32B 密文 + 16B tag），nonce 由调用方给定。 */
function wrapDek(kek, dek, wrapNonce) {
  const c = crypto.createCipheriv("aes-256-gcm", kek, wrapNonce);
  const body = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

/** 用 KEK 解 48 字节 wrapped DEK，返回 32 字节 DEK；tag 不对（KEK 不符/被篡改）会抛。 */
function unwrapDek(kek, wrappedDek, wrapNonce) {
  const body = wrappedDek.subarray(0, DEK_LEN);
  const tag = wrappedDek.subarray(DEK_LEN, WRAPPED_DEK_LEN);
  const d = crypto.createDecipheriv("aes-256-gcm", kek, wrapNonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

/** 用给定的 32 字节 DEK 封一段明文，产出自包含信封。 */
function buildEnvelope(kek, dek, plaintext) {
  const wrapNonce = crypto.randomBytes(NONCE_LEN);
  const dataNonce = crypto.randomBytes(NONCE_LEN);
  const wrappedDek = wrapDek(kek, dek, wrapNonce);
  const c = crypto.createCipheriv("aes-256-gcm", dek, dataNonce);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  const body = Buffer.concat([c.update(data), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), wrapNonce, wrappedDek, dataNonce, body, tag]);
}

/** 检查信封长度与版本合法性（不到最小结构直接判损坏，给出可读错误而不是越界读）。 */
function assertEnvelope(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN + TAG_LEN) {
    throw new Error("the envelope is too short or empty (corrupted ciphertext)");
  }
  if (buf[0] !== VERSION) {
    throw new Error("the envelope version is " + buf[0] + ", expected " + VERSION + " (not a v2 envelope; corrupted or written by an incompatible build)");
  }
}

/** 从信封里解出 DEK（先用 KEK 解 wrapped DEK 段）。 */
function extractDek(kek, buf) {
  const wrapNonce = buf.subarray(1, 1 + NONCE_LEN);
  const wrappedDek = buf.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + WRAPPED_DEK_LEN);
  try {
    return unwrapDek(kek, wrappedDek, wrapNonce);
  } catch {
    throw new Error("cannot unwrap the data-encryption key: it was wrapped with a different key-encryption key, or the header was tampered with");
  }
}

/** 用信封里的 DEK 解数据段。 */
function openWithDek(buf, dek) {
  const dataNonce = buf.subarray(HEADER_LEN - NONCE_LEN, HEADER_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", dek, dataNonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error("the ciphertext failed authentication (corrupted, or encrypted with a different data-encryption key)");
  }
}

// ───────────────────────────── 对外用法 ─────────────────────────────

/**
 * 【DEK 封在对象自己里】sealSelfContained / openSelfContained —— 凭据与 gpg.key.bin 都用它。
 *
 * 每次封都生成一把新 DEK 封进信封自身，钥匙环里只有 KEK 一条。这样 shim 只需「文件 + 钥匙环
 * （拿 KEK）」就能解私钥，不碰数据库；凭据那边也没必要为了拿 DEK 多读一次钥匙环。
 * 轮换 KEK 时只需重包这个 48 字节头（见文件头的收益说明）。
 */
export async function sealSelfContained(plaintext) {
  const kek = await ensureKek({ create: true });
  const dek = crypto.randomBytes(DEK_LEN);
  return buildEnvelope(kek, dek, plaintext);
}

export async function openSelfContained(cipher) {
  const buf = Buffer.isBuffer(cipher) ? cipher : Buffer.from(cipher || []);
  assertEnvelope(buf);
  const kek = await ensureKek({ create: false });
  const dek = extractDek(kek, buf);
  return openWithDek(buf, dek);
}

/** 信封是否是我们认识的 v2 格式（用于「alg 自称信封但其实不是」的早判，不触钥匙环）。 */
export function looksLikeEnvelope(buf) {
  const b = Buffer.isBuffer(buf) ? buf : null;
  return !!(b && b.length >= HEADER_LEN + TAG_LEN && b[0] === VERSION);
}
