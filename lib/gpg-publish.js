// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/gpg-publish.js — 隔离 GPG 公钥在 GitHub 账号上的发布与轮换。
 *
 * ## 只碰自己那把（本文件最重要的一条）
 *
 * 账号级 `GPG keys: write` 能删账号上**任意** GPG 公钥，包括用户个人的正主密钥。
 * 因此本模块的删除路径只有一条：删 `published-gpg-keys.json` 里记下的那一个 key_id。
 * **绝不** `GET` 全量列表后按名字/指纹模糊匹配批量删除——名称可由用户或其它工具改写，
 * 匹配失败会漏删、匹配过宽会误删。
 *
 * 被拒绝的方案：按 key 名称（如 `GitHana`）匹配删除。名称只用来**上传**时标识这把钥匙。
 *
 * ## 发布状态文件
 *
 * `<dataDir>/published-gpg-keys.json`：`{ keyId, fingerprint, uploadedAt, login, gpgKeyId }`
 *   - `keyId`     GitHub 侧的数字 id（`DELETE /user/gpg_keys/{keyId}` 的目标），字符串存
 *   - `fingerprint` OpenPGP 完整指纹（本地隔离环里的那把）
 *   - `gpgKeyId`  GitHub 页面展示的 16 位长 key id（= fingerprint 末 16 位），仅供显示
 *
 * ## 轮换流程
 *
 *   1. 读记录；若有 `keyId`，先 `GET /user/gpg_keys` 核对它是否仍在（用户可能已在
 *      GitHub 侧手动删掉）——**以 GitHub 侧为准**，不在就更新本地记录再继续；
 *   2. `DELETE /user/gpg_keys/{keyId}`；404 视为「已不存在」，继续；
 *   3. `POST /user/gpg_keys`（body `{ name, armored_public_key }`）上传新公钥；
 *   4. 写回记录。
 *
 * ## 错误映射（AC11 / AC12 / AC13）
 *
 *   403 → 「App 未授予 GPG keys: write」+ 指向 App 权限设置页，不重试、不静默
 *   422 → 原样透出 GitHub 的报错 + 「该邮箱需为账号已验证邮箱」
 *   无 OAuth 凭据 → 「需先完成 GitHub App 授权」（不用 PAT 尝试：PAT 通常没有 gpg_keys 权限）
 *
 * ## 调用方
 *
 *   - tools/gpg-keygen.js：密钥生成成功后自动上传（失败只报告，不中断本地签名链路）
 *   - lib/routes/actions.js：设置页的「上传公钥」「从 GitHub 移除」两个手动按钮
 *
 * GitHub 域调用走自写 REST 通道（tools/lib/rest.js），不经 gh CLI。
 */
import fs from "node:fs";
import path from "node:path";
import { callRest, apiRoot, errorDetail } from "../tools/lib/rest.js";
import { getToolDataDir, getToolOAuthMeta, getToolSecretToken } from "../tools/lib/context.js";

/** 发布状态文件名 */
const PUBLISHED_FILE = "published-gpg-keys.json";

/** 上传时给这把钥匙的名字（固定可识别串；**不**用于删除匹配，删除只认记录里的 keyId）。 */
export const PUBLISH_NAME = "GitHana";

/** App 权限设置页（403 时引导用户去补 GPG keys: write）。 */
const APP_SETTINGS_URL = "https://github.com/organizations/Nyasers/settings/apps/githana-app";

// ─────────────────────────── 发布状态文件 ───────────────────────────

/** <dataDir>/published-gpg-keys.json */
export function publishedFilePath(dataDir) {
  return path.join(dataDir || getToolDataDir() || "", PUBLISHED_FILE);
}

/**
 * 读发布状态；文件不存在/损坏 → null。
 * @returns {{ keyId: string, fingerprint: string, uploadedAt: string, login: string, gpgKeyId?: string } | null}
 */
export function readPublished(dataDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(publishedFilePath(dataDir), "utf8"));
    if (!rec || typeof rec !== "object") return null;
    return {
      keyId: rec.keyId ? String(rec.keyId) : "",
      fingerprint: rec.fingerprint ? String(rec.fingerprint) : "",
      uploadedAt: rec.uploadedAt ? String(rec.uploadedAt) : "",
      login: rec.login ? String(rec.login) : "",
      gpgKeyId: rec.gpgKeyId ? String(rec.gpgKeyId) : "",
    };
  } catch {
    return null;
  }
}

/** 原子写发布状态（先写临时文件再 rename）；传 null 表示删除记录。 */
export function writePublished(dataDir, rec) {
  const dir = dataDir || getToolDataDir();
  const target = publishedFilePath(dir);
  if (!rec) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* 本来就没有记录 */
    }
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const clean = {
    keyId: String(rec.keyId || ""),
    fingerprint: String(rec.fingerprint || ""),
    uploadedAt: String(rec.uploadedAt || ""),
    login: String(rec.login || ""),
    gpgKeyId: String(rec.gpgKeyId || ""),
  };
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, target);
  return clean;
}

