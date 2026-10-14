// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/surface.js — 工具面路由层与参数校验的唯一入口。
 *
 * 两个入口（githana 写面 / githana_read 只读面）共用这一层，所以参数定义与三类边界各只有一份实现，
 * 不会在两边各写一遍后跑偏。
 *
 * ## 一份 zod 定义长出两样产出（见 spec tool-surface D5）
 *
 *   · 模型面 `parameters`：由 `z.toJSONSchema(flat, { io: "input" })` 生成，不再手写；
 *   · 运行期校验：`z.discriminatedUnion("action", branches).safeParse(input)`，失败返回**全部**
 *     issues（英文原文，含 path / code / message）加一行中文引导。
 *
 * 每个 action 导出它的 raw shape（字段名 → zod 类型，**不含 `action`**，见各 action 文件的
 * `schema` 导出）。这里组合成 `z.strictObject({ action: z.literal(cmd), ...shape })`，再收进
 * `z.discriminatedUnion("action", branches)`：分支严格、嵌套严格由 `strictObject` 保证。
 * 字段只在真正接受它的 action 上声明，所以多余的键会被当场拒（收敛前的平表是宽容的，见
 * spec gh-cli-parity 的 Boundary Conditions：这份宽容随 zod 闸门上线一并消失）。
 *
 * ## 宿主会注入 context
 *
 * 宿主调用工具时传的是 `{ ...args, context: {...} }`（见 app.js 的 register），而 strictObject
 * 会把未声明的键判为多余键。所以每个分支 `.extend({ context: z.unknown().optional() })`——只为
 * 让宿主注入的那个键有声明。**模型面不含它**（`parameters` 从没有它的定义生成）。
 *
 * ## 模型面用平表，不用顶层 oneOf
 *
 * spec 实测（来自 dshana）：宿主 tool_help 的参数摘要收集器（bundle 里的 `o1e`）只读**顶层平铺的
 * `properties`**，顶层 `oneOf` 会让摘要变空。所以 `parameters` 用一张平表：`action` 的 enum 加上
 * 各 action 字段的并集（同键取先出现的那份），仍由同一份 zod 定义派生。运行期该严格的地方严格
 * 在 discriminatedUnion 上——两者是同一来源的两种投影，不是两份定义。
 */
import { z } from "zod";
import { initToolContext } from "./context.js";

/** 宿主注入的调用上下文（callToken / agentId / sessionId…）：只为让 strictObject 放行这个键。 */
const HOST_CONTEXT = { context: z.unknown().optional() };

/**
 * 去掉 zod 投影里的空 `additionalProperties: {}`（= 允许任意附加键，本就是 JSON Schema 在有该键
 * 缺省时的含义）。它出现是因为 `api` 的 body 是**原样透传**的对象（运行期要保留调用方给的每个键，
 * 所以那边必须是 loose 对象）；模型面没有额外语义要表达，留一个空 schema 只是多一个没信息的键。
 */
function stripEmptyAdditional(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripEmptyAdditional);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value && typeof value === "object" && Object.keys(value).length === 0) continue;
    out[key] = stripEmptyAdditional(value);
  }
  return out;
}

/**
 * 校验失败 → 可读文案：**全部** issues 的英文原文（path / code / message）+ 一行中文引导。
 * 逐条翻译会引入偏差，而这条通道的第一读者是模型（见 spec tool-surface D6）。
 */
function formatIssues(label, issues) {
  const lines = [label + " 参数校验失败（共 " + issues.length + " 处）："];
  for (const it of issues) {
    const path = Array.isArray(it.path) && it.path.length ? it.path.join(".") : "(根)";
    lines.push("  · " + path + " [" + it.code + "] " + it.message);
  }
  lines.push("请按上面的字段路径修正参数后重试；可用 action 与各字段的用法见随包手册 skills/githana/SKILL.md。");
  return lines.join("\n");
}

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
 * @param {Record<string, import("zod").ZodType>} [spec.modelFields] 面级的模型面专属字段
 *   （覆盖各 action 的同名项；取值域按面不同时才需要——如 `api` 的 `method`）
 */
