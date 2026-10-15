// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/remote-helper-shim.js — 把自写的 remote helper 接给 git（包装脚本 + 注入判据）。
 *
 * ## 这一层解决什么
 *
 * git 按 **PATH** 找 `git-remote-<transport>`（见 gitremote-helpers(7) 的 INVOCATION），
 * 它只接受「一个可执行文件」，而 helper 是 `.mjs`，需要一个 node 来跑。所以中间垫一层包装：
 *
 *   <dataDir>/.runtime-tmp/remote-helper/git-remote-githana   （两个平台同一个名字）
 *
 * **文件名必须是 git 要找的那个**，且**两个平台都是无扩展名 + sh 形态**：这是 PATH 查找的
 * 唯一凭据，与签名 shim 那种「由 gpg.program 指向绝对路径」的用法不同，名字不能自选。
 * 所以包装单独占一个目录——前置进 PATH 的目录里只该有这一个东西，混进别的可执行文件
 * 等于把它们的优先级也一起改了。
 *
 * ## 为什么 Windows 上也是无扩展名 shebang 脚本（实测）
 *
 * **`git-remote-githana.cmd` 在 git for Windows 下不会被调起**：实测把三种形态放进 PATH，
 * git 只认无扩展名的那个，`.cmd` 那一档 git 报
 * `git: 'remote-githana' is not a git command` + `fatal: remote helper 'githana' aborted session`。
 * 也就是说 git 找 remote helper **不走 PATHEXT 那套 shell 解析**，只按字面名字找文件。
 *
 * 所以 Windows 也写无扩展名的 `#!/bin/sh` 脚本：git for Windows 自带 msys sh
 * （在 `<git>/usr/bin`，git 拉起 helper 时的运行环境里一定有），由它解析 shebang。
 * 这也正是 git 自己那些 shell 实现的内建命令（`git-submodule` 等）的形态。
 *
 * 脚本里的路径一律**正斜杠 + 单引号**（见 shQuote）：正斜杠两边都认，单引号让 sh 不做任何展开，
 * 于是带空格或带 `$` 的路径（`C:/Program Files/…`）都原样传给 node。
 *
 * 内含的 node 与 helper 路径**每次现算**（宿主升级会换 node 路径，安装目录也可能变，
 * 写死就会指向不存在的位置）。落点在运行期临时目录（<dataDir>/.runtime-tmp，可写；
 * 安装目录只读），与签名 shim 的包装同处一地，都是「现写现用、用完即弃」的产物。
 *
 * ## 注入的三件事（同进同退）
 *
 * buildBinEnv 在 spawn git 时按下面的 applyRemoteHelper 一次做完，任一件单独做都是错的：
 *
 *   1. `NODE_OPTIONS` 追加 `--allow-net`——helper 由 git 启动、继承 Node Permission Model，
 *      不给它就没法联网（实测 fetch 报 ERR_ACCESS_DENIED）；
 *   2. 注入 `url.githana::.insteadOf = https://github.com/`——把 github.com 的 https 远端
 *      交给本 App 的 helper（走 GIT_CONFIG_* 机制，改不到文件也不脏文件）；
 *   3. 把包装目录前置进 PATH——git 才找得到 `git-remote-githana`。
 *
 * 另把 dataDir 经 `GITHANA_DATA_DIR` 递给 helper（路径不是机密，令牌才是；helper 自己读
 * `<dataDir>/credential.json` 解 DPAPI，令牌因此不进任何子进程的 env）。
 * ## `--allow-net` 只在权限模型下追加
 *
 * 它是权限模型下的放行项，单独给会报 `ERR_MISSING_OPTION`（实测：普通 node 进程加
 * `--allow-net` 直接启动失败）。所以按 `process.permission` 判——那个对象只在 `--permission`
 * 生效时才有，正是「本进程在权限模型下」的现成判据（与 tools/lib/rest.js 同一口径）。
 * 源码树里跑（无权限模型）不加，装机后跑（AppHost）才加。
 *
 * 注意 NODE_OPTIONS 只被 **node 进程**读，而 git 是原生可执行文件：这个变量对 git 本身无效，
 * 它的作用是经 git 的 env 传给 helper。所以「追加」在这里是安全的。
 *
 * ## 触发面（只对确实要取远端的 git 调用）
 *
 * 判据沿用被替换的 credential helper 那一套（见 shouldInjectRemoteHelper）：`exec` 是任意
 * 参数透传，而 `-c` / `--config-env` / `--exec-path` / `ext::` 这些形态能把 git 的运行环境
 * 整个改写，注入进去等于把 insteadOf 与 PATH 交给一条自己改写自己的调用。
 *
 * 注入的子命令是 spec D5 的五条（`push` / `fetch` / `pull` / `clone` / `ls-remote`）：
 * helper 报 `connect`，读写一条通吃，所以这些动作都走它。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot } from "./bin.js";
