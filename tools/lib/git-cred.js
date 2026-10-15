// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/git-cred.js — 把 App 令牌接给 git 子进程（github.com 的 https 远端）。
 *
 * ## 为什么是 credential helper，不是 URL 形态
 *
 * 令牌进 git 子进程只有两条路：拼进远端 URL，或交给 git 的凭据子系统。URL 形态排除：
 * git 在连不上时会**把完整 URL 打进 stderr**（形如 `fatal: unable to access
 * 'https://x-access-token:<token>@github.com/…'`），那条 stderr 是工具返回值的一部分，会原样
 * 进日志与对话流——这正是要避免的那件事。URL 形态还要么改远端配置（脏文件）、要么每次现拼
 * 命令行（脏 argv）。credential helper 反过来：令牌只出现在 helper 的 stdout（git 内部读走，
 * 不回显）与子进程 env 里，**配置值、命令行、远端 URL 都不含它**。
 *
 * ## 注入口：GIT_CONFIG_*（与 gpg.program 同一套）
 *
 * helper 是配置里的一个 shell 片段（`!` 开头；git 文档的口径是「由 shell 执行」，见
 * gitcredentials「CUSTOM HELPERS」），片段本身只有变量名 `$GITHANA_GIT_TOKEN`，**没有任何令牌
 * 字节**；令牌经 env 递给子进程（与签名 shim 的 GITHANA_KEY_FILE 同理：独立进程不知道 App 的
 * 内存，凭据只能经 env 或 stdin 递）。配置项由 buildBinEnv 用 GIT_CONFIG_COUNT / KEY_n / VALUE_n
 * 注入——它在所有配置文件之上生效，改不到文件也不脏文件（sign-shim 的 gpg.program 走的就是这条）。
 * 所以令牌**不落任何文件**，也不进 gitconfig。
 *
 * ## 只对 github.com 的 https 远端生效
 *
 * 配置键带 URL 上下文（`credential.https://github.com.helper`）：git 只在协议与主机都匹配时
 * 采用它，别的远端（GitLab、自建、ssh）连看不到它。ssh 远端本就不经 credential helper。
 *
 * **不把系统那份 helper 清掉**（gitconfig 里 Git for Windows 写着 `credential.helper = manager`）。
 * 清空 helper 列表只能用**空串值**（git 文档给的唯一重置写法），而 git 的 GIT_CONFIG_* 契约写着
 * 「Any missing key or value is treated as an error」——空串在子进程 env 里会不会被当成「没有值」
 * 是实现相关的一件事（Windows 上 libuv 对空串 env 变量历来不可靠）。一旦被判成缺失，git 直接
 * 报错，那会让**每一次带令牌的推送都硬失败**。收益（抢在系统凭据之前）不抵这个风险，所以不这么做。
 * `gh auth setup-git` 走的也是同一条路（只往该 URL 上下文挂自己那条 helper，不清空别人的）。
 *
 * 后果如实记着：git 按 `credential.helper` 的出现顺序依次询问，任一条给出完整 username +
 * password 就停；GIT_CONFIG_* 注入的配置位于所有配置文件之上。所以**本机若已有可用的 github.com
 * 凭据**，系统那份可能先应答（那次用系统凭据）；本机没有该远端凭据时（换台机器那种情形）就落到
 * 本 App 这条。两者都能推，差别只在用谁的凭据。
 *
 * ## helper 片段做什么
 *
 * 只应答 `get`（给 username / password 两行），`store` / `erase` 一律不做事：App 令牌是进程内的
 * 短期凭据，不该被 git 存进任何凭据库。令牌为空时什么都不输出，让 git 自己报「读不到凭据」。
 *
 * ## 注入范围收窄
 *
 * 只有「确实要访问远端」的 git 调用才拿得到令牌（见 shouldInjectGitCredential）：`exec` 是任意
 * 参数透传，而凭据助手本身就能把 env 里的东西打出来，所以 `credential` / `config` 这类子命令、
 * 以及带 `-c` / `--exec-path` 的命令行一律不注入。另外注入时摘掉 git 的 HTTP 调试变量——它们会
 * 把 Authorization 头 dump 进 stderr，而 stderr 是工具返回值的一部分。
 */
import { getToolSecretToken } from "./context.js";

/** 令牌经 env 递给 git 子进程（helper 片段读它）。它不出 App 进程树。 */
export const GIT_TOKEN_ENV = "GITHANA_GIT_TOKEN";

/** 生效范围：github.com 的 https 远端（协议与主机都要对得上）。 */
export const GITHUB_CREDENTIAL_CONTEXT = "https://github.com";

