// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/openpgp-key.js — 隔离签名密钥（OpenPGP.js 实现，不用 GnuPG keyring）。
 *
 * ## 为什么用纯 JS 的 OpenPGP.js 而不是 gpg 二进制
 *
 * 本 App 只需要在隔离环里生成一把 ed25519 密钥并签 commit。用纯 JS 实现后，包体只需一份
 * 约 395 KB 的库文件（随包 GnuPG 压缩后约 5.45 MB），三平台同一实现（无需「macOS 靠系统 gpg」
 * 这一层），也就不需要 GNUPGHOME 隔离、gpgconf.ctl 删除、gpg-agent/scdaemon 收尾——那套机制
 * 存在的唯一理由就是「让 gpg 认隔离环」，用不到 gpg 了它们自然也不需要。
 *
 * ## 密钥存储（文件放密文与公钥，元信息进 settings 表）
 *
 *   <dataDir>/gpg.key.bin       DPAPI 加密的私钥密文（shim 与 App 都按路径直读）
 *   <dataDir>/gpg.key.pub.asc   活动公钥（armored 明文；本来就要公开上传）
 *   settings 表的 gpg 行        非机密元信息（指纹等），写回时取行的 updated_at
 *   settings 表的 gpg-published 行  GitHub 发布状态（见下）
 *
 * 私钥经 DPAPI（CurrentUser）保护，密文与当前用户绑定。签名时由 shim
 * （tools/lib/gpg.shim.mjs）解密使用，私钥不经过 App 进程的返回路径。
 *
 * 不另存 keyId / uid / email / createdAt：keyId 由指纹末 16 位得出，uid / email 从公钥本身
 * 解析，createdAt 取 gpg 行的 updated_at。少存一份就少一处要跟别处对齐的状态。
 *
 * ## 为什么发布状态单独一行（gpg-published）
 *
 * 发布状态（`published`）说的是**本机这把钥匙**在 GitHub 上的对应关系：远端 key id、指纹、
 * 以及上传成功但没删掉的旧公钥（`stale[]`）。它与密钥的生成/替换是不同时机写的，单独一行，
 * 每次读写发布状态就不必读改写整条密钥记录。上传时间取该行的 updated_at。
 *
 * `gpg.key.pub.asc` 里的公钥是这把钥匙的公开一半，内容必须是 armored PGP 文本（gpg
 * `--armor --export` 的标准形态，也是 GitHub 接口 `armored_public_key` 要的东西），
 * 故按内容取 `.asc` 而不是 `.json`。
 *
 * ## 本地已无密钥但仍有待清理发布状态的情形
 *
 * 移除密钥后若还有旧公钥没删干净，settings 的 gpg-published 行会继续保留待清理清单
 * （gpg 行与密文则已随密钥清掉）：本地确实没有钥匙了，但那份待清理清单不能丢，否则账号上
 * 会留下再也没人清理的钥匙。「本机有没有密钥」只看 gpg 行与密文在不在，与这一行无关。
 *
 * ## 邮箱语义（一条硬约束）
 *
 * 密钥 UID 邮箱必须等于提交作者邮箱（noreply 格式），否则 GitHub 不判 verified。
 * 生成时强制用该邮箱，不另设参数。
 */
import fs from "node:fs";
import path from "node:path";
import * as openpgp from "openpgp";
import { dpapiAvailable, dpapiProtect, dpapiUnprotect } from "./dpapi.js";
import { getRecord, getRecordRow, setRecord, deleteRecord } from "./db.js";

/** 私钥密文（DPAPI 二进制；shim 与 App 都按路径读它） */
const CIPHER_FILE = "gpg.key.bin";
/** 非机密记录进 settings 表，key 固定为 gpg */
const RECORD_KEY = "gpg";
/** 发布状态单独一行：它与密钥的生成/替换是不同时机写的，不该每次读改写整条密钥记录。 */
const PUBLISHED_KEY = "gpg-published";
/** 活动公钥文件（armored 明文） */
export const PUBKEY_FILE = "gpg.key.pub.asc";
/** 后端标识（与 lib/secret.js 的 alg 同口径） */
const DPAPI_ALG = "dpapi-current-user";

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