export function createSurface({
  name,
  description,
  permission,
  actions,
  reserved = {},
  other = null,
  modelFields = {},
}) {
  const byCommand = new Map();
  const commands = [];
  const branches = [];
  for (const entry of actions) {
    const mod = entry.module;
    if (!mod || typeof mod.command !== "string" || typeof mod.run !== "function") {
      throw new Error(name + " 的 action 表里有形状不合法的条目（需要 { command, run }）");
    }
    if (typeof mod.schema !== "object" || mod.schema === null) {
      throw new Error(name + " 的 action「" + mod.command + "」没有导出 zod schema（字段定义的唯一来源）");
    }
    if (byCommand.has(mod.command)) throw new Error(name + " 的 action 表里有重复的 action：" + mod.command);
    byCommand.set(mod.command, { mod, options: { ...(entry.options || {}), label: name + "(" + mod.command + ")" } });
    commands.push(mod.command);
    branches.push(z.strictObject({ action: z.literal(mod.command), ...mod.schema }).extend(HOST_CONTEXT));
  }
  if (branches.length === 0) throw new Error(name + " 的 action 表为空");

  // —— 运行期校验：每分支严格、嵌套严格（见头注）——
  const union = z.discriminatedUnion("action", branches);

  // —— 模型面 parameters：平表（action 的 enum + 各 action 字段的并集）——
  // 每个 action 贡献 `schema`（运行期的那份）与可选的 `modelFields`（只给模型看的取值域提示，
  // 覆盖它自己的同名项，如 log 的 n 补上范围与默认值）。
  // 同键**取第一次出现的那份**（action 表顺序，与收敛前的平表同规则），面级 modelFields 最后
  // 覆盖（`api` 的 method 用得上：同键在两面的取值域不同，见 tools/githana*.js）。
  // 这里用 z.object（不是 strictObject）：只有它的 `properties` 会被取用，多余键的拒绝由上面
  // 那些分支负责；在投影这一步再声明一次 additionalProperties:false 没有消费者。
  const flatShape = {};
  for (const entry of actions) {
    for (const [key, field] of Object.entries({ ...entry.module.schema, ...(entry.module.modelFields || {}) })) {
      if (!(key in flatShape)) flatShape[key] = field;
    }
  }
  const flat = z.object({ ...flatShape, ...modelFields });
  const projected = stripEmptyAdditional(z.toJSONSchema(flat, { io: "input" }));
  const parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: commands,
        description: "要执行的动作：" + actions.map((e) => e.module.command + "=" + e.module.summary).join(" / "),
      },
      ...projected.properties,
    },
    // required 只有 action：平表把各 action 的必填项并在一起后无法区分谁必填，所以这里不声明；
    // 必填与否真正生效的地方是运行期各自的 strictObject 分支（与收敛前的形态一致，见 spec D3 / D4）。
    required: ["action"],
  };

  async function execute(input, ctx) {
    await initToolContext(ctx);
    const raw = input && input.action !== undefined && input.action !== null ? String(input.action).trim() : "";
    if (!raw) {
      return name + " 参数错误：缺少 action。可用 action：" + commands.join(" / ") + "。";
    }
    const entry = byCommand.get(raw);
    if (entry) {
      // action 是分发键（不是载荷）：先按上面的 trim 归一，再让 zod 校验其余字段——
      // 否则 " commit " 这种带空白的输入会以 invalid_union 落进 issues，丢掉"已识别出 action"这件事。
      // 校验收在这一处，失败返回**全部** issues（不是第一条就停）。parsed.data 是**校验后的值**
      // （多余键被 strictObject 拒掉，所以这里不会是原样的 input），各 action 只读它。
      const parsed = union.safeParse({ ...input, action: raw });
      if (!parsed.success) return formatIssues(entry.options.label, parsed.error.issues);
      try {
        return await entry.mod.run(parsed.data, ctx, entry.options);
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
