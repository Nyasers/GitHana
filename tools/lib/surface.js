// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/surface.js — 工具面路由层：把一张 action 表装配成一个宿主工具。
 *
 * 两个入口（githana 写面 / githana_read 只读面）共用这一层，所以三类边界只有一份实现，
 * 不会在两边各写一遍后跑偏：
 *   · 缺 action → 报错并列出本面可用值；
 *   · 未知 action → 报错并列出本面可用值，不猜、不回落默认分支；
 *   · 走错面 → 报错并指向那个工具（只读面收到 exec / commit / push、写面收到 status /
 *     log / pr_list / pr_view，都走这条）；
 *   · 保留位 action（CI 两项，见 spec D8）→ 报错说明本期未实现，同样列出可用值。
 *
 * 参数表是把各 action 的 fields 合并成的一张平表（同键取第一次出现的那份，故共用字段统一写在
 * tools/lib/params.js），required 只有 action——与收敛前的形态一致。每个 action 自己的必填项
 * 由它的 run() 就地校验（口径与收敛前逐条相同）；把逐 action 的必填收进 schema 是阶段 B 的
 * discriminatedUnion 分支（见 spec D5）。
 */
import { initToolContext } from "./context.js";

/**
 * 装配一个工具模块（app.js 直接把它当 v1 形态的工具实现注册）。
 *
 * @param {object} spec
 * @param {string} spec.name 工具名（宿主全局唯一）
 * @param {string} spec.description 工具描述（只留路由信息，用法细节在 SKILL 手册）
 * @param {object} spec.permission sessionPermission 声明（v1 形态）
 * @param {Array<{ module: object, options?: object }>} spec.actions action 表（顺序即 enum 顺序）
 * @param {Record<string, string>} [spec.reserved] 保留位 action → 未实现说明
 * @param {{ name: string, commands: string[] }} [spec.other] 另一个面（走错面时指向它）
 * @param {Record<string, object>} [spec.sharedFields] 本面共用的字段（cwd / repo / timeoutSec…）
 */
export function createSurface({ name, description, permission, actions, reserved = {}, other = null, sharedFields = {} }) {
  const byCommand = new Map();
  const commands = [];
  for (const entry of actions) {
    const mod = entry.module;
    if (!mod || typeof mod.command !== "string" || typeof mod.run !== "function") {
      throw new Error(name + " 的 action 表里有形状不合法的条目（需要 { command, run }）");
    }
    if (byCommand.has(mod.command)) throw new Error(name + " 的 action 表里有重复的 action：" + mod.command);
    byCommand.set(mod.command, { mod, options: { ...(entry.options || {}), label: name + "(" + mod.command + ")" } });
    commands.push(mod.command);
  }

  // —— 参数表：action + 本面共用字段 + 各 action 自己的字段（同键取第一次出现的那份）——
  const properties = {
    action: {
      type: "string",
      enum: commands,
      description: "要执行的动作：" + actions.map((e) => e.module.command + "=" + e.module.summary).join(" / "),
    },
  };
  for (const [key, schema] of Object.entries(sharedFields)) properties[key] = schema;
  for (const entry of actions) {
    for (const [key, schema] of Object.entries(entry.module.fields || {})) {
      if (properties[key]) continue;
      properties[key] = schema;
    }
  }

  const parameters = { type: "object", properties, required: ["action"] };

  async function execute(input, ctx) {
    await initToolContext(ctx);
    const raw = input && input.action !== undefined && input.action !== null ? String(input.action).trim() : "";
    if (!raw) {
      return name + " 参数错误：缺少 action。可用 action：" + commands.join(" / ") + "。";
    }
    const entry = byCommand.get(raw);
    if (entry) {
      try {
        return await entry.mod.run(input, ctx, entry.options);
      } catch (e) {
        return name + "（action=" + raw + "）执行异常：" + (e && e.message ? e.message : String(e));
      }
    }
    // 保留位：本期只在 action 表与手册里留位置，不实现（见 spec D8）。
    if (reserved[raw]) {
      return name + "（action=" + raw + "）未实现：" + reserved[raw] + "\n可用 action：" + commands.join(" / ") + "。";
    }
    // 走错面：该 action 属于另一个工具。
    if (other && other.commands.includes(raw)) {
      return name + "（action=" + raw + "）不接受该动作：它属于另一个面。请改用 " + other.name + "(action=\"" + raw + "\")。";
    }
    return name + " 参数错误：未知 action（收到：" + raw + "）。可用 action：" + commands.join(" / ") + "。";
  }

  return { name, description, parameters, sessionPermission: permission, execute };
}

/**
 * 按 action 生成 describeSideEffect：写面的每个 action 自己声明影响摘要（sideEffect），
 * 这里按 action 查表返回；缺 action / 未知 action 用 fallback（覆盖整面，偏保守）。
 */
export function sideEffectDescriber(actions, fallback) {
  const map = new Map();
  for (const entry of actions) {
    if (entry.module.sideEffect) map.set(entry.module.command, entry.module.sideEffect);
  }
  return (input) => {
    const raw = input && input.action !== undefined && input.action !== null ? String(input.action).trim() : "";
    const se = map.get(raw) || fallback;
    return { kind: se.kind, summary: se.summary, ruleId: se.ruleId };
  };
}
