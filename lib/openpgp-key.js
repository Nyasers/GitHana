// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/openpgp-key.js — 隔离签名密钥（OpenPGP.js 实现，替代 GnuPG keyring）。
 *
 * ## 为什么换掉 gpg 二进制
 *
 * 原先随包 5.45 MB（压缩后）的 GnuPG，只为在隔离环里生成一把 ed25519 密钥并签 commit。
 * 换成纯 JS 后：包体降到约 1/4，三平台同一实现（不再有「macOS 靠系统 gpg」这一层），
 * 且 GNUPGHOME 隔离、gpgconf.ctl 删除、gpg-agent/scdaemon 收尾整块消失——那套机制存在的
 * 唯一理由就是「让 gpg 认隔离环」，gpg 不在了它们自然也不需要。
 *
 * ## 密钥存储（两个文件，各写各的事）
 *
 *   <dataDir>/gpg.key.json      本机这把钥匙的记录：DPAPI 加密的私钥 + 非机密元信息
 *                               + 它在 GitHub 侧的发布状态（见下）
 *   <dataDir>/gpg.key.pub.asc   活动公钥（armored 明文；本来就要公开上传）
 *
 * 私钥经 DPAPI（CurrentUser）保护——**比原先的 gpg 环更严**：那个环是无口令私钥包
 * （gpg-agent 的明文 S-表达式），只靠文件 ACL；现在密文与当前用户绑定。
 * 签名时由 shim（tools/lib/gpg.shim.mjs）解密使用，私钥不经过 App 进程的返回路径。
 *
 * ## 为什么发布状态并进 gpg.key.json
 *
 * 发布状态（`published`）说的是**本机这把钥匙**在 GitHub 上的对应关系：远端 key_id、
 * 上传时间、以及上传成功但没删掉的旧公钥（`stale[]`）。它是这把钥匙的属性，不是独立的
 * 一类东西，所以跟密钥记录同处一份，而不是单开一个文件——单开会让「本地有哪把钥匙」与
 * 「它传到哪去了」变成两处要各自保持一致的状态。
 *
 * `gpg.key.pub.asc` 里的公钥是这把钥匙的公开一半，内容必须是 armored PGP 文本（gpg
 * `--armor --export` 的标准形态，也是 GitHub 接口 `armored_public_key` 要的东西），
 * 故按内容取 `.asc` 而不是 `.json`。
 *
 * ## 记录里没有密钥但仍有 `published` 的情形
 *
 * 移除密钥后若还有旧公钥没删干净，记录会以「只有 published」的形态留着（无 cipher）：
 * 本地确实没有钥匙了，但那份待清理清单不能丢，否则账号上会留下再也没人清理的钥匙。
 * 这种记录对「本机有没有密钥」的问题答「没有」（判据是 cipher 在不在）。
 *
 * ## 邮箱语义（沿用旧实现的约束）
 *
 * 密钥 UID 邮箱必须等于提交作者邮箱（noreply 格式），否则 GitHub 不判 verified。
 * 生成时强制用该邮箱，不另设参数。
 */
import fs from "node:fs";
import path from "node:path";
import * as openpgp from "openpgp";
import { dpapiAvailable, dpapiProtect, dpapiUnprotect } from "./dpapi.js";
import { getRecord, setRecord, deleteRecord } from "./db.js";

/** 私钥密文（DPAPI 二进制；shim 与 App 都按路径读它） */
const CIPHER_FILE = "gpg.key.bin";
/** 非机密记录进 settings 表，key 固定为 gpg */
const RECORD_KEY = "gpg";
/** 活动公钥文件（armored 明文） */
export const PUBKEY_FILE = "gpg.key.pub.asc";
/** 后端标识（与 lib/secret.js 的 alg 同口径） */
const DPAPI_ALG = "dpapi-current-user";
/** 记录格式版本（旧值，已不再写入） */

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
 * 合成一份记录：密文来自二进制文件，其余来自 settings 表。
 * 文件与库都空 → null（对调用方就是「没有这把钥匙」）。
 */
