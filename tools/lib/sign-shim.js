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
 *   Windows：<dataDir>/gpg.shim.cmd   @echo off / "<node>" "<shim>" %*
 *   POSIX  ：<dataDir>/gpg.shim.sh    #!/bin/sh / exec "<node>" "<shim>" "$@"
 *
 * 包装生成到 **dataDir**（可写），不写安装目录（安装目录只读）；内含的 node 与 shim 路径
 * **每次现算**——宿主升级会换 node 路径，安装目录也可能变，写死就会指向不存在的位置
 * （旧实现踩过这个坑：把 vendor gpg 绝对路径存进 gitconfig，包一换布局就报 cannot spawn）。
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

/** 包装脚本路径（dataDir 下，按平台取扩展名）。 */
export function wrapperPath(dataDir) {
  return path.join(dataDir || "", process.platform === "win32" ? "gpg.shim.cmd" : "gpg.shim.sh");
}

/**
 * 确保包装脚本存在且内容为当前安装的现算值；返回它的路径。
 *
 * 内容每次覆盖写（幂等）：node 路径或 shim 路径变了，下一次 spawn 就会用新的。
 * @returns {string|null} 包装脚本绝对路径；shim 不存在时返回 null（调用方不注入 gpg.program）
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
  const target = wrapperPath(dataDir);
  const body =
    process.platform === "win32"
      ? `@echo off\r\n"${node}" "${shim}" %*\r\n`
      : `#!/bin/sh\nexec "${node}" "${shim}" "$@"\n`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(target, body, process.platform === "win32" ? "ascii" : "utf8");
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    return target;
  } catch {
    return null;
  }
}
