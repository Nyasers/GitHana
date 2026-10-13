// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/pubkey.js — 活动公钥的数据读取（无界面）。
 *
 * 读 App 数据目录（dataDir）里的活动公钥 + 隔离 gitconfig，给两处复用：
 *   - lib/routes/status.js  状态快照里的 pubkey 字段
 *   - lib/routes/actions.js 设置页的「公钥 / 密钥 ID / 身份」与复制/查看
 *
 * 用户侧的查看/复制界面只有一处：设置页「隔离 GPG 签名身份」区块（默认展示密钥 ID 与 UID；
 * 完整指纹走二级显示，点「查看指纹」才展开）。这里另外附上 GitHub 侧的**发布状态**
 * （lib/gpg-publish.js 的 publishedInfo，纯读本地文件不发网络请求），
 * 让设置页一次拿到「本地有哪把钥匙 / 它有没有传到 GitHub」。早先还有个
 * 「公钥复制卡」在会话流里渲染（工具返回 details.card → 宿主挂 ui/pubkey.html →
 * 卡页 fetch 本文件的 /pubkey 端点），现已连同 ui/pubkey.html 与 registerPubkeyRoutes
 * 一并撤掉：同一件事维护两个界面不划算，且那条卡路由带 ?ts= 查询串，与当前宿主的
 * 卡路由校验（禁止 query）相抵。
 *
 * 公钥非敏感（本来就要公开上传），私钥永不触碰。
 */
import fs from "node:fs";
import path from "node:path";
import { publishedInfo } from "../gpg-publish.js";
import { PUBKEY_FILE } from "../openpgp-key.js";

/**
 * 简单 gitconfig（INI 形）键值读取：section 如 [user]，key 如 signingkey；值去引号。读不到返回 ""。
 */
export function readGitConfigValue(cfgPath, section, key) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return "";
  }
  const wantSection = String(section || "").toLowerCase();
  const wantKey = String(key || "").toLowerCase();
  let cur = "";
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      cur = secMatch[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = line.slice(eq + 1).trim();
    if (cur === wantSection && k === wantKey) {
      const m = /^"(.*)"$/.exec(v);
      return m ? m[1] : v;
    }
  }
  return "";
}

/**
 * 组装公钥数据：读 dataDir 活动公钥 + 隔离 gitconfig（fingerprint/keyId/uid）+ GitHub 发布状态。
 * 文件不存在/读失败 → { hasKey:false, published:… }（调用方渲染空态引导）。
 *
 * 注意 `published` 是**本地发布记录**（本 App 上次传到 GitHub 的那把），不代表此刻
 * GitHub 侧一定还在——真实核对发生在上传/移除动作里（见 lib/gpg-publish.js）。
 */
export function collectPubkeyData(dataDir) {
  if (!dataDir) return { hasKey: false, published: false };
  const published = publishedInfo(dataDir);
  let pubkey = "";
  try {
    pubkey = fs.readFileSync(path.join(dataDir, PUBKEY_FILE), "utf8").trim();
  } catch {
    pubkey = "";
  }
  if (!pubkey) return { hasKey: false, published: published.published, publishedInfo: published };

  const cfgPath = path.join(dataDir, "gitconfig");
  const fpr = readGitConfigValue(cfgPath, "user", "signingkey").trim();
  const name = readGitConfigValue(cfgPath, "user", "name").trim();
  const email = readGitConfigValue(cfgPath, "user", "email").trim();
  const data = { hasKey: true, pubkey: pubkey, published: published.published, publishedInfo: published };
  if (fpr) {
    data.fpr = fpr;
    // 密钥 ID（长 ID）：完整指纹末 16 位十六进制，与 GitHub「GPG keys」页面的展示形态一致。
    data.keyId = fpr.slice(-16);
  }
  if (name || email) data.uid = name ? (email ? name + " <" + email + ">" : name) : email;
  return data;
}
