// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/secret.js — GitHub 凭据的本地加密存放（后端可插拔，现统一为钥匙环信封）。
 *
 * ## 为什么不是「交给 gh 的系统凭据库」
 *
 * GitHana 的隔离原则是「密钥不出 App 边界」：gitconfig 隔离、私钥只落本 App 的 dataDir（信封加密）、
 * 令牌只在 App 进程内存与 REST worker 之间流转。把令牌塞进 gh 的全局存储，等于让用户自己的 gh、
 * 还把 App 的操作变成全局状态变更——爆炸半径反而变大。所以凭据留在 App 自己的命名空间里。
 *
 * ## 为什么必须加密
 *
 * 明文落盘的问题是真的：.hanako 下的 ACL 对 Authenticated Users 是 Modify，令牌一旦以明文
 * 落在数据目录里，同用户进程都能读。所以令牌只走加密后端，没有明文回退。
 *
 * ## 凭据形态：只有 OAuth 一种
 *
 * 凭据来自 GitHub App device flow 签发的 user access token（ghu_）。记录结构：
 *
 *   { kind: "oauth", alg, cipher, meta: { login, name, expiresAt, needsReauth? } }
 *
 * cipher 经后端保护，解出来是 JSON { accessToken, refreshToken }；meta 是非机密对象，
 * 明文可读——设置页据此显示账号与到期时间，不需要解密，也不必把令牌送进页面。
 *
 * 非 OAuth 形态的旧记录（密文解出裸 PAT，kind 不是 "oauth"）**读但不采用**：不报错、
 * 不动文件、不注入 GH_TOKEN，设置页提示「PAT 通道已停用」并提供显式清除入口。
 *
 * ## Client ID 由本 App 固定
 *
 * Client ID 非机密，就是本 App 注册的那一个（DEFAULT_CLIENT_ID），不支持用户修改。
 *
 * ## 后端：三平台统一的「钥匙环 + 信封」（keyring-envelope-v2）
 *
 * 模型见 lib/envelope.js：
 *
 *   钥匙环 hana-githana/kek  ← 32B KEK，只包 DEK
 *   密文（data.db 的 cipher BLOB）← v2 自包含信封（wrapNonce | wrappedDEK | dataNonce | ct | tag）
 *
 * 凭据的 DEK 封在自己的信封里，不单独存钥匙环：钥匙环里只有一条 KEK，换 KEK 时重包每个对象的
 * 48 字节头即可，密文不用重加密。
 *
 * alg 写成自描述值 keyring-envelope-v2：看到它就知道「这是本机钥匙环 + 信封格式写的，能在这台机器
 * （同一用户、同一个钥匙环）上解开」。换平台/换用户后钥匙环不同 → 解不开，如实报错，不当未配置。
 *
 * ## 为什么走 worker 子进程读钥匙环
 *
 * AppHost 主进程在 Node 权限模型下 require 原生 addon 会失败（实测 "Cannot find native binding"）；
 * spawn 出去的子进程不继承该模型，require('@napi-rs/keyring') 正常。所以钥匙环读写一律经
 * lib/keyring.worker.mjs（见 envelope.js 的 runKeyringWorker）。AES 本身用 node:crypto，不需要子进程。
 *
 * ## 进程内缓存
 *
 * 解密是异步的，而工具调用需要在发起请求前同步知道“有没有令牌”；所以结果写进 tools/lib/context.js
 * 的单例（令牌 + meta），工具只同步读。令牌由 REST worker 的调用方经 stdin 传给它（见 tools/lib/rest.js）。
 */
import { sealSelfContained, openSelfContained } from "./envelope.js";
import { getToolDataDir, setToolSecretToken, setToolOAuthMeta } from "../tools/lib/context.js";
import { readCredentialRow, writeCredentialRow, clearCredentialRow, dbFilePath, getRecord, setRecord, deleteRecord } from "./db.js";

/**
 * 本 App 注册的 GitHub App Client ID（非机密）。
 * 权限、发布链路与 device flow 都绑在这个 App 上，所以它是常量，不开放覆盖。
 */
export const DEFAULT_CLIENT_ID = "Iv23li0dA1IaFVs6klAc";

/** 信封后端的自描述 alg 值（与 lib/openpgp-key.js / envelope.js 同口径）。 */
export const ENVELOPE_ALG = "keyring-envelope-v2";

/** 读记录；没有 / 损坏 → null。cipher 在这里转回 base64，下游不用改。 */
export function readSecretRecord(dataDir) {
  const row = readCredentialRow(dataDir || getToolDataDir() || "");
  if (!row) return null;
  return {
    kind: row.kind,
    alg: row.alg,
    cipher: row.cipher.toString("base64"),
    meta: row.meta,
  };
}

// ───────────────────────────── 后端 ─────────────────────────────
//
// 三平台统一：钥匙环 KEK 包 DEK、AES-256-GCM 信封（lib/envelope.js）。
// Windows / macOS / Linux 走同一实现，不再按平台分后端。
// 钥匙环不可用时（Linux 无 Secret Service、被锁）由 envelope 抛可读错误，绝不静默降级成明文。

