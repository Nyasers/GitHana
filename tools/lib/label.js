// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/label.js — githana_label 各动词共用的渲染。
 *
 * 跨名词共用（仓库上下文、失败说明）在 tools/lib/gh.js；这里只放标签专有的部分：
 * 默认颜色、颜色归一、标签一行渲染。
 *
 * ## 颜色
 *
 * GitHub 的标签颜色是**六位十六进制**（不带 `#`）。gh `label create` 缺省随机取一个，
 * 本实现不随机——随机色让同一个动作在不同的调用里产出不同结果，对"重跑一次"是噪声。
 * 缺省值取一个中性灰，显式给的颜色按 GitHub 的格式校验（在 schema 里）。
 */

/** 缺省颜色：中性灰（不带 #，GitHub 的格式）。 */
export const DEFAULT_LABEL_COLOR = "ededed";

/** 颜色归一：去掉 #、转小写；非法返回 null。 */
export function normalizeColor(value) {
  const raw = value !== undefined && value !== null ? String(value).trim().replace(/^#/, "") : "";
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return raw.toLowerCase();
}

/** 标签一行渲染（list 用）：`名字  #颜色  描述`。 */
export function labelLine(label) {
  const name = String((label && label.name) || "?");
  const color = label && label.color ? "#" + String(label.color) : "";
  const desc = label && label.description ? "  " + String(label.description) : "";
  return "  " + name + (color ? "  " + color : "") + desc;
}
