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
 *   GET  /settings/state              → { tokenConfigured, clientId, secret, status }
 *   POST /settings/legacy-pat/clear   → 清除已停用的旧 PAT 记录（OAuth 凭据另走 /actions/oauth/revoke）
 *
 * Client ID、提交者名字与邮箱都没有写入端点：页面不提供这些输入。Client ID 是本 App 注册的
 * 那一个（常量）；提交身份由已登录账号推导（见 tools/lib/identity.js）。
 */
import { collectStatus } from "./status.js";
import { secretInfo, readClientId, readLegacyPat, removeSecretRecord } from "../secret.js";

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
        // 本 App 注册的 Client ID（常量，非机密）。页面只展示，不提供修改入口。
        clientId: readClientId(),
        secret: secretInfo(dataDir),
        status,
      });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  // 旧 PAT 记录（schemaVersion 1）：读但不采用，给用户一个显式清除入口。
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
