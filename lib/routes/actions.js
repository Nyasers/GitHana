// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/actions.js — GitHana 设置页「手动档」端点（App v2）。
 *
 * 设计：手动按钮不另写一套逻辑，直接调同一份实现（`tools/gpg-keygen.js` 的 `execute`、
 * `lib/routes/pubkey.js` 的公钥读取、`lib/oauth.js` 的 device flow、`lib/gpg-publish.js`
 * 的公钥发布），行为、校验、报错文案只有一份。GPG 的生成与公钥查看只在设置页，不进
 * Agent 工具面：生成不可逆，要用户点按钮确认。
 *
 * 端点：
 *   POST /actions/keygen          { name?, email? }  → 生成/轮换隔离 GPG 签名密钥（不可逆，UI 侧带确认）
 *   GET  /actions/gh-status                          → gh auth status（只读探测）
 *   GET  /actions/identity                           → gh api user → login / 名字 / 提交邮箱 / 账号 ID
 *   GET  /actions/pubkey                             → 当前活动公钥全文 + GitHub 发布状态（供复制/展示）
 *   POST /actions/oauth/start     { clientId? }      → 发起 device flow → user_code / verification_uri
 *   GET  /actions/oauth/poll?id=<flowId>             → 单次查询授权结果（页面按 interval 自轮询）
 *   POST /actions/oauth/revoke                       → 退出授权（清凭据，保留 clientId）
 *   POST /actions/gpg/publish                        → 手动上传当前公钥（失败重试）
 *   POST /actions/gpg/unpublish                      → 从 GitHub 移除本 App 上传的那一把
 *   GET  /actions/gpg/status                         → 发布状态 + OAuth 凭据可用性
 *
 * 凭据的**写入**不在本文件：令牌只能由 device flow 拿到（lib/oauth.js），页面永远不接触
 * 令牌明文；这里只做只读探测、本地密钥动作与授权流程编排。
 *
 * 注册方式：app.js 的 ctx.routes.register → /api/apps/githana/routes/actions/*
 */
import * as gpgKeygen from "../../tools/gpg-keygen.js";
import { initToolContext, getToolDataDir } from "../../tools/lib/context.js";
import { runCli } from "../../tools/lib/exec.js";
import { noreplyEmailFromUser, deriveNameFromLogin, deriveNameFromUser } from "../../tools/lib/identity.js";
import { collectPubkeyData } from "./pubkey.js";
import { startDeviceFlow, pollDeviceFlow, revokeOAuth } from "../oauth.js";
import { publishKey, unpublishKey, publishedInfo, publishPrecondition } from "../gpg-publish.js";
import { readClientId } from "../secret.js";

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

/** 读 JSON 请求体；解析失败返回 {}（各端点自行决定哪些字段必填）。 */
async function readBody(c) {
  try {
    return (await c.req.json()) || {};
  } catch {
    return {};
  }
}

/**
 * v2 registrar：把手动档端点挂进宿主创建的 Hono sub-app。
 * @param {import("hono").Hono} app
 * @param {{ appCtx: object, dataDir: string }} deps
 */
