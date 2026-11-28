// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/openpgp-key.js — 隔离签名密钥（OpenPGP.js 实现，不用 GnuPG keyring）。
 *
 * ## 为什么用纯 JS 的 OpenPGP.js 而不是 gpg 二进制
 *
 * 本 App 只需要在隔离环里生成一把 ed25519 密钥并签 commit。用纯 JS 实现后，包体只需一份
 * 约 395 KB 的库文件（随包 GnuPG 压缩后约 5.45 MB），三平台同一实现，也就不需要 GNUPGHOME
 * 隔离、gpgconf.ctl 删除、gpg-agent/scdaemon 收尾。
 *
 * ## 密钥存储（文件放密文与公钥，元信息进 settings 表）
 *
 *   <dataDir>/gpg.key.bin       信封（v2）加密的私钥密文（shim 与 App 都按路径直读）
 *   <dataDir>/gpg.key.pub.asc   活动公钥（armored 明文；本来就要公开上传）
 *   settings 表的 gpg 行        非机密元信息（alg / 指纹等），写回时取行的 updated_at
 *   settings 表的 gpg-published 行  GitHub 发布状态（见下）
 *
 * ## 信封格式（自包含，shim 只靠「文件 + 钥匙环」）
 *
 * gpg.key.bin 现在是 lib/envelope.js 的 v2 自包含信封：
 *
 *   v2 | wrapNonce(12) | wrappedDEK(48) | dataNonce(12) | ciphertext | tag(16)
 *
 * wrapped DEK **封在 gpg.key.bin 自己里面**（与私钥密文同一个文件），不依赖数据库、也不依赖
 * 钥匙环里额外的 DEK 条目。签名 shim（tools/lib/gpg.shim.mjs）因此只要「文件 + 钥匙环（拿 KEK）」
 * 就能解出私钥——这守住了一条历史约束：shim 不能读数据库（它由 git 直接拉起，不经过 App 进程，
 * 也不该为了信封结构把 db 依赖拉回来）。
 *
 * KEK 在钥匙环 hana-githana/kek，只用来包 DEK。轮换 KEK 时只需重包这个 48 字节头，私钥密文
 * （几百到几千字节）不用重新加密——这就是两层密钥模型的收益（见 lib/envelope.js 头注）。
 *
 * ## 为什么发布状态单独一行（gpg-published）
 *
 * 发布状态（published）说的是本机这把钥匙在 GitHub 上的对应关系：远端 key id、指纹、
 * 以及上传成功但没删掉的旧公钥（stale[]）。它与密钥的生成/替换是不同时机写的，单独一行。
 *
 * ## 邮箱语义（一条硬约束）
 *
 * 密钥 UID 邮箱必须等于提交作者邮箱（noreply 格式），否则 GitHub 不判 verified。
 */
import fs from "node:fs";
import path from "node:path";
import * as openpgp from "openpgp";
import { sealSelfContained, openSelfContained } from "./envelope.js";
import { getRecord, getRecordRow, setRecord, deleteRecord } from "./db.js";

/** 私钥密文文件（信封二进制；shim 与 App 都按路径读它） */
const CIPHER_FILE = "gpg.key.bin";
/** 非机密记录进 settings 表，key 固定为 gpg */
const RECORD_KEY = "gpg";
/** 发布状态单独一行：它与密钥的生成/替换是不同时机写的，不该每次读改写整条密钥记录。 */
const PUBLISHED_KEY = "gpg-published";
/** 活动公钥文件（armored 明文） */
export const PUBKEY_FILE = "gpg.key.pub.asc";
/** 新信封后端的自描述 alg（与 lib/secret.js 同口径）。 */
export const ENVELOPE_ALG = "keyring-envelope-v2";

/** <dataDir>/gpg.key.bin */
export function keyFilePath(dataDir) {
  return path.join(dataDir || "", CIPHER_FILE);
}

/** <dataDir>/gpg.key.pub.asc */
export function pubkeyFilePath(dataDir) {
  return path.join(dataDir || "", PUBKEY_FILE);
}

/** 原子写（先写临时文件再 rename）。字符串与 Buffer 都接受。 */
function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

/** 读私钥密文文件原始字节；没有文件 → null。 */
function readCipherBuffer(dataDir) {
  try {
    return fs.readFileSync(keyFilePath(dataDir));
  } catch {
    return null;
  }
}

/** 读私钥密文（base64）；没有文件 → null。 */
function readCipherB64(dataDir) {
  const buf = readCipherBuffer(dataDir);
  return buf ? buf.toString("base64") : null;
}