import { getToolDataDir } from "./context.js";

/** transport 名（git 找的是 `git-remote-githana`）。 */
export const HELPER_SCHEME = "githana";

/** 生效范围：github.com 的 https 远端（insteadOf 的值就是它）。 */
export const GITHUB_HTTPS_PREFIX = "https://github.com/";

/** 带 transport 上下文的配置键：`url.<base>.insteadOf`。 */
export const INSTEAD_OF_KEY = "url." + HELPER_SCHEME + "::.insteadOf";

/** dataDir 经 env 递给 helper（与签名 shim 的 GITHANA_KEY_FILE 同一手法）。 */
export const DATA_DIR_ENV = "GITHANA_DATA_DIR";

/**
 * 远端认证机制说明（各动作的「远端认证失败」引导共用一份，避免多处各写一遍后漂）。
 * helper 报 `connect`，读写一条通吃，所以 push 与 fetch / clone / pull / ls-remote 全走它。
 */
export const GIT_AUTH_NOTE =
  "本 App 的远端传输走自写的 git remote helper（helper 自己解 GitHub App 令牌并发 HTTPS，" +
  "令牌不进命令行、不进远端 URL、不进 gitconfig、不进 git 子进程的 env）";

/**
 * fetch 侧的认证机制说明。与 push 同一条路（helper 的 `connect` 中继），
 * 保留独立常量是为了让「取远端」与「推远端」两处引导各自能独立改文案。
 */
export const GIT_FETCH_AUTH_NOTE =
  "本 App 的 fetch / clone / pull / ls-remote 走自写的 git remote helper（与 push 同一条 " +
  "connect 中继，helper 自己解 GitHub App 令牌并发 HTTPS）" +
  "——换台机器也能取，请到 GitHana 设置页点「用 GitHub 登录」完成授权";

/** helper 在交付树里的位置（bin/ 与 app.mjs 同层）。 */
function helperScriptCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = [path.join(pluginRoot(), "bin", "git-remote-helper.mjs")];
  // 源码树兜底：未构建时（开发态）直接跑 tools/lib/ 下那份。
  const src = path.join(here, "git-remote-helper.mjs");
  if (!out.includes(src)) out.push(src);
  return out;
}

/** 定位 helper 脚本；找不到返回 null（调用方不注入 insteadOf，git 走原生路径）。 */
export function resolveHelperScript() {
  for (const p of helperScriptCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 许可根外或路径不可读：试下一个候选 */
    }
  }
  return null;
}

/** 运行期临时目录（<dataDir>/.runtime-tmp），与 sign-shim 同一落点。 */
function tmpDirPath(dataDir) {
  return path.join(dataDir || "", ".runtime-tmp");
}

/**
 * 包装脚本所在的目录（前置进 PATH 的那个）。
 *
 * **单独一层子目录**：前置进 PATH 的目录里只该有 `git-remote-githana` 一个东西——若直接把
 * `.runtime-tmp` 前置进去，那个目录里的签名包装（gpg.shim.cmd / gpg.shim.sh）也会一并获得
 * PATH 优先级。
 */
export function helperDirPath(dataDir) {
  return path.join(tmpDirPath(dataDir), "remote-helper");
}