export function registerActionRoutes(app, { appCtx, dataDir } = {}) {
  // ───────────────────────────── GitHub 授权（device flow） ─────────────────────────────

  /**
   * 发起 device flow：返回 user_code / verification_uri / interval / expires_in。
   * device_code 留在服务端（lib/oauth.js 的模块级 Map），不出这个进程。
   * Client ID：请求体显式值优先，否则用设置页保存的覆盖值 / 内置默认值。
   */
  app.post("/actions/oauth/start", async (c) => {
    const body = await readBody(c);
    if (body && body.clientId !== undefined && typeof body.clientId !== "string") {
      return c.json({ error: "clientId 必须是字符串" }, 400);
    }
    const explicit = optionalString(body, "clientId", 128);
    const effective = explicit || readClientId(dataDir);
    if (!effective) {
      return c.json(
        { error: "Client ID 为空：请先在设置页填写 GitHub App 的 Client ID 再点「用 GitHub 登录」。" },
        400,
      );
    }
    try {
      await initToolContext(appCtx);
      const flow = await startDeviceFlow({ clientId: effective, dataDir });
      return c.json({
        ok: true,
        flowId: flow.flowId,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        interval: flow.interval,
        expiresIn: flow.expiresIn,
      });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 400);
    }
  });

  /**
   * 单次查询授权结果。页面按 interval 自轮询，拿到 ready / error 即停。
   * flowId 不存在（进程重启 / 已被消费）→ 404，页面提示重新发起。
   */
  app.get("/actions/oauth/poll", async (c) => {
    const id = String(c.req.query("id") || "").trim();
    if (!id) return c.json({ error: "缺少查询参数 id（flowId）" }, 400);
    try {
      await initToolContext(appCtx);
      const result = await pollDeviceFlow(id);
      if (result.status === "not_found") {
        return c.json(
          { status: "not_found", message: "授权流程不存在或已失效（App 可能重启过），请重新点「用 GitHub 登录」。" },
          404,
        );
      }
      return c.json(result);
    } catch (e) {
      return c.json({ status: "error", message: String((e && e.message) || e) }, 500);
    }
  });

  /** 退出授权：清 OAuth 凭据（clientId 覆盖值保留，重新登录不必重填）。 */
  app.post("/actions/oauth/revoke", async (c) => {
    try {
      await initToolContext(appCtx);
      await revokeOAuth({ dataDir });
      return c.json({ ok: true, tokenConfigured: false });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  // ───────────────────────────── 隔离 GPG 密钥 ─────────────────────────────

  // 生成 / 轮换隔离 GPG 签名密钥：调 tools/gpg-keygen.js 的实现（不可逆，UI 侧带确认）。
  // 生成成功后 gpg-keygen 内部会尝试自动上传公钥（见 lib/gpg-publish.js），结果在返回文本里。
  app.post("/actions/keygen", async (c) => {
    const body = await readBody(c);
    const name = optionalString(body, "name", 160);
    const email = optionalString(body, "email", 320);
    try {
      await initToolContext(appCtx);
      const result = await gpgKeygen.execute({ name, email }, appCtx);
      const text = asText(result);
      const dir = getToolDataDir() || dataDir;
      const pub = collectPubkeyData(dir);
      return c.json({
        ok: true,
        text,
        pubkey: { present: !!pub.hasKey, fpr: pub.fpr || null, keyId: pub.keyId || null, uid: pub.uid || null },
        published: publishedInfo(dir),
      });
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
   * 与 tools/gpg-keygen.js 内部推导用的是同一组纯函数（tools/lib/identity.js），两边不会跑偏。
   * 名字走三级链：显式参数（本端点没有）→ user.name → login。
   * 需要联网，所以只由用户点按钮触发，不做隐式轮询。
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
        name: deriveNameFromUser(user),
        loginName: deriveNameFromLogin(login),
        // 公开邮箱可能为空（用户设置了私密）；提交侧用 GitHub 的 noreply 格式。
        publicEmail: user && user.email ? String(user.email) : null,
        commitEmail: id !== null ? noreplyEmailFromUser(id, login) : null,
      });
    } catch (e) {
      return c.json({ ok: false, authenticated: false, text: String((e && e.message) || e) }, 500);
    }
  });

  // 当前活动公钥全文 + GitHub 发布状态：供设置页查看/复制/展示。
  app.get("/actions/pubkey", async (c) => {
    try {
      await initToolContext(appCtx);
      const data = collectPubkeyData(getToolDataDir() || dataDir);
      return c.json(data);
    } catch (e) {
      return c.json({ hasKey: false, error: String((e && e.message) || e) }, 500);
    }
  });

  // ───────────────────────────── GPG 公钥发布 ─────────────────────────────

  /** 发布状态 + 是否具备发布条件（只读，不发网络请求）。 */
  app.get("/actions/gpg/status", async (c) => {
    try {
      await initToolContext(appCtx);
      const dir = getToolDataDir() || dataDir;
      const pub = collectPubkeyData(dir);
      const blocked = publishPrecondition();
      return c.json({
        published: publishedInfo(dir),
        hasKey: !!pub.hasKey,
        keyId: pub.keyId || null,
        fpr: pub.fpr || null,
        uid: pub.uid || null,
        canPublish: !blocked,
        blockedReason: blocked,
      });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  /**
   * 手动上传公钥（供自动发布失败后重试）。
   * 只删本 App 上次上传的那一个 key_id（lib/gpg-publish.js），绝不枚举批量删除。
   */
  app.post("/actions/gpg/publish", async (c) => {
    try {
      await initToolContext(appCtx);
      const dir = getToolDataDir() || dataDir;
      const pub = collectPubkeyData(dir);
      if (!pub.hasKey || !pub.pubkey) {
        return c.json({ ok: false, text: "尚未生成隔离 GPG 公钥，请先点「生成 / 轮换密钥」。" }, 400);
      }
      const identity = await fetchLogin();
      const r = await publishKey({
        dataDir: dir,
        pubkeyArmored: pub.pubkey,
        fingerprint: pub.fpr || "",
        login: identity,
      });
      return c.json({ ok: r.ok, text: r.message, published: publishedInfo(dir) }, r.ok ? 200 : 400);
    } catch (e) {
      return c.json({ ok: false, text: String((e && e.message) || e) }, 500);
    }
  });

  /** 从 GitHub 移除本 App 上传的那一把（只删记录里的 key_id）。 */
  app.post("/actions/gpg/unpublish", async (c) => {
    try {
      await initToolContext(appCtx);
      const dir = getToolDataDir() || dataDir;
      const r = await unpublishKey({ dataDir: dir });
      return c.json({ ok: r.ok, text: r.message, published: publishedInfo(dir) }, r.ok ? 200 : 400);
    } catch (e) {
      return c.json({ ok: false, text: String((e && e.message) || e) }, 500);
    }
  });
}

/** 读当前账号 login（尽力而为；失败返回 ""，不阻断发布）。 */
async function fetchLogin() {
  try {
    const r = await runCli("gh", ["api", "user"], { timeoutSec: 30 });
    if (!r.ok) return "";
    const user = JSON.parse(r.stdout || "{}");
    return user && user.login ? String(user.login) : "";
  } catch {
    return "";
  }
}
