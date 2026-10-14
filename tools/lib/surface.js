// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/surface.js — 工具面路由层与参数校验的唯一入口。
 *
 * 名词工具（githana_git / githana_api / githana_pr …）共用这一层，所以参数定义与各类边界
 * 各只有一份实现，不会在每个工具里各写一遍后跑偏。
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
 * 字段只在真正接受它的 action 上声明，所以多余的键会被当场拒。
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
 *
 * ## 两类装配路径（见 spec gh-cli-parity D3 / D4）
 *
 *   · `createSurface`——**动词数 ≥ 2** 的工具：`action` 是分发键，模型面声明它，`required` 为
 *     `["action"]`，走错动词时按动词索引指名正确的工具；
 *   · `createSingleSurface`——**单动词**工具（`githana_api`）：没有分发可做，`action` 不声明
 *     （值域为单数时它只是占位），`required` 换成该工具自己的必填项。
 *
 * 跨工具的错投靠 `verbs` 索引判：每个名词工具声明自己之外**还有哪些工具在收哪些动词**，
 * 报错因此能具体指名（「commit 属于 githana_git」），而不是一句空泛的「它属于另一个面」。
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

/** action 值归一：undefined / null → ""，其余 trim 成字符串（分发键不做其它变换）。 */
function normalizeAction(value) {
  return value !== undefined && value !== null ? String(value).trim() : "";
}

/**
 * 装配 action 表：校验形状、建索引、长出运行期分支。
 *
 * @param {string} name 工具名（用于报错文案与 label）
 * @param {Array<{ module: object, options?: object }>} actions action 表（顺序即 enum 顺序）
 * @param {Record<string, import("zod").ZodType>} [modelFields] 面级的模型面专属字段
 * @returns {{ byCommand: Map, commands: string[], union: object, flat: object }}
 */
function assemble(name, actions, modelFields) {
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

  // 模型面 parameters：平表（action 的 enum + 各 action 字段的并集）。
  // 每个 action 贡献 `schema`（运行期的那份）与可选的 `modelFields`（只给模型看的取值域提示，
  // 覆盖它自己的同名项，如 log 的 n 补上范围与默认值）。同键**取第一次出现的那份**（action
  // 表顺序），面级 modelFields 最后覆盖。这里用 z.object（不是 strictObject）：只有它的
  // `properties` 会被取用，多余键的拒绝由上面那些分支负责。
  const flatShape = {};
  for (const entry of actions) {
    for (const [key, field] of Object.entries({ ...entry.module.schema, ...(entry.module.modelFields || {}) })) {
      if (!(key in flatShape)) flatShape[key] = field;
    }
  }
  const flat = z.object({ ...flatShape, ...(modelFields || {}) });
  return { byCommand, commands, union: z.discriminatedUnion("action", branches), flat };
}

/** 各 action 的模型面一句话摘要（进 action 字段的 description）。 */
function actionEnumDescription(actions, prefix) {
  return prefix + actions.map((e) => e.module.command + "=" + e.module.summary).join(" / ");
}

/**
 * 走错工具时的文案：锚点是**正确工具**（AC5）。锚点缺失时退回自己那张动词表——
 * 那不是猜：动词表就是本工具能接的全集，而收到的值的确不在里面。
 * @param {string} name 收到请求的工具
 * @param {string} raw 收到的 action 原值
 * @param {string[]} commands 本工具的动词表
 * @param {Array<{ name: string, commands: string[], usage?: string }>} verbs 其它名词工具的动词表
 */
function misroutedMessage(name, raw, commands, verbs) {
  const hit = verbs.find((v) => Array.isArray(v.commands) && v.commands.includes(raw));
  if (hit) {
    // usage 是**指名怎么调**的片段：单动词工具没有 action 可填（githana_api），
    // 这时给 `name(action="api")` 是错的指路，所以那种工具在自己的动词表里写明调用形态。
    const call = typeof hit.usage === "string" && hit.usage !== "" ? hit.usage : hit.name + "(action=\"" + raw + "\")";
    return (
      name + "（action=" + raw + "）不接受该动作：" + raw + " 属于 " + hit.name +
      "。请改用 " + call + "。"
    );
  }
  return (
    name + " 参数错误：未知 action（收到：" + raw + "）。可用 action：" + commands.join(" / ") + "。"
  );
}

/**
 * 装配一个**多动词**工具模块（app.js 直接把它当 v1 形态的工具实现注册）。
 *
 * @param {object} spec
 * @param {string} spec.name 工具名（宿主全局唯一）
 * @param {string} spec.description 工具描述（只留路由信息，用法细节在 SKILL 手册）
 * @param {object} spec.permission sessionPermission 声明（v1 形态）
 * @param {Array<{ module: object, options?: object }>} spec.actions action 表（顺序即 enum 顺序）
 * @param {Record<string, string>} [spec.reserved] 保留位 action → 未实现说明
 * @param {Array<{ name: string, commands: string[] }>} [spec.verbs] 其它名词工具的动词表（跨工具指名用）
 * @param {Record<string, import("zod").ZodType>} [spec.modelFields] 面级的模型面专属字段
 *   （覆盖各 action 的同名项；取值域按工具不同时才需要——如 `pr` 的 method）
 */