/**
 * 包装脚本的文件名。**必须是 git 要找的那个名字，且两个平台都是无扩展名**。
 *
 * Windows 上不能用 `.cmd`：实测 git 找 remote helper 不走 PATHEXT，带扩展名的那个根本不会
 * 被调起（报 `git: 'remote-githana' is not a git command`）。所以两个平台同名。
 */
function wrapperName() {
  return "git-remote-githana";
}

/**
 * 把路径转成脚本里能安全内联的形态。
 *
 * 两条都要做：
 *   1. **一律正斜杠**——msys sh 与 Windows node 都接受正斜杠；反斜杠在引号里虽多数字面处理，
 *      但遇到 `\$` 这类序列会被 sh 解释掉，统一成正斜杠就没有这条歧义。
 *   2. **用单引号包住**——sh 的单引号里**一切都不展开**（`$` / 反引号 / `"` / `\` 全是字面量），
 *      所以带空格的 Windows 路径（`C:/Program Files/...`）与带 `$` 的路径都安全。
 *      双引号做不到后者：`"C:/a$b"` 里 `$b` 会被 sh 当变量展开。
 *      路径里真有单引号时按 sh 的标准写法 `'\''` 断开再拼（用户目录带撇号的情形）。
 *
 * 这是脚本**唯一**要小心的注入面：路径来自宿主（dataDir、node 安装位），不是我们拼的常量。
 */
