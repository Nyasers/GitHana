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
 * ## 密钥存储
 *
 *   <dataDir>/gpg-key.json        DPAPI 加密的 armored 私钥 + 非机密元信息
 *   <dataDir>/github-toolkit-gpg-pubkey.asc   活动公钥（明文；本来就要公开上传）
 *
 * 私钥经 DPAPI（CurrentUser）保护——**比原先的 gpg 环更严**：那个环是无口令私钥包
 * （gpg-agent 的明文 S-表达式），只靠文件 ACL；现在密文与当前用户绑定。
 * 签名时由 shim（tools/lib/gpg-shim.mjs）解密使用，私钥不经过 App 进程的返回路径。
 *
 * ## 与旧 gpg 环的关系
 *
 * **不做迁移**：旧 gnupg 环里的密钥直接作废（除作者外无用户）。用户重新点一次
 * 「生成密钥」即可；GitHub 上的旧公钥由 lib/gpg-publish.js 的既有轮换机制替换。
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

/** 加密私钥记录文件 */
const KEY_FILE = "gpg-key.json";
/** 活动公钥文件（沿用旧名：lib/routes/pubkey.js 与设置页按它读取） */
export const PUBKEY_FILE = "github-toolkit-gpg-pubkey.asc";
/** 后端标识（与 lib/secret.js 的 alg 同口径） */
const DPAPI_ALG = "dpapi-current-user";

/** <dataDir>/gpg-key.json */
export function keyFilePath(dataDir) {
  return path.join(dataDir || "", KEY_FILE);
}

/** <dataDir>/github-toolkit-gpg-pubkey.asc */
export function pubkeyFilePath(dataDir) {
  return path.join(dataDir || "", PUBKEY_FILE);
}

/**
 * 生成 ed25519 签名密钥。
 * @param {{ name: string, email: string }} args
 * @returns {Promise<{ privateKeyArmored: string, publicKeyArmored: string,
 *   fingerprint: string, keyId: string, uid: string }>}
 */
export async function generateSigningKey({ name, email }) {
  const uid = { name: String(name || "").trim() || String(email || "").trim(), email: String(email || "").trim() };
  if (!uid.email) throw new Error("生成密钥需要邮箱（用于 GitHub 验证签名归属）");
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
 * 读密钥记录（元信息，不解密）。
 * @returns {{ alg: string, cipher: string, fingerprint: string, keyId: string, uid: string,
 *   email: string, createdAt: string } | null}
 */
export function readKeyRecord(dataDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(keyFilePath(dataDir), "utf8"));
    if (!rec || typeof rec !== "object" || !rec.cipher) return null;
    return {
      alg: String(rec.alg || ""),
      cipher: String(rec.cipher),
      fingerprint: String(rec.fingerprint || ""),
      keyId: String(rec.keyId || ""),
      uid: String(rec.uid || ""),
      email: String(rec.email || ""),
      createdAt: String(rec.createdAt || ""),
    };
  } catch {
    return null;
  }
}

/** 原子写（先写临时文件再 rename）。 */
function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * 保存密钥：私钥经 DPAPI 加密落 gpg-key.json，公钥明文落 .asc。
 * @returns {{ fingerprint: string, keyId: string, uid: string, protection: string }}
 */
export async function saveKey({ dataDir, privateKeyArmored, publicKeyArmored, fingerprint, keyId, uid, email }) {
  if (!dpapiAvailable()) {
    throw new Error("本平台暂无可用的加密后端（Windows 用 DPAPI，macOS/Linux 后端待接）：拒绝以明文保存私钥。");
  }
  const cipher = dpapiProtect(privateKeyArmored);
  writeFileAtomic(
    keyFilePath(dataDir),
    JSON.stringify(
      {
        schemaVersion: 1,
        alg: DPAPI_ALG,
        cipher,
        fingerprint: String(fingerprint || ""),
        keyId: String(keyId || ""),
        uid: String(uid || ""),
        email: String(email || ""),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileAtomic(pubkeyFilePath(dataDir), publicKeyArmored.endsWith("\n") ? publicKeyArmored : publicKeyArmored + "\n");
  return { fingerprint, keyId, uid, protection: DPAPI_ALG };
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
 * @returns {{ hasKey: boolean, fingerprint: string|null, keyId: string|null,
 *   uid: string|null, email: string|null, createdAt: string|null, protection: string|null,
 *   pubkey: string|null }}
 */
export function keyInfo(dataDir) {
  const rec = readKeyRecord(dataDir);
  if (!rec) return { hasKey: false, fingerprint: null, keyId: null, uid: null, email: null, createdAt: null, protection: null, pubkey: null };
  const pubkey = loadPublicKeyArmored(dataDir);
  return {
    hasKey: true,
    fingerprint: rec.fingerprint || null,
    keyId: rec.keyId || null,
    uid: rec.uid || null,
    email: rec.email || null,
    createdAt: rec.createdAt || null,
    protection: rec.alg || null,
    pubkey: pubkey || null,
  };
}

/** 删除密钥（私钥记录 + 活动公钥）。 */
export function clearKey(dataDir) {
  for (const p of [keyFilePath(dataDir), pubkeyFilePath(dataDir)]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* 本来就没有 */
    }
  }
}
