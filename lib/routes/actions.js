// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/actions.js — GitHana 设置页「手动档」端点（App v2）。
 *
 * 设计：手动按钮不另写一套逻辑，直接调同一份实现（`tools/gpg-keygen.js` 的 `execute`、
 * `lib/routes/pubkey.js` 的公钥读取），行为、校验、报错文案只有一份。GPG 的生成与公钥
 * 查看只在设置页，不进 Agent 工具面：生成不可逆，要用户点按钮确认。
 *
 * 端点：
 *   POST /actions/keygen    { name?, email? }  → 生成/轮换隔离 GPG 签名密钥（不可逆，UI 侧带确认）
 *   GET  /actions/gh-status                    → gh auth status（只读探测）
 *   GET  /actions/identity                     → gh api user → login / 提交邮箱 / 账号 ID
 *   GET  /actions/pubkey                       → 当前活动公钥全文（供复制；未生成返回 hasKey:false）
 *
 * 令牌的读写**不在本文件**：它走 DPAPI 加密存储（lib/secret.js），入口是
 * /routes/settings/token。这里只做只读探测与本地密钥动作。
 *
 * 注册方式：index.js 的 ctx.routes.register → /api/apps/githana/routes/actions/*
 */
import * as gpgKeygen from "../../tools/gpg-keygen.js";
import { initToolContext, getToolDataDir } from "../../tools/lib/context.js";
import { runCli } from "../../tools/lib/exec.js";
import { noreplyEmailFromUser, deriveNameFromLogin } from "../../tools/lib/identity.js";
import { collectPubkeyData } from "./pubkey.js";

/** 工具返回可能是纯字符串（v1 形态）也可能是对象；统一取文本。 */
function asText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    const first = Array.isArray(value.content) ? value.content[0] : null;
    if (first && typeof first.text === "string") return first.text;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? "" : String(value);
}

/** 从 body 里取可选字符串字段（缺省/非法 → ""）。 */
function optionalString(body, key, max = 256) {
  if (!body || typeof body !== "object") return "";
  const v = body[key];
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/** 命令输出合成可读文本。 */
function outputText(r) {
  return [r.stdout, r.stderr].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
}

/**
 * v2 registrar：把手动档端点挂进宿主创建的 Hono sub-app。
 * @param {import("hono").Hono} app
 * @param {{ appCtx: object, dataDir: string }} deps
 */
export function registerActionRoutes(app, { appCtx, dataDir } = {}) {
  // 生成 / 轮换隔离 GPG 签名密钥：调 tools/gpg-keygen.js 的实现（不可逆，UI 侧带确认）。
  app.post("/actions/keygen", async (c) => {
    let body = null;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const name = optionalString(body, "name", 160);
    const email = optionalString(body, "email", 320);
    try {
      const result = await gpgKeygen.execute({ name, email }, appCtx);
      const text = asText(result);
      const pub = collectPubkeyData(getToolDataDir() || dataDir);
      return c.json({ ok: true, text, pubkey: { present: !!pub.hasKey, fpr: pub.fpr || null, uid: pub.uid || null } });
    } catch (e) {
      return c.json({ ok: false, text: String((e && e.message) || e) }, 500);
    }
  });

  // gh 认证状态（只读）。走工具同款 runCli，因此同样继承隔离 env 与按次注入的 GH_TOKEN。
  app.get("/actions/gh-status", async (c) => {
    try {
      await initToolContext(appCtx);
      const r = await runCli("gh", ["auth", "status"], { timeoutSec: 30 });
      return c.json({ ok: r.ok, exitCode: r.exitCode, text: outputText(r) || r.message || "（无输出）" });
    } catch (e) {
      return c.json({ ok: false, text: String((e && e.message) || e) }, 500);
    }
  });

  /**
   * GitHub 身份：`gh api user` → { id, login, name }，并算出提交用的 noreply 邮箱。
   * 与 tools/gpg-keygen.js 内部推导用的是同一个纯函数（tools/lib/identity.js），两边不会跑偏。
   * 需要联网，所以只由用户点按钮触发（或 token 刚保存时跑一次），不做隐式轮询。
   */
  app.get("/actions/identity", async (c) => {
    try {
      await initToolContext(appCtx);
      const r = await runCli("gh", ["api", "user"], { timeoutSec: 30 });
      if (!r.ok) {
        return c.json({ ok: false, authenticated: false, text: outputText(r) || r.message || "gh api user 调用失败" });
      }
      let user = null;
      try {
        user = JSON.parse(r.stdout || "{}");
      } catch {
        user = null;
      }
      const id = user && user.id !== undefined && user.id !== null ? user.id : null;
      const login = user && user.login ? String(user.login) : "";
      if (!login) {
        return c.json({
          ok: false,
          authenticated: false,
          text: "gh api user 返回了无法解析的内容（未取得 login）。",
        });
      }
      return c.json({
        ok: true,
        authenticated: true,
        id,
        login,
        name: user && user.name ? String(user.name) : deriveNameFromLogin(login),
        // 公开邮箱可能为空（用户设置了私密）；提交侧用 GitHub 的 noreply 格式。
        publicEmail: user && user.email ? String(user.email) : null,
        commitEmail: id !== null ? noreplyEmailFromUser(id, login) : null,
      });
    } catch (e) {
      return c.json({ ok: false, authenticated: false, text: String((e && e.message) || e) }, 500);
    }
  });

  // 当前活动公钥全文：供设置页查看/复制。
  app.get("/actions/pubkey", async (c) => {
    try {
      await initToolContext(appCtx);
      const data = collectPubkeyData(getToolDataDir() || dataDir);
      return c.json(data);
    } catch (e) {
      return c.json({ hasKey: false, error: String((e && e.message) || e) }, 500);
    }
  });
}
