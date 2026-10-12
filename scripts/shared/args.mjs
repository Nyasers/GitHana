// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/args.mjs — 命令行旗标/取值读取（脚本域共用一份）。
//
// 本仓的脚本各自手写过一遍参数扫描，写法已经漂移（有的只认 `--x v`、有的还认 `--x=v`，有的把
// 位置参数与取值混淆）。收敛成一处：取值旗标的值不会被当成位置参数。
//
// 只做本仓实际用到的那几种形态（长选项、`--x v` 与 `--x=v`、布尔旗标、位置参数）；需要严格
// 校验的场景（未知选项即拒、禁位置参数）用 node:util 的 parseArgs，本模块不替代它。

/** 命令行参数（去掉 node 与脚本路径）。 */
export const argv = process.argv.slice(2);

/** 布尔旗标是否存在。 */
export const hasFlag = (name) => argv.includes(name);

/**
 * 取某个旗标的值，支持 `--name v` 与 `--name=v`；缺值或下一个是另一个旗标时返回 null。
 */
export function value(name) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      const next = argv[i + 1];
      return next && !next.startsWith("--") ? next : null;
    }
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

/**
 * 取值旗标是否**出现过**（不看值是否有效）。
 *
 * 用 `value(name) === null` 判“没给”会把 `--bundle` 与 `--bundle=`（给了但缺操作数）
 * 混为一谈：前者可以回落缺省值，后者是参数错，必须报。要区分就先用本函数问“出现过没”。
 */
export function hasValueFlag(name) {
  return argv.some((a) => a === name || a.startsWith(`${name}=`));
}

/**
 * 取值旗标出现但没带有效操作数时返回 true（用于报参数错）。
 * `--x v`（v 以 `--` 开头）与 `--x=` 都算缺操作数。
 */
export function valueFlagMissingOperand(name) {
  return hasValueFlag(name) && value(name) === null;
}

/** 取某个旗标的全部值（同名可重复出现）。 */
export function values(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${name}=`)) out.push(argv[i].slice(name.length + 1));
  }
  return out;
}

/**
 * 位置参数：排除旗标与取值旗标的值之后剩下的。
 * 取值旗标的值必须点名（否则 `--source ./x` 里的 ./x 会被当成位置参数）。
 */
export function positionals(valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}
