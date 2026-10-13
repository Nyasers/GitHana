// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/sign-shim.js — 把签名 shim 接给 git（gpg.program 的解析与包装）。
 *
 * ## 为什么需要包装脚本
 *
 * git 的 `gpg.program` 只接受**一个可执行文件路径**，不能带参数（整串当 argv0，实测）。
 * 而 shim 是 `.mjs`，需要一个 node 来执行它。所以中间垫一层包装：
 *
 *   Windows：<dataDir>/.runtime-tmp/gpg.shim.cmd   @echo off / "<node>" "<shim>" %*
 *   POSIX  ：<dataDir>/.runtime-tmp/gpg.shim.sh    #!/bin/sh / exec "<node>" "<shim>" "$@"
 *
 * 包装生成到 **运行期临时目录**（<dataDir>/.runtime-tmp，可写；安装目录只读）。它是每次
 * spawn 现写的产物，不是持久状态——所以不跟密钥、凭据那些长期文件摆在一起。内含的 node 与
 * shim 路径**每次现算**：宿主升级会换 node 路径，安装目录也可能变，写死就会指向不存在的位置
 * （旧实现踩过这个坑：把 vendor gpg 绝对路径存进 gitconfig，包一换布局就报 cannot spawn）。
 * 临时目录不可用时退回 dataDir 根，宁可位置不理想也不让签名接线断掉。
 *
 * ## 落点只在这里定义一次
 *
 * `tmpDirPath` / `wrapperPath` / `ensureWrapper` 三个都在本文件：位置是「由 dataDir 完全
 * 决定的常值」，不该由调用方传进来——传参等于把同一个事实在两个模块各存一份，改的时候
 * 要对齐两处。调用方只需给 dataDir。
 *
 * ## node 用哪个
 *
 * `process.execPath`——AppHost 本身就是 node（真机实测 hana-server.exe 即 node 运行时，
 * 能被用来跑脚本）。用它与用「系统 PATH 里的 node」相比更可靠：不依赖用户装没装 node，
 * 且与 App 自身运行时同版本。
 *
 * ## 为什么还要传 GITHANA_KEY_FILE
 *
 * shim 是独立进程，不知道 dataDir。密钥文件路径经 env 传给它（与 REST worker 的令牌
 * 经 stdin 传同理：都不走宿主 IPC、不落磁盘明文）。
 */
import fs from "node:fs";
import path from "node:path";
import { pluginRoot } from "./bin.js";

/** shim 在交付树里的位置（bin/ 与 app.mjs 同层）。 */
export function shimPath() {
  return path.join(pluginRoot(), "bin", "gpg.shim.mjs");
}

/** 密钥文件（dataDir 下，由 lib/openpgp-key.js 写入）。 */
export function keyFilePath(dataDir) {
  return path.join(dataDir || "", "gpg.key.json");
}

/**
 * 运行期临时目录（<dataDir>/.runtime-tmp）的路径。只拼路径，不建目录。
 *
 * 这个目录有两个用途，都是「现写现用、用完即弃」的东西：
 *   1. TMPDIR/TMP/TEMP 指过去——git 验签时把待验签名先写成一个临时文件，再把路径交给
 *      gpg.program。系统 temp 在 App 许可根之外，shim 这个 node 脚本在权限模型下读不到它，
 *      于是 `verify-commit` / `log --show-signature` 一律报「读签名文件失败」。
 *   2. 包装脚本（ensureWrapper）写进去。
 *
 * 目录名与落点照宿主的受管运行时抄（`app-data/<id>/.runtime-tmp`，宿主给受管子进程注入
 * TMPDIR 用的就是它）。本 App 走 app/process.spawn 直接拉 git，不是受管运行时、拿不到那份
 * 注入，所以自己摆一份；两边同址同名，将来若改用受管运行时也不会分叉。
 */
export function tmpDirPath(dataDir) {
  return path.join(dataDir || "", ".runtime-tmp");
}

/**
 * 确保运行期临时目录存在；返回其路径，建不成返回 null。
 *
 * 调用方只重定向 TMPDIR/TEMP/TMP，不碰 HOME/USERPROFILE：git 的配置隔离已由
 * GIT_CONFIG_GLOBAL 完成，把 HOME 一并换掉会连带改变 ssh 与凭据助手的查找路径。
 *
 * @returns {string|null}
 */
export function ensureTmpDir(dataDir) {
  if (!dataDir) return null;
  const dir = tmpDirPath(dataDir);
  try {
    // mode 与宿主一致（0o700）。Windows 上它不产生 NTFS ACL 限制（ACL 是继承的），
    // 真正的边界是 dataDir 本身就在 App 许可根内；这里只为与宿主保持同一写法。
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

/** 包装脚本文件名（按平台取扩展名）。 */
function wrapperName() {
  return process.platform === "win32" ? "gpg.shim.cmd" : "gpg.shim.sh";
}

/**
 * 包装脚本的正常落点：<dataDir>/.runtime-tmp/<name>。纯路径推导，不建目录。
 *
 * 注意：ensureWrapper 在临时目录建不成时会退回 dataDir 根，那时实际路径与这里不同。
 * 想知道包装到底写在哪，用 ensureWrapper 的返回值。
 */
export function wrapperPath(dataDir) {
  return path.join(tmpDirPath(dataDir), wrapperName());
}

/**
 * 确保包装脚本存在且内容为当前安装的现算值；返回它的路径。
 *
 * 内容每次覆盖写（幂等）：node 路径或 shim 路径变了，下一次 spawn 就会用新的。
 * 优先落运行期临时目录；建不成时退回 dataDir 根（不让签名接线断掉）。
 *
 * @param {string} dataDir
 * @returns {string|null} 包装脚本绝对路径；shim 不存在或写不成时返回 null（调用方不注入 gpg.program）
 */
export function ensureWrapper(dataDir) {
  if (!dataDir) return null;
  const shim = shimPath();
  try {
    if (!fs.existsSync(shim)) return null;
  } catch {
    return null;
  }
  const node = process.execPath;
  const target = path.join(ensureTmpDir(dataDir) || dataDir, wrapperName());
  const body =
    process.platform === "win32"
      ? `@echo off\r\n"${node}" "${shim}" %*\r\n`
      : `#!/bin/sh\nexec "${node}" "${shim}" "$@"\n`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, process.platform === "win32" ? "ascii" : "utf8");
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    return target;
  } catch {
    return null;
  }
}