/**
 * 合成密钥记录：密文来自二进制文件，其余来自 settings 表的 gpg 行。
 * 文件与库都空 → null（对调用方就是「没有这把钥匙」）。
 */
function readRawRecord(dataDir) {
  const cipher = readCipherB64(dataDir);
  const row = getRecordRow(dataDir, RECORD_KEY);
  if (!cipher && !row) return null;
  const meta = row ? row.value : {};
  return { ...meta, ...(cipher ? { cipher } : {}), ...(row && row.updatedAt ? { updatedAt: row.updatedAt } : {}) };
}

/** 归一化发布状态：远端那把钥匙的编号、指纹与待清理清单（时间用行的 updated_at）。 */
function normalizePublished(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: raw.id ? String(raw.id) : raw.keyId ? String(raw.keyId) : "",
    fingerprint: raw.fingerprint ? String(raw.fingerprint) : "",
    stale: Array.isArray(raw.stale)
      ? raw.stale
          .map((e) => ({ id: String((e && (e.id || e.keyId)) || ""), fingerprint: String((e && e.fingerprint) || "") }))
          .filter((e) => e.id)
      : [],
  };
}

/**
 * 写回记录：密文写二进制文件，其余进 settings 表。
 * 传 null（或没有 cipher）表示密钥不存在：文件与记录都清掉（发布状态是另一行，不碰）。
 */
function writeRawRecord(dataDir, rec) {
  const cipher = rec && rec.cipher ? String(rec.cipher) : null;
  const meta = rec ? { ...rec } : null;
  if (meta) delete meta.cipher;

  if (!cipher) {
    try {
      fs.unlinkSync(keyFilePath(dataDir));
    } catch {
      /* 本来就没有 */
    }
    deleteRecord(dataDir, RECORD_KEY);
    return null;
  }

  writeFileAtomic(keyFilePath(dataDir), Buffer.from(cipher, "base64"));
  setRecord(dataDir, RECORD_KEY, meta || {});
  return rec;
}

/**
 * 生成 ed25519 签名密钥。
 * @param {{ name: string, email: string }} args
 * @returns {Promise<{ privateKeyArmored: string, publicKeyArmored: string,
 *   fingerprint: string, keyId: string, uid: string }>}
 */
export async function generateSigningKey({ name, email }) {
  const uid = { name: String(name || "").trim() || String(email || "").trim(), email: String(email || "").trim() };
  if (!uid.email) throw new Error("generating a key needs an email (GitHub uses it to verify the signature's ownership)");
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "ed25519",
    userIDs: [uid],
    format: "armored",
  });
  const parsed = await openpgp.readKey({ armoredKey: privateKey });
  const fingerprint = parsed.getFingerprint().toUpperCase();
  return {
    privateKeyArmored: privateKey,
    publicKeyArmored: publicKey,
    fingerprint,
    keyId: fingerprint.slice(-16),
    uid: uid.name + " <" + uid.email + ">",
  };
}

/**
 * 读密钥记录（本机有钥匙时的元信息，不解密）。
 * @returns {{ alg: string, cipher: string, fingerprint: string, keyId: string, uid: string,
 *   email: string, createdAt: string, published: object|null } | null}
 */
export function readKeyRecord(dataDir) {
  const rec = readRawRecord(dataDir);
  if (!rec || !rec.cipher) return null;
  return {
    alg: String(rec.alg || ""),
    cipher: String(rec.cipher),
    fingerprint: String(rec.fingerprint || ""),
    keyId: String(rec.fingerprint || "").slice(-16),
    createdAt: String(rec.createdAt || rec.updatedAt || ""),
    published: normalizePublished(rec.published),
  };
}

/**
 * 原样读回密钥快照（密文、公钥、非机密记录），不解析。
 * 专供「生成时上传」的回滚：上传失败要把本地整体退回发布前状态。
 * @returns {{ key: Buffer|null, pub: string|null, record: object|null }}
 */
export function snapshotKeyFiles(dataDir) {
  let key = null;
  try {
    key = fs.readFileSync(keyFilePath(dataDir));
  } catch {
    key = null;
  }
  let pub = null;
  try {
    pub = fs.readFileSync(pubkeyFilePath(dataDir), "utf8");
  } catch {
    pub = null;
  }
  return { key, pub, record: getRecord(dataDir, RECORD_KEY) };
}

/**
 * 把快照写回（null = 快照时本就不存在，回滚时删掉它）。
 */
