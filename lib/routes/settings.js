// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/settings.js — GitHana 设置页数据端点（App v2）。
 *
 * 背景：`contributes.settings.ui.route` 指向 ui/settings.html 后，宿主不再画通用表单，
 * 动态读写由「App 自己的已认证路由」承担（见 APPS.md「自定义设置页面与关联面板」）。
 *
 * 凭据**没有写入端点**：OAuth 令牌只能由 device flow 拿到（见 lib/oauth.js 与
 * lib/routes/actions.js 的 /actions/oauth/*），页面永远不接触令牌明文。本文件只回传
 * 「授没授权 / 保护方式 / 存放位置 / 账号 / 到期时间」这类非机密摘要。
 *
 * 端点：
 *   GET  /settings/state              → { tokenConfigured, clientId, clientIdOverride, secret, status }
 *   POST /settings/client-id          → body { clientId }：保存 Client ID 覆盖值（空串 = 撤销覆盖）
 *   POST /settings/legacy-pat/clear   → 清除已停用的旧 PAT 记录（OAuth 凭据另走 /actions/oauth/revoke）
 */
import { collectStatus } from "./status.js";
import {
  secretInfo,
  readClientId,
  readClientIdOverride,
  saveClientId,
  readLegacyPat,
  removeSecretRecord,
} from "../secret.js";

/** 从任意 body 形状里取 clientId 字符串；非字符串返回 null（非法）。 */
function readClientIdField(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.clientId !== "string") return null;
  return body.clientId.trim();
}

/**
 * v2 registrar：把设置页数据端点挂进宿主创建的 Hono sub-app。
 * @param {import("hono").Hono} app
 * @param {{ appCtx: object, dataDir: string }} deps
 */
export function registerSettingsRoutes(app, { appCtx, dataDir } = {}) {
  app.get("/settings/state", async (c) => {
    try {
      const status = await collectStatus(appCtx);
      return c.json({
        tokenConfigured: status.tokenConfigured,
        clientId: readClientId(dataDir),
        clientIdOverride: readClientIdOverride(dataDir) || null,
        secret: secretInfo(dataDir),
        status,
      });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  // Client ID 非机密（可写进代码作默认值），用户覆盖值存 App 数据目录的 oauth.json，
  // 与凭据记录解耦——退出授权不会把它一起清掉，重新登录不必重填。
  app.post("/settings/client-id", async (c) => {
    let body = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON（{ clientId: string }）" }, 400);
    }
    const clientId = readClientIdField(body);
    if (clientId === null) {
      return c.json({ error: "clientId 必须是字符串（传空串表示撤销覆盖、回落内置默认值）" }, 400);
    }
    try {
      const saved = saveClientId(dataDir, clientId);
      return c.json({ ok: true, clientId: saved.clientId, clientIdOverride: saved.overridden ? saved.clientId : null });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  // 旧 PAT 记录（schemaVersion 1）：读但不采用，给用户一个显式清除入口。
  // 这里只删文件，不碰 oauth.json（clientId 覆盖值保留）。
  app.post("/settings/legacy-pat/clear", async (c) => {
    try {
      if (!readLegacyPat(dataDir)) {
        return c.json({ ok: true, cleared: false, reason: "本地没有旧 PAT 记录" });
      }
      removeSecretRecord(dataDir);
      return c.json({ ok: true, cleared: true });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });
}