const KEYRING_ENVELOPE_BACKEND = {
  id: "keyring-envelope",
  alg: ENVELOPE_ALG,
  storage: "keyring",
  available: () => true,
  // 记录边界的 cipher 是 base64 字符串：seal 产出 Buffer，这里编码；open 接受 base64，解码后解。
  protect: async (text) => (await sealSelfContained(String(text))).toString("base64"),
  unprotect: async (cipher) => (await openSelfContained(Buffer.from(String(cipher || ""), "base64"))).toString("utf8"),
};

/** 选后端：三平台统一返回信封后端（platform 参数保留给测试注入）。 */
export function pickBackend(platform = process.platform) {
  void platform;
  return KEYRING_ENVELOPE_BACKEND;
}

// ───────────────────────────── 记录读写 ─────────────────────────────

/** 写记录（data.db 的 credential 表，只有一行；密文以 BLOB 存入）。 */
function writeSecretRecord(dataDir, record) {
  writeCredentialRow(dataDir || getToolDataDir(), {
    kind: record.kind,
    alg: record.alg,
    cipher: Buffer.from(String(record.cipher || ""), "base64"),
    meta: record.meta,
  });
}

/** 删除记录（不存在则忽略）。 */
export function removeSecretRecord(dataDir) {
  clearCredentialRow(dataDir || getToolDataDir() || "");
}

/** 这份记录是不是 OAuth 凭据（kind 恒为 "oauth"；其余一律按旧 PAT 记录对待）。 */
function isOAuthRecord(rec) {
  return !!(rec && rec.cipher && rec.kind === "oauth");
}

/** 这份记录是不是旧 PAT 记录（有密文但不是 OAuth 形态）。 */
function isLegacyRecord(rec) {
  return !!(rec && rec.cipher && rec.kind !== "oauth");
}

/** 后端能不能解开这份密文（alg 不匹配 = 别的平台/后端写的）。 */
function backendMismatch(rec, backend) {
  return !!(rec && rec.alg && backend.alg && rec.alg !== backend.alg);
}

/**
 * 本 App 注册的 Client ID。它是常量，不接受覆盖。
 */
export function readClientId() {
  return DEFAULT_CLIENT_ID;
}

// ───────────────────────────── 对外行为 ─────────────────────────────

/**
 * 启动时把凭据解进进程缓存。
 * 永不抛出：解不开就按未配置处理，让 gh 自己回报「未登录」。
 * 旧 PAT 记录走 source: "legacy-pat"——读到了但不采用，不注入 GH_TOKEN。
 * @returns {{ source: "oauth"|"legacy-pat"|"none", configured: boolean, error?: string, needsReauth?: boolean }}
 */
export async function loadSecretIntoContext(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);

  // 每次加载都先清空进程缓存：凭据被清/被换时不会留下上一份的残留。
  setToolSecretToken("");
  setToolOAuthMeta(null);

  if (isOAuthRecord(rec)) {
    if (backendMismatch(rec, backend)) {
      const msg = "the ciphertext is protected by " + rec.alg + " while this machine's backend is " + backend.alg + ", so it cannot be decrypted";
      console.error("[githana] credential load failed: " + msg);
      return { source: "oauth", configured: false, error: msg };
    }
    let payload = null;
    try {
      payload = JSON.parse(await backend.unprotect(rec.cipher));
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error("[githana] credential decrypt failed: " + msg);
      return { source: "oauth", configured: false, error: msg };
    }
    const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
    setToolOAuthMeta(meta);
    if (meta.needsReauth === true) {
      return { source: "oauth", configured: false, needsReauth: true };
    }
    const token = String((payload && payload.accessToken) || "");
    setToolSecretToken(token);
    return { source: "oauth", configured: !!token };
  }

  if (isLegacyRecord(rec)) {
    return { source: "legacy-pat", configured: false };
  }

  return { source: "none", configured: false };
}

/**
 * 读凭据（解密；读时顺带迁移）。无 OAuth 凭据 / 后端不匹配 / 密文损坏 → null。
 * @returns {Promise<{ token: string, refreshToken: string, meta: object } | null>}
 */
export async function readCredential(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);
  if (!isOAuthRecord(rec)) return null;
  if (backendMismatch(rec, backend)) return null;
  let payload = null;
  try {
    payload = JSON.parse(await backend.unprotect(rec.cipher));
  } catch {
    return null;
  }
  return {
    token: String((payload && payload.accessToken) || ""),
    refreshToken: String((payload && payload.refreshToken) || ""),
    meta: rec.meta && typeof rec.meta === "object" ? { ...rec.meta } : {},
  };
}

/**
 * 保存 OAuth 凭据：走信封加密落盘。后端不可用（钥匙环被锁/缺失）时**直接失败**，不写明文。
 * @param {{ dataDir?: string, token: string, refreshToken: string, meta: object }} args
 */