/** 读私钥密文（base64）；没有文件 → null。 */
function readCipherB64(dataDir) {
  try {
    return fs.readFileSync(keyFilePath(dataDir)).toString("base64");
  } catch {
    return null;
  }
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
    // GitHub 的数字 id（不是 OpenPGP key id）
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
 * 传 `null`（或没有 cipher）表示密钥不存在：文件与记录都清掉（发布状态是另一行，不碰）。
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

  if (cipher) writeFileAtomic(keyFilePath(dataDir), Buffer.from(cipher, "base64"));
  else {
    try {
      fs.unlinkSync(keyFilePath(dataDir));
    } catch {
      /* 本来就没有 */
    }
  }
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
 * 没有 cipher 的记录在这里算「没有钥匙」，返回 null；发布状态是另一行（gpg-published），不在这里读。
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
    // 16 位 key id 就是指纹末 16 位，不单独存。
    keyId: String(rec.fingerprint || "").slice(-16),
    // 生成时间就是这行最后一次写入的时间。
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
 * 与 snapshotKeyFiles 配对，用于回滚失败的那次生成/轮换。
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
 * 保存密钥：私钥经 DPAPI 加密落 gpg.key.bin，公钥明文落 gpg.key.pub.asc，元信息进 settings 的 gpg 行。
 *
 * 轮换时**把既有的发布状态带过去**：那把钥匙还没从账号上删掉，它的 key_id 与待清理清单
 * 是接着要用的信息；丢了就会在账号上留下无人认领的旧公钥。
 *
 * @returns {{ fingerprint: string, keyId: string, uid: string, protection: string }}
 */
export async function saveKey({ dataDir, privateKeyArmored, publicKeyArmored, fingerprint }) {
  if (!dpapiAvailable()) {
    throw new Error("no encryption backend is available on this platform (Windows uses DPAPI; the macOS/Linux backends are still to be wired up): refusing to save the private key in plaintext.");
  }
  const cipher = dpapiProtect(privateKeyArmored);
  writeRawRecord(dataDir, {
    alg: DPAPI_ALG,
    cipher,
    fingerprint: String(fingerprint || ""),
  });
  writeFileAtomic(pubkeyFilePath(dataDir), publicKeyArmored.endsWith("\n") ? publicKeyArmored : publicKeyArmored + "\n");
  return { fingerprint, protection: DPAPI_ALG };
}

/**
 * 解密读私钥（仅 App 侧需要时用；签名走 shim，不经这里）。
 * @returns {Promise<string|null>} armored 私钥；无密钥/解不开返回 null
 */
export async function loadPrivateKeyArmored(dataDir) {
  const rec = readKeyRecord(dataDir);
  if (!rec) return null;
  if (rec.alg && rec.alg !== DPAPI_ALG) return null;
  try {
    return dpapiUnprotect(rec.cipher);
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
 * uid 与邮箱从公钥本身解析：它们就是密钥的 UID，没必要再存一份。
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
 *
 * **不动 gpg-published 行**：它讲的是这把钥匙在 GitHub 上的对应关系（待清理的旧公钥清单也在
 * 里面），与「本机有没有钥匙」是两件事。如果这里连它一起删，调用方（unpublishKey）在 clearKey
 * 与后续 writePublished 之间的任何中断（unwireGitSigning 抛错、进程被杀）都会连带丢掉那份
 * 清单，账号上就留下再也没人清理的旧公钥。所以这里只删密钥那一半，发布状态行的存续交给
 * writePublished 决定。
 */
export function clearKey(dataDir) {
  // 密钥那一半（文件 + 记录）全删；发布状态是独立的 gpg-published 行，不由这里决定存亡。
  writeRawRecord(dataDir, null);
  try {
    fs.unlinkSync(pubkeyFilePath(dataDir));
  } catch {
    /* 本来就没有 */
  }
}

// ─────────────────────── GitHub 发布状态（settings 表的 gpg-published 行） ───────────────────────

/**
 * 读发布状态；没有记录 → null。
 */
export function readPublished(dataDir) {
  const row = getRecordRow(dataDir, PUBLISHED_KEY);
  if (!row) return null;
  const p = normalizePublished(row.value);
  if (!p) return null;
  // 上传时间就是这行最后一次写入的时间。
  return { ...p, uploadedAt: row.updatedAt || "" };
}

/**
 * 写发布状态；传 `null` 表示清掉它。
 * 只动这一行：密钥记录与密文文件都不受影响。
 */
export function writePublished(dataDir, rec) {
  const published = normalizePublished(rec);
  if (!published) {
    deleteRecord(dataDir, PUBLISHED_KEY);
    return null;
  }
  setRecord(dataDir, PUBLISHED_KEY, published);
  return published;
}
