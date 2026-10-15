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
export const summary = "List .gitignore template names (with template, show that template's body)";

export const schema = {
  template: z.string().optional().describe("Optional: template name (e.g. Node); when given, that template's body is returned, otherwise all available names are listed"),
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
    if (!r.ok) return label + " execution failed: " + r.message;
    const res = r.results[0];
    if (!res || !res.ok) return label + " execution failed: " + describeFailure(res, "");
    const names = Array.isArray(res.json) ? res.json.map((x) => String(x)) : [];
    if (names.length === 0) return label + ": GitHub returned an empty template list (abnormal; please retry later).";
    return [
      label + " (.gitignore templates provided by GitHub · " + names.length + "):",
      names.join(" · "),
      "usage: githana_repo(action=\"create\", name=\"<repository name>\", gitignore=\"<one of the names above>\");",
      "to see a template's body: githana_repo(action=\"gitignore\", template=\"<name>\").",
    ].join("\n");
  }

  const r = await callRest(
    [{ url: apiRoot("/gitignore/templates/" + encodeURIComponent(template)), timeoutMs }],
    { timeoutSec },
  );
  if (!r.ok) return label + " execution failed: " + r.message;
  const res = r.results[0];
  if (!res || !res.ok) {
    if (res && res.status === 404) {
      return label + ": there is no .gitignore template named " + template + ". For available names see githana_repo(action=\"gitignore\").";
    }
    return label + " execution failed: " + describeFailure(res, "");
  }
  const body = res.json && res.json.source ? String(res.json.source) : "";
  return [
    label + " (template " + template + " · " + body.length + " chars):",
    body || "(this template's body is empty)",
  ].join("\n");
}