// ─────────────────────────── REST 封装 ───────────────────────────

/**
 * 调一次 api.github.com 的端点（会带本 App 的 OAuth 令牌）。
 * 返回 { ok, status, json, text, error }——与 lib/oauth.js 消费的形状一致。
 */
async function ghApi(one, options = {}) {
  const r = await callRest([one], { timeoutSec: 60, ...options });
  if (!r.ok) return { ok: false, status: null, json: null, text: "", error: r.message };
  return r.results[0] || { ok: false, status: null, json: null, text: "", error: "无结果" };
}

// ─────────────────────────── 凭据前置检查 ───────────────────────────

/**
 * 发布动作的前置检查：没有可用 OAuth 凭据就直接拒绝。
 * 不用 PAT 尝试——PAT 通常没有 `gpg_keys` 权限，试了只会得到一堆 403。
 * @returns {string | null} 可读错误；null = 可以继续
 */
export function publishPrecondition() {
  // 先看 needsReauth：这种情况进程内令牌已被清空，但「重新授权」比「没授权」更准确，
  // 也更接近用户实际需要做的动作。
  const meta = getToolOAuthMeta();
  if (meta && meta.needsReauth === true) {
    return "需重新授权：上次令牌刷新失败（refresh_token 已失效或授权被撤销），请到设置页重新点「用 GitHub 登录」。";
  }
  if (!getToolSecretToken()) {
    return "需先完成 GitHub App 授权：当前没有可用的 OAuth 凭据，无法访问账号级 GPG 公钥接口。请到设置页点「用 GitHub 登录」。";
  }
  return null;
}

// ─────────────────────────── GitHub GPG 接口 ───────────────────────────

/**
 * 列出账号上的 GPG 公钥。**只用于核对**记录里的 keyId 是否还在，
 * 绝不据此做任何批量删除。
 */
