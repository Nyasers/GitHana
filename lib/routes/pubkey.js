// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/pubkey.js — 活动公钥的数据读取（无界面）。
 *
 * 读 App 数据目录（dataDir）里的活动公钥 + 隔离 gitconfig，给两处复用：
 *   - lib/routes/status.js  状态快照里的 pubkey 字段
 *   - lib/routes/actions.js 设置页的「公钥 / 完整指纹 / 身份」与复制/查看
 *
 * 用户侧的查看/复制界面只有一处：设置页「隔离 GPG 签名身份」区块。早先还有个
 * 「公钥复制卡」在会话流里渲染（工具返回 details.card → 宿主挂 ui/pubkey.html →
 * 卡页 fetch 本文件的 /pubkey 端点），现已连同 ui/pubkey.html 与 registerPubkeyRoutes
 * 一并撤掉：同一件事维护两个界面不划算，且那条卡路由带 ?ts= 查询串，与当前宿主的
 * 卡路由校验（禁止 query）相抵。
 *
 * 公钥非敏感（本来就要公开上传），私钥永不触碰。
 */
import fs from "node:fs";
import path from "node:path";

/** 活动公钥文件名（密钥生成落盘固定名，轮换覆盖为最新） */
export const PUBKEY_FILE = "github-toolkit-gpg-pubkey.asc";

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
 * 组装公钥数据：读 dataDir 活动公钥 + 隔离 gitconfig（fingerprint/uid）。
 * 文件不存在/读失败 → { hasKey:false }（调用方渲染空态引导）。
 */
export function collectPubkeyData(dataDir) {
  if (!dataDir) return { hasKey: false };
  let pubkey = "";
  try {
    pubkey = fs.readFileSync(path.join(dataDir, PUBKEY_FILE), "utf8").trim();
  } catch {
    pubkey = "";
  }
  if (!pubkey) return { hasKey: false };

  const cfgPath = path.join(dataDir, "gitconfig");
  const fpr = readGitConfigValue(cfgPath, "user", "signingkey").trim();
  const name = readGitConfigValue(cfgPath, "user", "name").trim();
  const email = readGitConfigValue(cfgPath, "user", "email").trim();
  const data = { hasKey: true, pubkey: pubkey };
  if (fpr) data.fpr = fpr;
  if (name || email) data.uid = name ? (email ? name + " <" + email + ">" : name) : email;
  return data;
}