/** 带 URL 上下文的配置键：`credential.<URL>.helper`。 */
export const GITHUB_HELPER_KEY = "credential." + GITHUB_CREDENTIAL_CONTEXT + ".helper";

/**
 * 凭据机制的一句话说明（各动作的「远端认证失败」引导共用一份，避免五处各写一遍后漂）。
 * 措辞只讲现状：已登录时用 App 令牌；未登录时不注入，因此仍可能落在系统 Git 凭据上。
 */
export const GIT_CREDENTIAL_NOTE =
  "本 App 把 GitHub App 令牌经 credential helper 注入 git 子进程（只对 github.com 的 https 远端，" +
  "令牌不进命令行、不进远端 URL、不进 gitconfig）；未登录时不做这一步，回落到本机 Git 凭据（Git Credential Manager）";

/**
 * credential helper 的 shell 片段。
 *
 * 只认 `get`：输出 username 与 password 两行（git 的 credential 协议），令牌从 env 读。
 * `store` / `erase` 直接退出——App 令牌不进凭据库。给出完整一对后 git 即停止询问其它 helper；
 * 系统那份 helper 在本机没有 github.com 可用凭据时不会给出答案，于是落回这一条。
 */
const CREDENTIAL_HELPER_SNIPPET =
  "!f() { if [ \"$1\" = get ] && [ -n \"$GITHANA_GIT_TOKEN\" ]; then " +
  "echo username=x-access-token; echo \"password=$GITHANA_GIT_TOKEN\"; fi; }; f";

/**
 * 该 URL 是否走本模块注入的 App 令牌（github.com 的 https）。
 *
 * 判据与配置键的 URL 上下文一致：协议 https + 主机恰为 github.com（可带 userinfo）。
 * 用它的地方是**引导文案**（告诉调用方这次推的是哪条凭据路径）；真正的生效范围由 git 自己按
 * 配置键的 URL 上下文判定，不靠这个函数把关。
 *
 * @param {unknown} url 远端 URL（`git remote get-url` 的输出，或调用方显式给的 URL）
 * @returns {boolean}
 */
export function isGitHubHttpsUrl(url) {
  const s = url !== undefined && url !== null ? String(url).trim() : "";
  if (!s) return false;
  return /^https:\/\/(?:[^@/]*@)?github\.com(?:[:/]|$)/i.test(s);
}

/**
 * 需要的 git 子命令（只有这些可能真的去问凭据助手）。
 *
 * **为什么要有这张表而不是「凡 git 子进程都注入」**：`githana_git(action="exec")` 是任意参数透传，
 * 而 git 的 credential helper 本身就能把 env 里的东西打到 stdout / stderr——`git credential fill`
 * 配一个 `-c credential.helper='!echo password=$GITHANA_GIT_TOKEN'` 就能把令牌原样送进工具返回值。
 * 所以令牌只在「这个子命令确实要访问远端」时才进子进程 env：`credential` / `config` 这类能把它
 * 打印出来的子命令按构造拿不到它。
 *
 * 表里**刻意不含** `submodule` / `archive` / `request-pull`：那几个能借参数跑任意命令
 * （`submodule foreach` 就是显式跑 shell），令牌进它们的 env 等于给了一条 `printenv` 就拿走的通道。
 * `remote` 也不在表里——只读 remote 配置不需要凭据；要抓远端提交用 `fetch`（在表里）。
 * 留下的五个都是 https 上不会执行任意命令的取远端动作，正好覆盖本 App 需要的那几处。
 */
const CREDENTIAL_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

/**
 * 会让这次调用**不可信**的全局选项 / 参数形态，命中其一就不注入。
 *
 *   · `-c <name>=<value>` / `--config-env`——它们优先于 GIT_CONFIG_* 注入的配置（git 文档：env
 *     配置「会被任何经 `git -c` 显式传入的选项覆盖」），所以能把 helper 换成任意 shell 片段；
 *   · `--exec-path`——它换的是 git 找**外部子命令**的目录，换成可写目录后
 *     `git-remote-https` 之类的助手会从那里加载，令牌就在那个进程的 env 里；
 *   · `ext::` 形态的 URL——`git-remote-ext` 会在**本机**跑 URL 里给的命令，那是又一条
 *     「本机任意命令 + 能读到 env」的路（`fetch` / `push` 都收这种 URL）。
 *
 * 命中就不注入：宁可回落系统凭据（只是换台机器推不上去），也不把令牌交给一条能改写自己运行
 * 环境的调用。判据只看参数里有没有这些形态，不解析它们的值——值里没有令牌。
 */
const NO_INJECT_OPTS = [
  /^-c(=|$)/, /^-c[^-]/, /^--config-env(=|$)/, /^--exec-path(=|$)/, /ext::/,
];

