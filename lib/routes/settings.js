// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/routes/settings.js — GitHana 设置页数据端点（App v2）。
 *
 * 背景：`contributes.settings.ui.route` 指向 ui/settings.html 后，宿主不再画通用表单，
 * 动态读写由「App 自己的已认证路由」承担（见 APPS.md「自定义设置页面与关联面板」）。
 *
 * 这里只做**非机密**设置与环境状态；GitHub 令牌不走宿主设置表，而是
 * DPAPI 加密落 App 自己的数据目录（见 lib/secret.js）——所以本文件通过 secretInfo
 * 只回传「配没配 / 保护方式 / 存放位置」，不碰明文。
 *
 * 端点：
 *   GET  /settings/state → { tokenConfigured, secret, status }
 *   POST /settings/token  → body { token }：非空=加密保存，空串=清除
 */
import { collectStatus } from "./status.js";
import { saveSecret, clearSecret, secretInfo } from "../secret.js";

/** 从任意 body 形状里取 token 字符串；非字符串返回 null（非法）。 */
function readToken(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.token !== "string") return null;
  return body.token.trim();
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
      return c.json({ tokenConfigured: status.tokenConfigured, secret: secretInfo(dataDir), status });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });

  app.post("/settings/token", async (c) => {
    let body = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON（{ token: string }）" }, 400);
    }
    const token = readToken(body);
    if (token === null) {
      return c.json({ error: "token 必须是字符串（传空串表示清除）" }, 400);
    }
    try {
      if (!token) {
        await clearSecret({ dataDir });
        return c.json({ ok: true, tokenConfigured: false });
      }
      const r = await saveSecret({ dataDir, token });
      return c.json({
        ok: true,
        tokenConfigured: true,
        protection: r.protection,
      });
    } catch (e) {
      return c.json({ error: String((e && e.message) || e) }, 500);
    }
  });
}
