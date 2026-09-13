// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/pubkey.js — GitHana 公钥数据路由（App v2）。
 *
 * 与 v1 的差别：v1 的 route 直接读模板注入数据返回整页 HTML（宿主按 /api/plugins/<id>/pubkey
 * 渲染会话流卡）；v2 的 details.card.route 只能指向本 App 的 ui/ 静态树，因此拆成两层：
 *
 *   工具 gpg_pubkey → details.card.route = "/pubkey.html?ts=…"
 *     → 宿主在会话流 iframe 挂 /api/apps/githana/ui/pubkey.html
 *     → 卡页 fetch /api/apps/githana/routes/pubkey 取实时数据并渲染
 *
 * 本文件只做数据端：读 App 数据目录（dataDir）里的活动公钥 + 隔离 gitconfig，返回 JSON。
 * 无外部网络，公钥非敏感（本来就要公开上传），私钥永不触碰。
 *
 * 注册方式（v2）：index.js 的 ctx.routes.register(app => registerPubkeyRoutes(app, { dataDir }))
 * → 公开 URL /api/apps/githana/routes/pubkey（app_route 鉴权：宿主登录或本 App surface 会话）。
 */
import fs from "node:fs";
import path from "node:path";

/** 活动公钥文件名（gpg_keygen 落盘固定名，轮换覆盖为最新） */
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
 * 组装卡页数据：读 dataDir 活动公钥 + 隔离 gitconfig（fingerprint/uid）。
 * 文件不存在/读失败 → { hasKey:false }（卡页渲染空态引导）。
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

/**
 * v2 registrar：把公钥数据端点挂进宿主创建的 Hono sub-app。
 * @param {import("hono").Hono} app 宿主注入的 sub-app（公开前缀 /api/apps/<id>/routes/）
 * @param {{ dataDir: string }} deps
 */
export function registerPubkeyRoutes(app, { dataDir } = {}) {
  app.get("/pubkey", (c) => c.json(collectPubkeyData(dataDir)));
}