/** 带独立取值的全局选项（解析子命令时要跳过它们的值）。 */
const GLOBAL_VALUE_OPTS = new Set([
  "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
  "--attr-source", "--list-cmds",
]);

/**
 * 解析 `git <全局选项…> <子命令>` 里的子命令；`args` 不含可执行文件名。
 * 解析不出来返回 ""（按「不注入」处理，保守）。
 */
export function gitSubcommand(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (GLOBAL_VALUE_OPTS.has(t)) {
      i += 1; // 跳过它的值
      continue;
    }
    if (t.startsWith("-")) continue; // 其余旗标（含 --git-dir=… 这类内联取值）
    return t;
  }
  return "";
}

/**
 * 这次 git 调用该不该注入 App 令牌。
 *
 * 三条都要成立：bin 是 git、子命令在表里、命令行里没有能改写运行环境的全局选项。
 * 任一不成立就不注入——那时 git 仍走系统凭据，只是换台机器推不上去，不会静默做错事。
 *
 * @param {string} bin 可执行文件名（runCli 的 bin）
 * @param {string[]} args 参数数组（不含可执行文件名）
 * @returns {boolean}
 */
export function shouldInjectGitCredential(bin, args) {
  if (String(bin || "") !== "git") return false;
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (list.some((a) => NO_INJECT_OPTS.some((re) => re.test(a)))) return false;
  return CREDENTIAL_SUBCOMMANDS.has(gitSubcommand(list));
}

/**
 * 会把 HTTP 报文（含 `Authorization` 头，即令牌）打进 stderr 的调试变量。
 *
 * git 的 `GIT_TRACE_CURL` / `GIT_CURL_VERBOSE` 会把逐条请求头 dump 出来，而 runCli 会把子进程
 * stderr 原样收进工具返回值——继承来的这两个变量一旦是开的，令牌就会顺着返回值进对话流与日志。
 * 所以注入凭据时把它们从子进程 env 里摘掉：这几条本就是调试用，摘掉不影响任何正常功能。
 * （`GIT_TRACE_CURL_NO_DATA` 只是把数据体省掉，头部照打，所以同样摘。）
 */
const REDACT_ENV_KEYS = ["GIT_TRACE_CURL", "GIT_TRACE_CURL_NO_DATA", "GIT_CURL_VERBOSE"];

/**
 * 构造要注入的配置对（不含令牌字节）。
 *
 * 只挂这一条，**不清空系统 helper**（原因见文件头注：清空只能给空串值，而那个值一旦被判成
 * 「缺失」，git 就会硬报错；`gh auth setup-git` 也是只挂自己的）。git 按序询问各 helper，
 * 本机没有 github.com 可用凭据时就会落到这一条。
 *
 * @param {string} token 明文令牌（空 → 不注入）
 * @returns {Array<[string, string]>}
 */
export function githubCredentialPairs(token) {
  if (!token) return [];
  // 带 URL 上下文的键：git 只在协议 + 主机都匹配时把它算进这次凭据查找，别的远端看不到它。
  // 片段里只有变量名，令牌零字节进配置（经 env 递）。
  return [[GITHUB_HELPER_KEY, CREDENTIAL_HELPER_SNIPPET]];
}

/**
 * 把 App 令牌接进子进程 env（沿 GIT_CONFIG_* 机制追加配置对，并在有令牌时带上 env）。
 *
 * 幂等，可反复调用（每次 spawn 现算）；无令牌时**什么都不改**——那种情况下不注入凭据，
 * git 仍走系统 Git Credential Manager，与登录之前的行为一致。
 *
 * @param {Record<string, string>} env 待注入的 env 对象（原地修改）
 * @param {string} token 明文令牌；缺省取进程内缓存的令牌
 * @returns {boolean} 是否注入
 */
export function applyGitHubCredential(env, token) {
  const value = token === undefined ? getToolSecretToken() : token;
  const pairs = githubCredentialPairs(value ? String(value) : "");
  if (pairs.length === 0) return false;

  // 先掐掉会把令牌 dump 进 stderr 的调试变量（它们会顺着工具返回值出去）。
  for (const key of REDACT_ENV_KEYS) delete env[key];

  const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
  let n = Number.isFinite(baseCount) && baseCount >= 0 ? baseCount : 0;
  for (const [key, pairValue] of pairs) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = pairValue;
    n += 1;
  }
  env.GIT_CONFIG_COUNT = String(n);
  // 令牌本体只在这里出现：进子进程 env，helper 片段读它。config 值、命令行、远端 URL 都不含它。
  env[GIT_TOKEN_ENV] = String(value);
  return true;
}