async function listUserGpgKeys() {
  const r = await ghApi({ url: apiRoot("/user/gpg_keys"), paginate: true, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, keys: [], status: r.status, r };
  return { ok: true, keys: Array.isArray(r.json) ? r.json : [], r };
}

/** 上传公钥：POST /user/gpg_keys（多行 armored key 走 JSON 体，不拼 argv）。 */
async function uploadGpgKey({ name, armoredPublicKey }) {
  return ghApi({
    method: "POST",
    url: apiRoot("/user/gpg_keys"),
    json: { name, armored_public_key: armoredPublicKey },
    timeoutMs: 60_000,
  });
}

/** 删除公钥：DELETE /user/gpg_keys/{id}。 */
async function deleteGpgKey(keyId) {
  return ghApi({
    method: "DELETE",
    url: apiRoot("/user/gpg_keys/" + encodeURIComponent(String(keyId))),
    timeoutMs: 60_000,
  });
}

/** 把 GitHub 的失败响应翻成可读文案（AC11 / AC12）。 */
function mapFailure(status, detail) {
  if (status === 403) {
    return (
      "GitHub 拒绝（403）：本 App 未被授予 `GPG keys: write` 权限。" +
      "请到 App 权限设置页确认该权限为 Read and write，并重新批准安装：" + APP_SETTINGS_URL +
      "\nGitHub 原文：" + detail
    );
  }
  if (status === 422) {
    return (
      "GitHub 拒绝（422）：公钥被拒绝。" + detail +
      "\n该邮箱需为账号已验证邮箱——公钥 UID 里的邮箱必须是本账号已通过验证的邮箱，" +
      "否则 GitHub 不接受这把钥匙。"
    );
  }
  if (status === 401) {
    return "GitHub 拒绝（401）：OAuth 令牌无效或已过期，请到设置页重新授权。\nGitHub 原文：" + detail;
  }
  if (status === 404) {
    return "GitHub 返回 404：目标资源不存在。\nGitHub 原文：" + detail;
  }
  return `GitHub 调用失败${status ? `（HTTP ${status}）` : ""}：${detail}`;
}

// ───────────────────────────── 发布 / 移除 ─────────────────────────────

/**
 * 发布（或轮换）公钥。
 *
 * @param {{ dataDir?: string, pubkeyArmored: string, fingerprint?: string, login?: string }} args
 * @returns {Promise<{ ok: boolean, keyId?: string, gpgKeyId?: string, fingerprint?: string,
 *   uploadedAt?: string, login?: string, replaced?: string|null, message: string }>}
 */
export async function publishKey({ dataDir, pubkeyArmored, fingerprint, login } = {}) {
  const dir = dataDir || getToolDataDir();
  const armored = String(pubkeyArmored || "").trim();
  const fpr = String(fingerprint || "").trim();
  const pre = publishPrecondition();
  if (pre) return { ok: false, message: pre };
  if (!armored) {
    return { ok: false, message: "没有可上传的公钥：请先生成隔离 GPG 密钥。" };
  }

  const prev = readPublished(dir);
  let replacedKeyId = null;

  // 1) 先核对：记录里的 keyId 是否还在 GitHub 上（用户可能已手动删过）。
  //    以 GitHub 侧为准——不在就把本地记录里的 keyId 清掉，再走上传。
  if (prev && prev.keyId) {
    const listed = await listUserGpgKeys();
    if (!listed.ok) {
      return {
        ok: false,
        message:
          "发布前置核对失败：无法读取账号 GPG 公钥列表（不会盲删）。" +
          mapFailure(listed.status, errorDetail(listed)),
      };
    }
    const stillThere = listed.keys.some((k) => String(k && k.id) === String(prev.keyId));
    if (stillThere) {
      // 2) 只删本 App 上次上传的那一个 key_id；404 视为已不存在，继续上传。
      const del = await deleteGpgKey(prev.keyId);
      if (!del.ok && del.status !== 404) {
        return {
          ok: false,
          message: "轮换中止：删除上一把公钥失败（key_id " + prev.keyId + "）。" + mapFailure(del.status, errorDetail(del)),
        };
      }
      replacedKeyId = prev.keyId;
    } else {
      // GitHub 侧已经没有了：更新本地状态，避免下次再拿一个失效 key_id 去删。
      writePublished(dir, { ...prev, keyId: "", gpgKeyId: "" });
    }
  }

  // 3) 上传新公钥。
  const up = await uploadGpgKey({ name: PUBLISH_NAME, armoredPublicKey: armored });
  if (!up.ok) {
    return {
      ok: false,
      replaced: replacedKeyId,
      message:
        (replacedKeyId ? "上一把公钥已删除（key_id " + replacedKeyId + "），但" : "") +
        "上传新公钥失败。" + mapFailure(up.status, errorDetail(up)),
    };
  }

  const key = up.json && typeof up.json === "object" ? up.json : {};
  const keyId = key.id === undefined || key.id === null ? "" : String(key.id);
  const gpgKeyId = key.key_id ? String(key.key_id) : fpr ? fpr.slice(-16) : "";
  const uploadedAt = new Date().toISOString();
  const account = String(login || (getToolOAuthMeta() || {}).login || "");
  writePublished(dir, { keyId, fingerprint: fpr, uploadedAt, login: account, gpgKeyId });

  return {
    ok: true,
    keyId,
    gpgKeyId,
    fingerprint: fpr,
    uploadedAt,
    login: account,
    replaced: replacedKeyId,
    message:
      "公钥已上传到 GitHub 账号" + (account ? " @" + account : "") + "（key_id " + (keyId || "?") + "）" +
      (replacedKeyId ? "，上一把已移除（key_id " + replacedKeyId + "）" : "") +
      "。此后用隔离环密钥签名的提交会显示 Verified。",
  };
}

/**
 * 从 GitHub 移除本 App 上传的公钥。
 * **只删记录里的那一个 key_id**；没有记录 = 无事可做（绝不猜、绝不枚举）。
 */
export async function unpublishKey({ dataDir } = {}) {
  const dir = dataDir || getToolDataDir();
  const pre = publishPrecondition();
  if (pre) return { ok: false, removed: false, message: pre };

  const rec = readPublished(dir);
  if (!rec || !rec.keyId) {
    return { ok: true, removed: false, message: "本地没有本 App 的发布记录，未对 GitHub 做任何删除。" };
  }

  const del = await deleteGpgKey(rec.keyId);
  if (!del.ok && del.status !== 404) {
    return { ok: false, removed: false, message: "移除失败。" + mapFailure(del.status, errorDetail(del)) };
  }
  writePublished(dir, null);
  return {
    ok: true,
    removed: true,
    keyId: rec.keyId,
    message:
      del.status === 404
        ? "该公钥在 GitHub 上已不存在（key_id " + rec.keyId + "），本地发布记录已清除。"
        : "已从 GitHub 移除公钥（key_id " + rec.keyId + "），本地发布记录已清除。",
  };
}

/**
 * 给设置页看的发布状态（只读，不发网络请求）。
 * @returns {{ published: boolean, keyId: string|null, gpgKeyId: string|null,
 *   fingerprint: string|null, uploadedAt: string|null, login: string|null }}
 */
export function publishedInfo(dataDir) {
  const rec = readPublished(dataDir);
  return {
    published: !!(rec && rec.keyId),
    keyId: rec && rec.keyId ? rec.keyId : null,
    gpgKeyId: rec && (rec.gpgKeyId || rec.fingerprint) ? rec.gpgKeyId || rec.fingerprint.slice(-16) : null,
    fingerprint: rec && rec.fingerprint ? rec.fingerprint : null,
    uploadedAt: rec && rec.uploadedAt ? rec.uploadedAt : null,
    login: rec && rec.login ? rec.login : null,
  };
}
