// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * repo/gitignore：列出 GitHub 提供的 .gitignore 模板名（githana_repo 动词）。
 *
 * 走 REST `GET /gitignore/templates`（账号级端点，支撑权限 `metadata: read`）。这是 gh
 * `repo create --gitignore` 的**查名动词**：模板名是 GitHub 维护的一套具名清单（如 Node /
 * Python / VisualStudioCode），猜不出来，所以先列再建。
 *
 * `template` 给了就取那份模板的**正文**（`GET /gitignore/templates/{name}`）——那是 gh
 * `gitignore view` 的对应物，一次调用既能列名也能看内容。
 *
 * 参数名用 `template` 而不是 `name`：本工具的 `name` 在 create / fork 上是**仓库名**，
 * 同一个键在两处不同义会让模型面的平表摘要自相矛盾（见 surface.js 的平表说明）。
 *
 * 只读，不改远端状态。
 */
import { z } from "zod";
import { callRest, apiRoot, DEFAULT_REST_TIMEOUT_SEC } from "../../lib/rest.js";
import * as params from "../../lib/params.js";
import { requireAuth, describeFailure } from "../../lib/gh.js";

export const command = "gitignore";
export const summary = "列 .gitignore 模板名（给 template 则看该模板正文）";

export const schema = {
  template: z.string().optional().describe("可选：模板名（如 Node）；给了就返回该模板正文，不给则列出全部可用名"),
  timeoutSec: params.timeoutSec,
};

export async function run(input, ctx, { label }) {
  const authErr = requireAuth(label);
  if (authErr) return authErr;

  const timeoutSec = input?.timeoutSec;
  const timeoutMs = (timeoutSec || DEFAULT_REST_TIMEOUT_SEC) * 1000;
  const template = input?.template !== undefined && input?.template !== null ? String(input.template).trim() : "";

  if (template === "") {
    const r = await callRest([{ url: apiRoot("/gitignore/templates"), timeoutMs }], { timeoutSec });
    if (!r.ok) return label + " 执行失败：" + r.message;
    const res = r.results[0];
    if (!res || !res.ok) return label + " 执行失败：" + describeFailure(res, "");
    const names = Array.isArray(res.json) ? res.json.map((x) => String(x)) : [];
    if (names.length === 0) return label + "：GitHub 返回了空的模板清单（异常，请稍后重试）。";
    return [
      label + "（GitHub 提供的 .gitignore 模板 · " + names.length + " 个）：",
      names.join(" · "),
      "用法：githana_repo(action=\"create\", name=\"<仓库名>\", gitignore=\"<这里的一个名字>\")；",
      "要看某个模板的正文：githana_repo(action=\"gitignore\", template=\"<名字>\")。",
    ].join("\n");
  }

  const r = await callRest(
    [{ url: apiRoot("/gitignore/templates/" + encodeURIComponent(template)), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " 执行失败：" + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + "：没有名为 " + template + " 的 .gitignore 模板。可用名见 githana_repo(action=\"gitignore\")。";
    }
    return label + " 执行失败：" + describeFailure(res, "");
  }
  const body = res.json && res.json.source ? String(res.json.source) : "";
  return [
    label + "（模板 " + template + " · " + body.length + " 字符）：",
    body || "（该模板的正文为空）",
  ].join("\n");
}