function readRawRecord(dataDir) {
  const cipher = readCipherB64(dataDir);
  const stored = getRecord(dataDir, RECORD_KEY);
  if (!cipher && !stored) return null;
  const meta = stored && typeof stored === "object" ? stored : {};
  return { ...meta, ...(cipher ? { cipher } : {}) };
}

/** 归一化发布状态：远端那把钥匙的编号、时间与待清理清单。 */
function normalizePublished(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    // GitHub 的数字 id（不是 OpenPGP key id）
    id: raw.id ? String(raw.id) : raw.keyId ? String(raw.keyId) : "",
    fingerprint: raw.fingerprint ? String(raw.fingerprint) : "",
    uploadedAt: raw.uploadedAt ? String(raw.uploadedAt) : "",
    stale: Array.isArray(raw.stale)
      ? raw.stale
          .map((e) => ({ id: String((e && (e.id || e.keyId)) || ""), fingerprint: String((e && e.fingerprint) || "") }))
          .filter((e) => e.id)
      : [],
  };
}

/**
 * 写回记录：密文写二进制文件，其余进 settings 表。
 * 传 `null`（或既无 cipher 又无 published）表示两者都清掉。
 */
function writeRawRecord(dataDir, rec) {
  const cipher = rec && rec.cipher ? String(rec.cipher) : null;
  const meta = rec ? { ...rec } : null;
  if (meta) delete meta.cipher;

  const empty = !cipher && !(meta && meta.published);
  if (empty) {
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
 * 没有 cipher 的记录（只剩待清理的发布状态）在这里算「没有钥匙」，返回 null。
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
    createdAt: String(rec.createdAt || ""),
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
 * 把快照写回（null = 原先不存在，回滚时删掉它）。
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
 * 保存密钥：私钥经 DPAPI 加密落 gpg.key.json，公钥明文落 gpg.key.pub.asc。
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
  const prev = readRawRecord(dataDir);
  writeRawRecord(dataDir, {
    alg: DPAPI_ALG,
    cipher,
    fingerprint: String(fingerprint || ""),
    createdAt: new Date().toISOString(),
    published: prev && prev.published ? prev.published : null,
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
 * 清除本地密钥：私钥与活动公钥。
 *
 * **不动 `published`**：它讲的是这把钥匙在 GitHub 上的对应关系（待清理的旧公钥清单也在里面），
 * 与「本机有没有钥匙」是两件事。如果这里把整个记录文件删掉，调用方（unpublishKey）在
 * clearKey 与后续 writePublished 之间的任何中断（unwireGitSigning 抛错、进程被杀）都会
 * 连带丢掉那份清单，账号上就留下再也没人清理的旧公钥。所以只摘掉钥匙那一半，
 * 记录本身是否存续交给 writePublished 决定。
 */
export function clearKey(dataDir) {
  const raw = readRawRecord(dataDir);
  // 只留 published；cipher 与元信息全部摘掉。两者都没时 writeRawRecord 会把文件删掉。
  const keep = raw && raw.published ? { published: raw.published } : null;
  writeRawRecord(dataDir, keep);
  try {
    fs.unlinkSync(pubkeyFilePath(dataDir));
  } catch {
    /* 本来就没有 */
  }
}

// ─────────────────────── GitHub 发布状态（存在密钥记录里） ───────────────────────

/**
 * 读发布状态；没有记录 → null。
 * @returns {{ keyId: string, fingerprint: string, uploadedAt: string, login: string,
 *   gpgKeyId: string, name: string, stale: {keyId: string, fingerprint: string}[] } | null}
 */
export function readPublished(dataDir) {
  const rec = readRawRecord(dataDir);
  return rec ? normalizePublished(rec.published) : null;
}

/**
 * 写发布状态；传 `null` 表示清掉它。
 *
 * 只动 `published` 一个字段，其余（私钥密文、指纹、身份）原样留着。密钥已经被清掉、
 * 只剩待清理清单时，记录以「只有 published」的形态存续——那份清单不能丢。
 */
export function writePublished(dataDir, rec) {
  const raw = readRawRecord(dataDir);
  const published = normalizePublished(rec);
  const next = { ...(raw || {}), published };
  return writeRawRecord(dataDir, next);
}
