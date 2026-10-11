// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/gpg-daemon.js — 隔离环 gpg-agent / scdaemon 的收尾清理（单一实现）。
 *
 * ## 为什么需要收尾
 *
 * gpg 在执行任何密钥操作（签名、导出、生成）时会**自动拉起** gpg-agent，而且默认常驻不退出
 * （它的设计前提是「缓存口令、供后续调用复用」，没有空闲退出计时）；agent 还会按需拉起同环
 * scdaemon（`--multi-server --homedir <隔离环>`）。在交互式桌面会话里这是优点，但本 App 的
 * 宿主是一个随时会被替换的子进程：签名结束而 agent 留在后台，就变成没人认领的孤儿进程——
 * 它持有 `vendor/.../gnupg/bin/*.exe` 的文件句柄，于是 App 卸载/更新时删除安装目录会失败
 * （Windows 上表现为长时间重试后 unshare 失败，宿主侧记 "delete files" outcome=failure）。
 *
 * 所以「即用即开、用毕即退」在这里不是优化，是**正确性要求**：每一次可能拉起 daemon 的调用
 * 都要在返回前把它收干净。
 *
 * ## 为什么用 gpgconf --kill 而不是 taskkill
 *
 * gpgconf 按 **GNUPGHOME** 定位它要杀的 daemon（它不支持 `--homedir` 参数）。runCli（bin.js 的
 * buildBinEnv）每次都注入 `GNUPGHOME=<dataDir>/gnupg`，并且按 PATH 收口把 vendor gnupg/bin
 * 前置，所以这个调用只会命中**隔离环**的 daemon（实测：`--kill all` 后用户 scoop 个人环的
 * gpg-agent 纹丝不动）。用 taskkill 按进程名杀会把用户个人环的 agent 一起带走——那是别人的
 * 资产，误杀是事故。
 *
 * 用 `--kill all` 而非列举 `gpg-agent scdaemon`：具体会起哪几个 daemon 取决于当前 GnuPG 版本
 * 与配置（agent、scdaemon，将来还可能有别的），列举名单漏项就会静默残留。`all` 是 gpgconf
 * 自己的语义，版本跟得上，也不会因为漏写一行而在某台机器上重新锁住 vendor 文件。
 *
 * ## 调用点
 *
 * 凡是可能触发签名的入口都要在 finally 里调它：git_commit（提交即签名）、git_exec（透传层
 * 同样跑 git，而隔离 gitconfig 里 commit.gpgsign=true，一次 commit 就会拉起 agent）、
 * gpg-keygen（密钥生成/轮换）、以及 App 的 disposer（卸载/重载收尾兜底）。
 * 幂等且无副作用：没有 daemon 时是快速的空操作，失败静默、不覆盖主结果。
 */
import { runCli } from "./exec.js";
import { resolveBin } from "./bin.js";
import { getToolDataDir } from "./context.js";

/**
 * 杀掉隔离环的全部 gpg daemon（gpg-agent / scdaemon / …）。
 *
 * 永不抛出。两道守卫保证「不误碰用户环」：
 *   1. dataDir 未登记 → runCli 不会注入 GNUPGHOME → 不杀（防落到默认 ~/.gnupg）；
 *   2. **仅 Windows**：系统 gpg 若是 scoop 便携版（带 `gpgconf.ctl`），它忽略 GNUPGHOME，
 *      `--kill all` 会去杀默认环——那正是用户个人环，误杀是事故。所以 Windows 上要求 bundled。
 *
 * POSIX 没有第 2 道：系统 gpgconf（Homebrew / 发行版）本就按 GNUPGHOME 定位，能且只能命中隔离环。
 * 旧版把第 2 道无差别地用在所有平台，后果是 macOS/Linux 上隔离环的 daemon 永远不清
 * （不锁 App 文件，但确实漏了）。
 *
 * @returns {Promise<boolean>} 是否真的发起了清理（false 表示因守卫跳过或失败）
 */
export async function killGpgDaemons() {
  if (!getToolDataDir()) return false;
  const gpgconf = resolveBin("gpgconf");
  if (process.platform === "win32" && gpgconf.source !== "bundled") return false;
  if (!gpgconf.cmd) return false;
  try {
    await runCli("gpgconf", ["--kill", "all"], {});
    return true;
  } catch {
    return false; // 清理尽力而为：失败静默，不覆盖主结果
  }
}