export function createSurface({
  name,
  description,
  permission,
  actions,
  reserved = {},
  verbs = [],
  modelFields = {},
}) {
  const { byCommand, commands, union, flat } = assemble(name, actions, modelFields);
  const projected = stripEmptyAdditional(z.toJSONSchema(flat, { io: "input" }));
  const parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: commands,
        description: actionEnumDescription(actions, "要执行的动作："),
      },
      ...projected.properties,
    },
    // required 只有 action：平表把各 action 的必填项并在一起后无法区分谁必填，所以这里不声明；
    // 必填与否真正生效的地方是运行期各自的 strictObject 分支（见 spec D3 / D4）。
    required: ["action"],
  };

  async function execute(input, ctx) {
    await initToolContext(ctx);
    const raw = normalizeAction(input && input.action);
    if (!raw) {
      return name + " 参数错误：缺少 action。可用 action：" + commands.join(" / ") + "。";
    }
    const entry = byCommand.get(raw);
    if (entry) {
      // action 是分发键（不是载荷）：先按上面的 trim 归一，再让 zod 校验其余字段——
      // 否则 " commit " 这种带空白的输入会以 invalid_union 落进 issues，丢掉"已识别出 action"这件事。
      // 校验收在这一处，失败返回**全部** issues（不是第一条就停）。
      const parsed = union.safeParse({ ...input, action: raw });
      if (!parsed.success) return formatIssues(entry.options.label, parsed.error.issues);
      try {
        return await entry.mod.run(parsed.data, ctx, entry.options);
      } catch (e) {
        return name + "（action=" + raw + "）执行异常：" + (e && e.message ? e.message : String(e));
      }
    }
    // 保留位：本期只在 action 表与手册里留位置，不实现。
    if (reserved[raw]) {
      return name + "（action=" + raw + "）未实现：" + reserved[raw] + "\n可用 action：" + commands.join(" / ") + "。";
    }
    // 走错名词：该 action 属于另一个工具（指名它，不是「另一个面」）。
    return misroutedMessage(name, raw, commands, verbs);
  }

  return { name, description, parameters, sessionPermission: permission, execute };
}

/**
 * 装配一个**单动词**工具模块（`githana_api`）。
 *
 * 没有分发可做，所以：不声明 `action`；模型面直接把该 action 的字段铺在顶层，`required` 取
 * 该 action 自己声明的必填项（`spec.required`，如 api 的 `["path"]`——那是真必填，而收敛前
 * 它只写在 run() 里，模型面看不见）；未知 action 按动词索引指名正确工具。
 *
 * `spec.module` 的形状与多动词表里的条目一致（command / summary / schema / run），只是不再需要
 * `action` 出现在输入里：`command` 仍用于报错文案与 label。
 *
 * @param {object} spec
 * @param {string} spec.name 工具名
 * @param {string} spec.description 工具描述
 * @param {object} spec.permission sessionPermission 声明
 * @param {object} spec.module 该工具唯一的 action 模块
 * @param {string[]} spec.required 运行期 schema 里必填的字段名（只用于模型面投影）
 * @param {object} [spec.options] 传给 run() 的装配选项（label 由这里补）
 * @param {Array<{ name: string, commands: string[] }>} [spec.verbs] 其它名词工具的动词表（跨工具指名用）
 */
export function createSingleSurface({
  name,
  description,
  permission,
  module,
  required = [],
  options = {},
  verbs = [],
}) {
  const mod = module;
  if (!mod || typeof mod.command !== "string" || typeof mod.run !== "function") {
    throw new Error(name + " 的 action 模块形状不合法（需要 { command, run }）");
  }
  if (typeof mod.schema !== "object" || mod.schema === null) {
    throw new Error(name + " 的 action「" + mod.command + "」没有导出 zod schema（字段定义的唯一来源）");
  }
  // label 就是工具名：单动词工具的 name 与 command 同义（githana_api / api），拼成
  // "名字(动词)" 只会重复一次，读起来像错。多动词那边仍按 name(动词) 拼，那里它才区分得开。
  const label = name;
  // 运行期校验就是一个 strictObject：没有分发可做，所以不需要 discriminatedUnion——
  // 单分支的 union 只是多一层没有消费者的间接。strictObject 负责拒多余键（含调用方误传的
  // `action`；那一路在下面单独判，好给出指名的文案）。
  const validator = z.strictObject({ action: z.literal(mod.command), ...mod.schema }).extend(HOST_CONTEXT);
  const fieldShape = { ...mod.schema, ...(mod.modelFields || {}) };
  const projected = stripEmptyAdditional(z.toJSONSchema(z.object(fieldShape), { io: "input" }));
  const properties = projected.properties || {};
  // 必填项从 spec.required 里挑真正声明过的字段：写成 schema 里没有的名字会让模型面自相矛盾。
  const requiredList = required.filter((k) => Object.prototype.hasOwnProperty.call(properties, k));
  const parameters = { type: "object", properties };
  if (requiredList.length) parameters.required = requiredList;

  async function execute(input, ctx) {
    await initToolContext(ctx);
    // 该工具只有这一个动词，所以输入里没有 action 可分发。两种"多余的 action"分开处理：
    //   · 与本工具同名（调用方按老习惯带上 action="api"）→ 接受，等于没填（D3：单数只是占位）；
    //   · 指向别的工具 → 拒，并指名正确那个（比 zod 的 unrecognized_keys 有用）。
    const raw = normalizeAction(input && input.action);
    if (raw && raw !== mod.command) return misroutedMessage(name, raw, [mod.command], verbs);
    const parsed = validator.safeParse({ ...input, action: mod.command });
    if (!parsed.success) return formatIssues(label, parsed.error.issues);
    try {
      return await mod.run(parsed.data, ctx, { ...options, label });
    } catch (e) {
      return name + " 执行异常：" + (e && e.message ? e.message : String(e));
    }
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
    const se = map.get(normalizeAction(input && input.action)) || fallback;
    return { kind: se.kind, summary: se.summary, ruleId: se.ruleId };
  };
}