export function restoreKeyFiles(dataDir, snap) {
  const s = snap || {};
  if (s.key) writeFileAtomic(keyFilePath(dataDir), s.key);
  else {
    try {
      fs.unlinkSync(keyFilePath(dataDir));
    } catch {
      /* 本来就没有 */
    }
  }
  if (s.pub !== null && s.pub !== undefined) writeFileAtomic(pubkeyFilePath(dataDir), s.pub);
  else {
    try {
      fs.unlinkSync(pubkeyFilePath(dataDir));
    } catch {
      /* 本来就没有 */
    }
  }
  if (s.record) setRecord(dataDir, RECORD_KEY, s.record);
  else deleteRecord(dataDir, RECORD_KEY);
}

/**
 * 保存密钥：私钥用自包含信封加密落 gpg.key.bin，公钥明文落 gpg.key.pub.asc，元信息进 settings 的 gpg 行。
 *
 * 轮换时把既有的发布状态带过去：那把钥匙还没从账号上删掉，它的 key_id 与待清理清单是接着要用的信息。
 *
 * @returns {{ fingerprint: string, keyId: string, uid: string, protection: string }}
 */
export async function saveKey({ dataDir, privateKeyArmored, publicKeyArmored, fingerprint }) {
  // 信封加密要读钥匙环拿 KEK；钥匙环不可用/被锁会在这里抛出明确错误，绝不写明文。
  const cipher = (await sealSelfContained(privateKeyArmored)).toString("base64");
  writeRawRecord(dataDir, {
    alg: ENVELOPE_ALG,
    cipher,
    fingerprint: String(fingerprint || ""),
  });
  writeFileAtomic(pubkeyFilePath(dataDir), publicKeyArmored.endsWith("\n") ? publicKeyArmored : publicKeyArmored + "\n");
  return { fingerprint, protection: ENVELOPE_ALG };
}

/**
 * 解密读私钥（仅 App 侧需要时用；签名走 shim，不经这里）。
 * @returns {Promise<string|null>} armored 私钥；无密钥/解不开返回 null
 */
export async function loadPrivateKeyArmored(dataDir) {
  const dir = dataDir || "";
  const rec = readKeyRecord(dir);
  if (!rec) return null;
  if (rec.alg && rec.alg !== ENVELOPE_ALG) return null;
  const raw = readCipherBuffer(dir);
  if (!raw || raw.length === 0) return null;
  try {
    return (await openSelfContained(raw)).toString("utf8");
  } catch {
    return null;
  }
}

/** 读活动公钥（明文）。 */
export function loadPublicKeyArmored(dataDir) {
  try {
    return fs.readFileSync(pubkeyFilePath(dataDir), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 给设置页/状态端点看的密钥信息（纯读本地文件，不发网络请求）。
 */
export async function keyInfo(dataDir) {
  const rec = readKeyRecord(dataDir);
  if (!rec) {
    return { hasKey: false, fingerprint: null, keyId: null, uid: null, email: null, createdAt: null, protection: null, pubkey: null };
  }
  const pubkey = loadPublicKeyArmored(dataDir);
  let uid = null;
  if (pubkey) {
    try {
      const key = await openpgp.readKey({ armoredKey: pubkey });
      uid = key.getUserIDs()[0] || null;
    } catch {
      uid = null;
    }
  }
  const email = uid ? (/<([^>]+)>/.exec(uid) || [])[1] || null : null;
  return {
    hasKey: true,
    fingerprint: rec.fingerprint || null,
    keyId: rec.keyId || null,
    uid,
    email,
    createdAt: rec.createdAt || null,
    protection: rec.alg || null,
    pubkey: pubkey || null,
  };
}

/**
 * 清除本地密钥：私钥密文、活动公钥，以及 settings 的 gpg 元信息行。
 * **不动 gpg-published 行**（理由见 gpg-publish.js）。
 */
export function clearKey(dataDir) {
  writeRawRecord(dataDir, null);
  try {
    fs.unlinkSync(pubkeyFilePath(dataDir));
  } catch {
    /* 本来就没有 */
  }
}

// ─────────────────────── GitHub 发布状态（settings 表的 gpg-published 行） ───────────────────────

/** 读发布状态；没有记录 → null。 */
export function readPublished(dataDir) {
  const row = getRecordRow(dataDir, PUBLISHED_KEY);
  if (!row) return null;
  const p = normalizePublished(row.value);
  if (!p) return null;
  return { ...p, uploadedAt: row.updatedAt || "" };
}

/** 写发布状态；传 null 表示清掉它。只动这一行。 */
export function writePublished(dataDir, rec) {
  const published = normalizePublished(rec);
  if (!published) {
    deleteRecord(dataDir, PUBLISHED_KEY);
    return null;
  }
  setRecord(dataDir, PUBLISHED_KEY, published);
  return published;
}
