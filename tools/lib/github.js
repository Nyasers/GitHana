// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * GitHub 域工具共享 helper（纯函数，可静态导入）。
 *
 * GitHub 域调用走自写 REST 通道（tools/lib/rest.js）——本模块只保留
 * 参数解析与校验纯函数（仓库上下文、数字参数），与传输层无关。
 *
 * 职责：
 * - repo 参数解析与校验（仅显式 repo 参数，无默认无回落，不依赖工作目录推断）
 *
 * 数字参数（prNumber 等）的校验不在这里：它们的形状由各 action 的 zod schema 声明，运行期由
 * tools/lib/surface.js 统一校验（见 spec tool-surface D5）。
 */

/**
 * 解析并校验 repo 参数（格式 owner/repo，正好一个斜杠）。
 * 仅接受显式传入的 repo 参数：无默认仓库配置、无工作目录推断。
 * @param {unknown} repoParam 工具参数中的 repo 值（可能为 undefined/null）
 * @returns {{ owner: string, repo: string } | { error: string }}
 */
export function resolveRepo(repoParam) {
  const explicit =
    repoParam !== undefined && repoParam !== null ? String(repoParam).trim() : "";
  const raw = explicit;
  if (!raw) {
    return {
      error:
        "no repository specified: the Agent must pass repo explicitly (format owner/repo); this plugin has no default repository configured.",
    };
  }
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return {
      error:
        'invalid repo argument format: "' +
        raw +
        '". The required format is owner/repo (exactly one slash, e.g. liliMozi/openhanako).',
    };
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}