function shQuote(p) {
  const forward = String(p || "").replace(/\\/g, "/");
  return "'" + forward.replace(/'/g, "'\\''") + "'";
}

/**
 * 确保包装脚本存在且内容为当前安装的现算值；返回**包装目录**（要前置进 PATH 的那个）。
 *
 * 内容每次覆盖写（幂等）：node 路径或 helper 路径变了，下一次 spawn 就会用新的。
 * helper 脚本不存在或写不成时返回 null——调用方据此**不注入 insteadOf**，让 git 走原生路径，
 * 而不是把一个指向不存在文件的目录塞进 PATH（那会让推送报 cannot spawn 之类的怪错）。
 *
 * body 两个平台同一形态（`#!/bin/sh` + `exec`），原因见文件头注：Windows 上 git 也只认
 * 无扩展名的 shebang 脚本，由 git for Windows 自带的 msys sh 解析。
 *
 * @param {string} dataDir
 * @returns {string|null}
 */
export function ensureHelperWrapper(dataDir) {
  if (!dataDir) return null;
  const script = resolveHelperScript();
  if (!script) return null;
  const dir = helperDirPath(dataDir);
  const target = path.join(dir, wrapperName());
  const body = `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // utf8 且**不带 BOM**：shebang 必须是文件的前两个字节，BOM 会让 sh 认不出它。
    fs.writeFileSync(target, body, "utf8");
    // POSIX 需要可执行位。best-effort：Windows 上 chmod 只切只读位（msys sh 按 shebang 走，
    // 不看该位），万一它在某个平台上失败，也不该把整个接线判死——那会让推送静默回落原生路径。
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* 拿不到可执行位：POSIX 上由调用方环境决定，不影响 Windows */
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * 该 URL 是否走本 App 的 helper（github.com 的 https）。
 *
 * 判据与 insteadOf 的值一致：协议 https + 主机恰为 github.com（可带 userinfo）。
 * 用它的地方是**引导文案**（告诉调用方这次推的是哪条凭据路径）；真正的生效范围由 git 自己
 * 按 insteadOf 的前缀匹配判定，不靠这个函数把关。
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
 * 会让这次调用**不可信**的全局选项 / 参数形态，命中其一就不注入。
 *
 *   · `-c <name>=<value>` / `--config-env`——它们优先于 GIT_CONFIG_* 注入的配置（git 文档：
 *     env 配置「会被任何经 `git -c` 显式传入的选项覆盖」），所以能把 insteadOf 与 PATH 换掉；
 *   · `--exec-path`——它换的是 git 找**外部子命令**的目录，换成可写目录后
 *     `git-remote-githana` 会从那里加载，那就是又一条「本机任意命令」的路；
 *   · `ext::` 形态的 URL——`git-remote-ext` 会在**本机**跑 URL 里给的命令。
 *
 * 命中就不注入：宁可走 git 原生路径（那条路本来就通），也不让一条能改写自己运行环境的调用
 * 拿到我们的 PATH 与配置注入。判据只看参数里有没有这些形态，不解析它们的值。
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
 * 注入范围：确实要访问 github.com 的全部取远端动作。
 *
 * helper 报的是 `connect`（全双工中继，见 git-remote-helper.mjs），**读写一条通吃**，
 * 所以 push 与 fetch / clone / pull / ls-remote 都走它——不再是「只有 push」。
 *
 * 表里**刻意不含** `submodule` / `archive` / `request-pull`：那几个能借参数跑任意命令
 * （`submodule foreach` 就是显式跑 shell），接上 helper 等于多给一条通道。`remote` 也不在
 * 表里——只读 remote 配置不访问远端；要抓远端提交用 `fetch`（在表里）。
 */
const HELPER_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

/**
 * 这次 git 调用该不该接上 App 的 remote helper。
 *
 * 三条都要成立：bin 是 git、子命令在表里、命令行里没有能改写运行环境的全局选项。
 * 任一不成立就不注入——那时 git 走原生路径与系统凭据，不会静默做错事。
 *
 * @param {string} bin 可执行文件名（runCli 的 bin）
 * @param {string[]} args 参数数组（不含可执行文件名）
 * @returns {boolean}
 */
export function shouldInjectRemoteHelper(bin, args) {
  if (String(bin || "") !== "git") return false;
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (list.some((a) => NO_INJECT_OPTS.some((re) => re.test(a)))) return false;
  return HELPER_SUBCOMMANDS.has(gitSubcommand(list));
}

/** 往 PATH 前置一个目录（保留原有内容）。 */
function prependPath(env, dir) {
  const cur = env.PATH || "";
  env.PATH = dir + path.delimiter + cur;
}

/**
 * 把 remote helper 接进子进程 env（D4 的三件事 + dataDir）。
 *
 * 幂等，可反复调用（每次 spawn 现算）。任一前提不满足（无 dataDir、helper 脚本不在、
 * 包装写不成）就**什么都不改**——那种情况下 git 走原生路径，与接上之前的行为一致，
 * 不会留下「PATH 里有包装、配置里没 insteadOf」这类半截状态。
 *
 * @param {Record<string, string>} env 待注入的 env 对象（原地修改）
 * @returns {boolean} 是否注入
 */
export function applyRemoteHelper(env) {
  const dataDir = getToolDataDir();
  if (!dataDir) return false;
  const dir = ensureHelperWrapper(dataDir);
  if (!dir) return false;

  // 1) 网络放行：helper 继承权限模型，不给它就连不上 github.com。
  //    只在权限模型下追加（单独给 --allow-net 会 ERR_MISSING_OPTION，实测）。
  if (process.permission) {
    const cur = env.NODE_OPTIONS || "";
    if (!/(^|\s)--allow-net(\s|$)/.test(cur)) {
      env.NODE_OPTIONS = (cur ? cur + " " : "") + "--allow-net";
    }
  }

  // 2) insteadOf：只重写前缀匹配的 URL，别的远端（GitLab / 自建 / ssh）一律不受影响。
  //    走 GIT_CONFIG_* 机制，它在所有配置文件之上生效，改不到文件也不脏文件。
  const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
  const n = Number.isFinite(baseCount) && baseCount >= 0 ? baseCount : 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = INSTEAD_OF_KEY;
  env[`GIT_CONFIG_VALUE_${n}`] = GITHUB_HTTPS_PREFIX;

  // 3) PATH 前置：git 才找得到 git-remote-githana。
  prependPath(env, dir);

  // helper 是独立进程，不知道 dataDir：路径经 env 传它（路径不是机密，令牌才是）。
  env[DATA_DIR_ENV] = dataDir;
  return true;
}