export async function saveCredential({ dataDir, token, refreshToken, meta } = {}) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const payload = JSON.stringify({
    accessToken: String(token || ""),
    refreshToken: String(refreshToken || ""),
  });
  const cipher = await backend.protect(payload);
  // 只留有值的字段：needsReauth 为 false 时不写（缺席即未失效）。
  const cleanMeta = {};
  for (const [k, v] of Object.entries(meta && typeof meta === "object" ? meta : {})) {
    if (v === undefined || v === null) continue;
    if (k === "needsReauth" && v === false) continue;
    cleanMeta[k] = v;
  }
  writeSecretRecord(dir, {
    kind: "oauth",
    alg: backend.alg,
    cipher,
    meta: cleanMeta,
  });
  setToolSecretToken(String(token || ""));
  setToolOAuthMeta(cleanMeta);
  return { protection: backend.alg, backend: backend.id, meta: cleanMeta };
}

/**
 * 只改 meta（不解密、不动密文）——刷新失败打 needsReauth 标记走这里。
 * @returns {object | null} 合并后的 meta（记录不存在/不是 OAuth → null）
 */
export function updateCredentialMeta(dataDir, patch) {
  const dir = dataDir || getToolDataDir();
  const rec = readSecretRecord(dir);
  if (!isOAuthRecord(rec)) return null;
  const meta = { ...(rec.meta && typeof rec.meta === "object" ? rec.meta : {}), ...(patch || {}) };
  // 只改 meta：kind、alg 与 cipher 原样带过去，不解密、不动密文。
  writeSecretRecord(dir, { kind: rec.kind, alg: rec.alg, cipher: rec.cipher, meta });
  return meta;
}

/** 清除凭据：删记录 + 清进程缓存。 */
export async function clearSecret({ dataDir } = {}) {
  try {
    removeSecretRecord(dataDir || getToolDataDir());
  } catch (e) {
    // 进程内令牌照样清掉，但如实回报：磁盘上还留着，下次启动会再读出来。
    setToolSecretToken("");
    setToolOAuthMeta(null);
    throw new Error(
      "signing out failed: the stored credential could not be deleted (" + String((e && e.message) || e) + ").",
    );
  }
  clearAccount(dataDir);
  setToolSecretToken("");
  setToolOAuthMeta(null);
  return { cleared: true };
}

/** 读当前登录账号（身份的唯一副本）。 */
export function readAccount(dataDir) {
  const rec = getRecord(dataDir || getToolDataDir() || "", "account");
  if (!rec || typeof rec !== "object") return null;
  return {
    login: String(rec.login || ""),
    name: String(rec.name || ""),
    email: String(rec.email || ""),
  };
}

/** 写当前登录账号。空值不覆盖已有值。 */
export function saveAccount(dataDir, { login, name, email } = {}) {
  const dir = dataDir || getToolDataDir();
  const prev = readAccount(dir) || { login: "", name: "", email: "" };
  setRecord(dir, "account", {
    login: String(login || prev.login || ""),
    name: String(name || prev.name || ""),
    email: String(email || prev.email || ""),
  });
}

/** 登录退出时一并清掉账号信息。 */
export function clearAccount(dataDir) {
  deleteRecord(dataDir || getToolDataDir() || "", "account");
}

/** 本地是否存在旧 PAT 记录（供设置页提示「PAT 通道已停用」）。 */
export function readLegacyPat(dataDir) {
  return isLegacyRecord(readSecretRecord(dataDir || getToolDataDir()));
}

/**
 * 给设置页看的摘要：是否已授权、保护方式、存放位置、后端是否可用、账号与到期时间
 * （不回传明文；meta 本来就是明文，可以直接读）。
 */
export function secretInfo(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);
  const available = backend.storage !== "none";
  const location = backend.storage === "keyring" ? backend.id + "（系统钥匙环 + 信封）" : dbFilePath(dir);
  const legacyPatPresent = isLegacyRecord(rec);
  const oauthRec = isOAuthRecord(rec) ? rec : null;
  const mismatch = oauthRec ? backendMismatch(oauthRec, backend) : false;
  const meta = oauthRec && oauthRec.meta && typeof oauthRec.meta === "object" ? oauthRec.meta : {};
  const account = readAccount(dir);

  return {
    configured: !!oauthRec && !mismatch,
    kind: oauthRec ? "oauth" : null,
    protection: (oauthRec && oauthRec.alg) || (legacyPatPresent ? rec.alg || null : null),
    location,
    backend: (rec && rec.backend) || backend.id,
    backendAvailable: available,
    readable: !mismatch,
    login: account && account.login ? account.login : null,
    name: account && account.name ? account.name : null,
    expiresAt: meta.expiresAt ? String(meta.expiresAt) : null,
    refreshExpiresAt: meta.refreshExpiresAt ? String(meta.refreshExpiresAt) : null,
    needsReauth: meta.needsReauth === true,
    legacyPatPresent,
  };
}
