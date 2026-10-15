// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/git-remote-helper.mjs — 自写的 git remote helper（transport = githana）。
 *
 * ## 它是什么
 *
 * git 把 URL 形如 `<transport>::<address>` 的远端交给 `git-remote-<transport>` 这个
 * **外部程序**处理（见 gitremote-helpers(7)）。本文件就是 `githana` 与 `githana-push` 两个
 * scheme 共用的底层实现，随包进 `bin/git-remote-helper.mjs`，运行期由
 * tools/lib/remote-helper-shim.js 生成的两个包装脚本拉起（各传一个模式参数）。
 *
 * 于是 github.com 的 https 远端整条传输层落在本进程里：**令牌只在这里**，git 全程不接触它
 * （不进 git 子进程 env、不进命令行、不进远端 URL、不进 gitconfig、不进任何文件）。
 *
 * ## 两条路：取侧 `stateless-connect`，push 侧 `connect`
 *
 * 本文件由两个包装脚本拉起（`git-remote-githana` 传 `fetch`、`git-remote-githana-push` 传
 * `push`，见 tools/lib/remote-helper-shim.js），argv 里的模式决定它报哪个能力、走哪条中继。
 * 能力路由实测（这就是必须两个 scheme 的原因）：
 *
 *   connect                     → fetch 走 connect ❌；push 走 connect ✅
 *   stateless-connect           → fetch 走 stateless-connect ✅；push 落到 list ❌
 *   connect + stateless-connect → git 一律选 connect（单 scheme 报两个能力没用）
 *
 * **取侧报 `stateless-connect`**：它是 git 为**无状态传输**（smart HTTP 那类）设计的能力，与
 * GitHub 的 smart HTTP 一一对应；而 `connect` 是有状态全双工，git 在需再谈时的第二轮只发一个
 * `done`，无状态服务端无从自足处理。参考 git 自带的 `git-remote-http`：它报
 * `stateless-connect/fetch/get/option/push/check-connectivity/object-format`，**不报 connect**。
 *
 * **push 侧仍报 `connect`**：receive-pack 协议没有协商阶段（客户端一次发完命令 + packfile，
 * 服务端回一次 report-status 就结束），单轮下 `connect` 是对的，而且只有这条形态能让 git 的
 * 原生 send-pack 把 packfile 经 stdin 送进来。gitremote-helpers(7) 的 `push` / `fetch` 能力
 * 是另一条路——**packfile 根本不从 helper 的 stdin 进来**（实测：桩 helper 报 `push` 时 git 只
 * 发 `list for-push` / `push <src>:<dst>`，stdin 上再无一个字节），所以那条路不能用。
 *
 * 取侧的交互（实测跑通的最小形状）：
 *
 *   capabilities                              → 回 `stateless-connect`
 *   stateless-connect git-upload-pack         → 回空行，然后逐轮：
 *     GET  <base>/info/refs?service=git-upload-pack（带 `Git-Protocol: version=2`）→ 广告写 stdout
 *     读请求直到 **flush-pkt（`0000`）** → POST <base>/git-upload-pack
 *     响应体整段写 stdout → 再写一个 **`0002`（response-end-pkt）**
 *     请求读到 EOF / 空 → 会话结束，退出
 *
 * pkt-line 定界符（gprotocol-v2）：`0000` = flush、`0001` = delim、`0002` = response-end。
 * 该写 `0002` 的地方写成 `0001`，git 报 `expected response end packet`。
 *
 * 不带 `Git-Protocol: version=2` 头拿到的是 v1 广告，git 会报
 * `expected response end packet after ref listing`——**GET 与 POST 都要带**。
 *
 * push 侧的交互：
 *
 *   capabilities                          → 回 `connect`
 *   connect git-receive-pack              → 回空行，然后：
 *     GET  <base>/info/refs?service=git-receive-pack（**不带** version=2，receive-pack 无 v2）
 *     读请求体直到 **EOF** → POST <base>/git-receive-pack → 响应写 stdout → 退出
 *
 * **广告要剥掉 HTTP 专有的前缀**：smart HTTP 的广告以 pkt-line 包着一行
 * `# service=<service>\n` 加一个 `0000` 开头（实测 34 字节）。那是 HTTP 传输层的东西，
 * 原生协议里没有它——不剥，git 直接报
 * `fatal: protocol error: unexpected '# service=git-upload-pack'`。剥法是读长度、看内容是不是
 * `# service=` 起头，是就跳过并按需跨过紧随的 `0000`（**不硬编码 34**，见 stripServicePreamble）。
 * 剥完直接写 stdout，广告后**不需要**额外的 end packet。
 *
 * 广告与响应都**原样写 stdout**（Buffer 直写，不经过 UTF-8 字符串）。响应可能很大
 * （实测 12MB 的 PACK），所以按块流式写、绝不截断。
 *
 * ## 请求体怎么定界（不再靠静默窗口）
 *
 * 两个 service 都改成**结构定界**，没有任何「连续 N 秒无字节就算写完」的启发式：
 *
 *   · 取侧：按 pkt-line 结构读到 flush-pkt（`0000`）为止；
 *   · push 侧：读到 **EOF**。实测 push 的请求体形态是
 *     `198B（命令 pkt-line + flush-pkt）→ 23448B（PACK…）→ 20B → stdin EOF`，
 *     三种 push 形态（建分支带 pack / 删分支无 pack / 重复删除）**全部 EOF 可靠到达**，
 *     块间最大间隔仅 141ms。原先按「连续 15s 无字节」定界会在 git 生成 packfile 停顿超
 *     15s 时把请求体截断成半个 pack，远端报 unpack 失败。
 *
 * ## 凭据从哪来
 *
 * `<dataDir>/credential.json`（lib/secret.js 写的 DPAPI 密文），用 lib/dpapi.js 解开拿
 * `accessToken`。dataDir 经 `GITHANA_DATA_DIR` 递给本进程——**路径不是机密，令牌才是**。
 * 认证按 GitHub 的口径发 `Authorization: Basic base64("x-access-token:<token>")`，GET 与 POST
 * 都带。令牌只在本进程内存里，不进日志、不进返回值、不进任何文件。
 *
 * ## 网络权限
 *
 * 本进程由 git 启动，继承 Node Permission Model（`--permission` 经 NODE_OPTIONS 传染）。
 * 默认不能联网（实测 fetch 报 ERR_ACCESS_DENIED），所以 tools/lib/remote-helper-shim.js
 * 在 spawn git 时往 NODE_OPTIONS 追加 `--allow-net`，由 git 传给本进程。
 *
 * ## stdout 只走协议
 *
 * stdout 只有协议字节（广告、响应体），诊断一律走 stderr——git 会把本进程的 stderr
 * 原样转给用户，混进 stdout 会直接破坏协议。
 */
import fs from "node:fs";
import path from "node:path";
import { dpapiUnprotect } from "../../lib/dpapi.js";

/** 远端主机与地址前缀：本 helper 只服务 github.com 的 https。 */
const GITHUB_HOST = "github.com";
const GITHUB_HTTPS_PREFIX = "https://github.com/";

/** dataDir 经 env 递给本进程（与签名 shim 的 GITHANA_KEY_FILE 同一手法）。 */
const DATA_DIR_ENV = "GITHANA_DATA_DIR";

/** 凭据文件（lib/secret.js 的落点）与它记录的加密算法标识。 */
const SECRET_FILE = "credential.json";
const DPAPI_ALG = "dpapi-current-user";

/** 请求 GitHub 时的 User-Agent（GitHub 要求非空）。 */
const USER_AGENT = "githana-git-remote-helper";

/** 本 helper 接受的两个 service（git 在 connect / stateless-connect 里给的 service 名）。 */
const SERVICE_RECEIVE = "git-receive-pack";
const SERVICE_UPLOAD = "git-upload-pack";

/**
 * 运行模式，argv[0]（包装脚本传入；见 tools/lib/remote-helper-shim.js）。
 *
 * 取侧与 push 侧是两个 scheme、两个包装脚本，所以模式是**进程级的常量**，不是运行时判断的：
 * 一个进程只服务一种形态，报一个能力。
 */
const MODE_FETCH = "fetch";
const MODE_PUSH = "push";

/**
 * 两个能力名：取侧报 stateless-connect（无状态，对齐 GitHub 的 smart HTTP），
 * push 侧报 connect（有状态全双工，让 git 的 send-pack 把 packfile 经 stdin 送进来）。
 */
const CAP_STATELESS_CONNECT = "stateless-connect";
const CAP_CONNECT = "connect";

/** 取侧的协议版本头：不带会拿到 v1 广告，git 报 `expected response end packet after ref listing`。 */
const GIT_PROTOCOL_V2 = { "Git-Protocol": "version=2" };

/** response-end-pkt（gprotocol-v2）：取侧每轮 POST 的响应之后要写它（`0001` 是 delim，写错 git 报错）。 */
const RESPONSE_END_PKT = Buffer.from("0002", "ascii");

/**
 * 连接建立后等 git 送请求体**首字节**的窗口（毫秒）。
 *
 * git 收到空行后基本立刻开始写（它只是在发命令），这个窗口只用来把「git 其实没打算在这根
 * 管道上写东西」变成一句可读诊断，而不是让整个操作挂死。**它只覆盖首字节**——请求体的其余
 * 部分由结构定界（取侧到 flush-pkt，push 侧到 EOF），不受这个值影响。
 */
const REQUEST_FIRST_BYTE_TIMEOUT_MS = 15000;

/**
 * push 侧请求体的**防御上限**（毫秒）：只防「git 一直不关管道」这种意外形态，**不参与定界**。
 *
 * 定界一律是 EOF（见 StdinReader.readToEof）。取 10 分钟是因为实测正常的 packfile 生成停顿
 * 最多 141ms，而大仓库/慢磁盘上秒级停顿是正常的——10 分钟不可能是正常停顿，撞到它就是
 * 「管道不会结束」，那时**报错退出**，绝不把那截请求体当完整请求发出去（截断半个 pack 会被
 * 远端报 unpack 失败，正是要修掉的行为）。
 */
const PUSH_BODY_IDLE_LIMIT_MS = 600000;

/** 诊断一律走 stderr，stdout 只走协议。 */
function warn(msg) {
  writeErr("[githana-remote-helper] " + msg + "\n");
}

/**
 * 同步小睡（Atomics.wait 在共享内存上等，不起定时器、不占事件循环）。
 * 只给 stdout / stderr 暂时写不进去时的退避用。
 */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_CELL, 0, 0, ms);
  } catch {
    /* 不支持就退化成忙等一小会儿 */
  }
}

/**
 * 往 stderr 写诊断文本。
 *
 * 用**同步写**：`fail()` 写完就 `process.exit()`，而 `process.stderr.write` 对管道是异步的，
 * 那些字节会在退出时被丢掉——用户看到的就是「失败但没有任何原因」。诊断文本都很小，
 * 同步写不会阻塞出问题。
 */
function writeErr(text) {
  const buf = Buffer.from(String(text), "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(2, buf, off, buf.length - off);
    } catch (e) {
      if (e && e.code === "EAGAIN") {
        sleepSync(5);
        continue;
      }
      return; // stderr 不可写（EPIPE 等）：诊断丢了就丢了，不影响主流程
    }
  }
}

/** 致命错误：说明原因后退非零（git 会把 stderr 转给用户）。 */
function fail(msg, code = 1) {
  warn(msg);
  process.exit(code);
}

/** 读环境变量（AppHost 里读不存在的键会抛错，故包一层）。 */
function readEnv(name) {
  try {
    const v = process.env[name];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** 错误对象 → 可读文本。 */
function msgOf(e) {
  return String((e && e.message) || e);
}

// ───────────────────────────── 凭据 ─────────────────────────────

/**
 * 从 `<dataDir>/credential.json` 解出明文令牌。
 *
 * 解不开的每一种情况都给可读原因并退非零——不静默失败、不回落系统凭据（本进程根本不在
 * git 的凭据子系统里）。
 */
function loadToken() {
  const dataDir = readEnv(DATA_DIR_ENV);
  if (!dataDir) {
    fail(
      "did not receive " + DATA_DIR_ENV + ": cannot locate the App data directory, so the credential cannot be read.\n" +
        "Start the operation from GitHana's tool surface (this helper is launched by git, and the App injects dataDir).",
    );
  }
  const file = path.join(dataDir, SECRET_FILE);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(
      "failed to read the credential file (" + file + "): " + msgOf(e) + "\n" +
        "Go to the GitHana settings page, click \"Sign in with GitHub\" to complete authorization, then retry.",
    );
  }
  if (!rec || typeof rec !== "object" || rec.kind !== "oauth" || typeof rec.cipher !== "string" || !rec.cipher) {
    fail(
      "the credential file has no usable OAuth ciphertext (" + file + ").\n" +
        "Go to the GitHana settings page, click \"Sign in with GitHub\" to complete authorization, then retry.",
    );
  }
  if (rec.alg && rec.alg !== DPAPI_ALG) {
    fail(
      "the ciphertext is protected by " + rec.alg + " while this machine's backend is " + DPAPI_ALG + ": cannot decrypt (did you switch machine or user?).\n" +
        "Click \"Sign in with GitHub\" again on this machine.",
    );
  }
  let payload = null;
  try {
    payload = JSON.parse(dpapiUnprotect(rec.cipher));
  } catch (e) {
    fail(
      "failed to decrypt the credential: " + msgOf(e) + " (did you switch machine or user?).\n" +
        "Go to the GitHana settings page and click \"Sign in with GitHub\" again.",
    );
  }
  const token = String((payload && payload.accessToken) || "");
  if (!token) {
    fail(
      "the credential has no accessToken (the authorization record is incomplete).\n" +
        "Go to the GitHana settings page, click \"Sign in with GitHub\" to authorize again.",
    );
  }
  return token;
}

/** GitHub 的 Basic 认证头：用户名固定 x-access-token，密码是令牌。 */
function authHeader(token) {
  return "Basic " + Buffer.from("x-access-token:" + token, "utf8").toString("base64");
}

// ───────────────────────────── 远端地址 ─────────────────────────────

/**
 * 从 git 给的远端地址里认出 `owner/repo`，并拼回 https 基址。
 *
 * 收得下的形态：
 *   · `Nyasers/GitHana.git`             —— 配置好的远端经 insteadOf / pushInsteadOf 重写后的 `<address>`
 *   · `githana::Nyasers/GitHana`        —— 取侧命令行直写时 git 也可能原样传（push 侧是 `githana-push::`）
 *   · `https://github.com/o/r.git`      —— 万一没经重写（或用户直写完整地址）
 *
 * 非 github.com 的地址一律拒绝：本 helper 的凭据只对 github.com 有意义，硬发出去是把令牌
 * 送给别人的服务器。
 */
function parseRemote(remoteUrl) {
  let s = String(remoteUrl || "").trim();
  if (!s) fail("git did not provide a remote address (argv has only the mode argument, no <repository> / <URL>).");
  const schemeForm = /^[A-Za-z][A-Za-z0-9+.-]*::(.*)$/.exec(s);
  if (schemeForm) s = schemeForm[1];
  const httpForm = /^https?:\/\/[^/]+\/(.*)$/i.exec(s);
  if (httpForm) {
    const host = /^https?:\/\/([^/]+)\//i.exec(s);
    if (!host || host[1].toLowerCase() !== GITHUB_HOST) {
      fail("this helper only serves https remotes on " + GITHUB_HOST + " (received: " + remoteUrl + ").");
    }
    s = httpForm[1];
  }
  s = s.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) {
    fail("cannot parse owner/repo out of the remote address: " + remoteUrl);
  }
  const owner = parts[0];
  const repo = parts[1];
  return { owner, repo, base: GITHUB_HTTPS_PREFIX + owner + "/" + repo + ".git" };
}

// ───────────────────────────── 广告前缀 ─────────────────────────────

/**
 * 剥掉 smart HTTP 广告开头的 `# service=<service>` pkt-line 与紧随的 flush。
 *
 * 广告的正常形状是：
 *   `001e# service=git-receive-pack\n` `0000` `<ref 广告…>`
 * 前两段是 HTTP 传输层的包装，**原生协议里没有**——直接转给 git 会报
 * `fatal: protocol error: unexpected '# service=git-upload-pack'`。
 *
 * 剥法按 pkt-line 的长度字段走，**不硬编码那份实测的 34 字节**（service 名长度不同、
 * 将来格式微调都不该让它失效）：读 4 字节长度 → 不是 `0000` 且内容以 `# service=` 起头 →
 * 按长度跳过 → 再看下 4 字节是不是 `0000`，是就一并跳。
 *
 * 不是这个形状（dumb 协议、或本来就没前缀）就原样返回，不猜。
 */
function stripServicePreamble(buf) {
  if (buf.length < 4) return buf;
  const len = Number.parseInt(buf.toString("ascii", 0, 4), 16);
  if (!Number.isFinite(len) || len < 4 || len > buf.length) return buf;
  const payload = buf.toString("utf8", 4, len);
  if (!payload.startsWith("# service=")) return buf;
  let off = len;
  if (buf.length >= off + 4 && buf.toString("ascii", off, off + 4) === "0000") off += 4;
  return buf.subarray(off);
}

// ───────────────────────────── HTTP ─────────────────────────────

/**
 * 发一个带 App 令牌的请求，连接建立阶段的失败会自动重试。
 *
 * `fetch` 是 node 内置（零 npm 依赖）；它需要 `--allow-net`，由 remote-helper-shim 在 spawn
 * git 时经 NODE_OPTIONS 追加。网络被拒（ERR_ACCESS_DENIED）时给的是「App 缺少网络放行」
 * 这条可修的原因，不是一句笼统的失败。
 *
 * **为什么要重试**：`UND_ERR_CONNECT_TIMEOUT` / `ENOTFOUND` / `EAI_AGAIN` 都发生在
 * **TCP 连接建立之前**，意味着请求根本没到达 GitHub——重试是安全的（不像 4xx/5xx，
 * 那种确实可能已经产生了远端副作用）。实测本机的连接建立有约 1/3 的抖动率
 * （UND_ERR_CONNECT_TIMEOUT，裸 fetch 新进程也复现，属网络环境），不重试的话
 * 每次读写都有三分之一的概率无故失败。
 *
 * **不给 Buffer body 传 `duplex: "half"`**：undici 对非流式 body 加这个选项会挂死（实测）。
 * 本文件只在 body 是 Buffer 时发请求，所以一律不传。
 *
 * `headers` 是额外请求头（取侧用它带 `Git-Protocol: version=2`）；它与 Authorization /
 * User-Agent 合并，不覆盖这两个。
 */
async function githubFetch(url, token, { method = "GET", accept, contentType, body, headers: extraHeaders, redirect = "follow" } = {}) {
  // 额外头先放，认证与 UA 后放：令牌头不允许被调用方传的头覆盖掉。
  const headers = extraHeaders ? { ...extraHeaders } : {};
  headers.Authorization = authHeader(token);
  headers["User-Agent"] = USER_AGENT;
  if (accept) headers.Accept = accept;
  if (contentType) headers["Content-Type"] = contentType;

  const attempts = 3;
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetch(url, { method, headers, body, redirect });
    } catch (e) {
      const code = String((e && e.cause && e.cause.code) || (e && e.code) || "");
      if (code === "ERR_ACCESS_DENIED" || /ERR_ACCESS_DENIED/.test(msgOf(e))) {
        fail(
          "this process has no network permission (ERR_ACCESS_DENIED): cannot reach " + GITHUB_HOST + ".\n" +
            "this means the App is missing the network grant — the git subprocess's NODE_OPTIONS has no --allow-net.\n" +
            "start the operation from GitHana's tool surface (the App injects that flag).",
        );
      }
      // 只有「连接都没建立」才重试：那意味着请求没到达远端。
      const retriable = CONNECT_RETRIABLE.has(code);
      if (!retriable || i === attempts) {
        const attemptsNote =
          i > 1 ? " (tried " + i + " times, always " + code + ")" : "";
        fail("request to " + url + " failed" + attemptsNote + ": " + msgOf(e) + describeFetchCause(e));
      }
      lastErr = e;
      warn("connecting to " + GITHUB_HOST + " failed (" + code + "); rebuilding the connection and retrying (attempt " + i + "/" + attempts + ")…");
      sleepSync(300 * i);
    }
  }
  /* c8 ignore next：循环要么返回要么 fail，到不了这里 */
  fail("request to " + url + " failed: " + msgOf(lastErr));
}

/**
 * 「连接建立阶段」的失败码：请求肯定没到达远端，重试安全。
 *
 * 不含 `ECONNRESET` / `UND_ERR_SOCKET`——它们可能在请求已发出后发生，重试未必安全。
 */
const CONNECT_RETRIABLE = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_DESTROYED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

/**
 * 把 fetch 失败的底层原因挖出来（失败时最容易丢的就是这一段）。
 *
 * `fetch` 抛出的 TypeError 只有一句笼统的 "fetch failed"，真正的原因在 `e.cause` 里：
 * `UND_ERR_CONNECT_TIMEOUT`（连不上，网络/代理）、`ENOTFOUND`（DNS）、
 * `CERT_*`（证书）、`ECONNRESET`（对方断了）。只报 "fetch failed" 等于把排查线索丢掉。
 *
 * @param {unknown} e fetch 抛出的错误
 * @returns {string} 带底层原因的后缀（无原因时空串）
 */
function describeFetchCause(e) {
  const parts = [];
  const collect = (x, depth) => {
    if (!x || depth > 4) return;
    const code = x.code ? String(x.code) : "";
    const msg = x.message ? String(x.message) : "";
    if (code || msg) {
      const bit = code && msg && !msg.includes(code) ? code + " (" + msg + ")" : code || msg;
      if (bit && !parts.includes(bit)) parts.push(bit);
    }
    collect(x.cause, depth + 1);
    if (Array.isArray(x.errors)) for (const y of x.errors) collect(y, depth + 1);
  };
  collect(e, 0);
  const interesting = parts.filter((p) => p !== "fetch failed");
  if (interesting.length === 0) return "";
  return "\nunderlying cause: " + interesting.join(" ← ");
}

/** HTTP 状态 → 可读原因（401/403/404 各自说清可修之处）。 */
function httpStatusReason(status) {
  if (status === 401) {
    return (
      "GitHub rejected authentication (401): the App token is invalid or has been revoked.\n" +
        "Go to the GitHana settings page, click \"Sign in with GitHub\" again, then retry."
    );
  }
  if (status === 403) {
    return (
      "GitHub denied access (403): the token is present, but its authorization scope does not cover this operation.\n" +
        "pushing commits that touch .github/workflows/ needs `workflows: write`; " +
        "private repositories need the `contents` permission. Go to the GitHana settings page, click \"Sign in with GitHub\" again to get the new scope."
    );
  }
  if (status === 404) {
    return "GitHub returned 404: the repository does not exist, or the token cannot see it (private repositories need the contents permission).";
  }
  return "GitHub returned HTTP " + status + ".";
}

/**
 * 非 2xx 的统一处理：把 GitHub 的错误文本转给 stderr（原文，不吞），退非零号。
 *
 * git 会把本进程的 stderr 原样显示给用户，所以这里就是「远端拒绝要能看见」的落点。
 */
async function failWithRemoteError(what, url, res, buf) {
  warn(httpStatusReason(res.status) + "\n(" + what + " " + url + ")");
  const detail = String(buf || "").trim().slice(0, 800);
  if (detail) warn("GitHub raw response: " + detail);
  process.exit(1);
}

// ───────────────────────────── 输出 ─────────────────────────────

/**
 * 往 stdout 写协议字节。
 *
 * 用**同步写**而不是 `process.stdout.write`：本进程的 stdout 只有协议字节，写完之后往往紧接着
 * 就 `process.exit`，异步流的缓冲会被丢掉——那会让 git 收到半截协议。管道是非阻塞的，
 * 写满时 `writeSync` 可能抛 EAGAIN；那时按小块退避重试，不把 EAGAIN 当失败。
 *
 * 大响应（实测 12MB 的 PACK）由调用方按块喂进来，这里逐块写完，不截断。
 */
function writeOut(buf) {
  if (!buf || buf.length === 0) return;
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e && e.code === "EAGAIN") {
        sleepSync(5); // git 那边读得慢：等它把管道读空，不丢字节
        continue;
      }
      if (e && e.code === "EPIPE") return; // git 已经走了：再写也没有意义
      throw e;
    }
  }
}

/**
 * 把 HTTP 响应体流式写到 stdout。
 *
 * **必须整体写、不能截断**，也不能先攒成字符串（包里有非法 UTF-8 字节）：12MB 的 PACK 走
 * 的就是这条路。所以按块拿、按块写。
 */
async function pipeBodyToStdout(body) {
  if (!body) return;
  for await (const chunk of body) {
    writeOut(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

// ───────────────────────────── stdin ─────────────────────────────

/**
 * fd 0 上的缓冲读取器。
 *
 * **一律走异步读**（`fs.read` 回调版）：同一根管子上不混用同步与异步读——`readSync` 在管道上
 * 遇到「暂无数据」可能抛 EAGAIN，靠重试去等会让这里变成一个忙等循环，而 `fs.read` 的
 * 回调本来就是「数据到了才回调」。命令阶段与中继阶段因此共用同一份缓冲与同一条路径。
 *
 * 读到的字节一律先落进 `buf`，`readLine` 只在缓冲里找 LF——所以「命令」与「命令之后 git
 * 立刻发来的协议字节」不会被两个读者各读走一半：中继阶段的 `readToEof` / `readUntilFlushPkt`
 * 从缓冲里接着拿。
 */
class StdinReader {
  constructor(fd) {
    this.fd = fd;
    this.buf = Buffer.alloc(0);
    this.eof = false;
    /** 正在飞的那一次底层读（Promise<boolean>，true = 读到数据）。 */
    this.pending = null;
  }

  /**
   * 再补一块进缓冲；返回是否读到数据（false = EOF）。
   *
   * **`pending` 记的是「一次 fill」而不是「一次 read」**：同一时刻只允许一次底层读在飞，
 * 超时（peek 判首字节、readToEof 的防御上限）时都可能在底层读还没返回时就放行；若两个调用
 * 各持同一份字节各并一次，缓冲里就会出现重复字节，直接破坏协议流。
   */
  fill() {
    if (this.eof) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve) => {
      const chunk = Buffer.allocUnsafe(1 << 16);
      fs.read(this.fd, chunk, 0, chunk.length, null, (err, n) => {
        this.pending = null;
        // 管道对端关掉时可能报 EPIPE/EOF：按读到末尾处理，不当失败。
        if (err) {
          this.eof = true;
          resolve(false);
          return;
        }
        if (n === 0) {
          this.eof = true;
          resolve(false);
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk.subarray(0, n)]);
        resolve(true);
      });
    });
    return this.pending;
  }

  /** 读一行（不含 LF）；EOF 且无残留 → null。 */
  async readLine() {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      if (this.eof) {
        if (this.buf.length === 0) return null;
        const line = this.buf.toString("utf8");
        this.buf = Buffer.alloc(0);
        return line;
      }
      await this.fill();
    }
  }

  /** 缓冲里已有数据 → true；否则等最多 timeoutMs，看首字节来不来。 */
  async peek(timeoutMs) {
    if (this.buf.length > 0) return true;
    if (this.eof) return false;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // 超时只是「这一轮不再等」，底层的读仍会飞完并把字节并进 buf（不会丢），
    // 所以这里不必取消它，也不能让两个调用各并一次（见 fill 的说明）。
    const result = await Promise.race([this.fill(), timeout]);
    if (timer) clearTimeout(timer);
    return result === true;
  }

  /**
   * 读请求体：**直到 EOF**（push 侧的定界方式）。
   *
   * git 把整个请求（命令 pkt-line + flush-pkt + PACK… + 收尾）写完就关管道，实测三种 push
   * 形态（建分支带 pack / 删分支无 pack / 重复删除）的 EOF 都**可靠到达**，块间最大间隔
   * 141ms。所以这里只认 EOF，不看内容、不算长度。
   *
   * `idleLimitMs > 0` 时另设一个**防御上限**：撞到它就报错退出，**绝不**把那截字节当完整请求
   * 发出去——截断半个 pack 会被远端报 unpack 失败（那正是静默窗口定界的老毛病）。
   *
   * @param {number} idleLimitMs 防御上限（毫秒）；<= 0 表示不限
   */
  async readToEof(idleLimitMs) {
    const parts = [this.buf];
    this.buf = Buffer.alloc(0);
    // 防御上限设 <= 0 就是「不限」：那时不挂定时器（不能给 setTimeout 传 0——那会立刻触发）。
    const guard = idleLimitMs > 0;
    for (;;) {
      let timer = null;
      const which = await Promise.race([
        this.fill().then((ok) => (ok ? "data" : "eof")),
        guard
          ? new Promise((resolve) => {
              timer = setTimeout(() => resolve("idle"), idleLimitMs);
            })
          : new Promise(() => {}),
      ]);
      if (timer) clearTimeout(timer);
      if (which === "eof") {
        this.eof = true;
        break;
      }
      if (which === "idle") {
        fail(
          "the push request body neither produced new bytes nor ended (EOF) within " + Math.round(idleLimitMs / 1000) + " seconds.\n" +
            "this helper delimits the request body by EOF, so it will not send an incompletely received packfile (a truncated pack would be rejected by the remote).\n" +
            "if this push really does need longer, retry; if it keeps happening, report it to the GitHana maintainer.",
        );
      }
      parts.push(this.buf);
      this.buf = Buffer.alloc(0);
    }
    return Buffer.concat(parts);
  }

  /**
   * 读请求体：**直到 flush-pkt（`0000`）**，返回并消费整段请求（含那个 `0000`）。
   *
   * 取侧（stateless-connect）的请求体就是一组 pkt-line，**结构定界**：按 4 字节长度字段
   * 一包一包走，走到 `0000` 就是请求结束。`0001`（delim）/ `0002`（response-end）是无载荷的
   * 特殊包，占 4 字节。
   *
   * 返回 `null` 表示对端关了管道且**没给出 flush-pkt**（git 没有下一轮了）——调用方据此收工。
   * 这不是错误：一次会话正常就是以这种方式结束的。
   *
   * 长度字段非法（不是十六进制）时报错退出：那时继续读只会把垃圾当请求 POST 出去，把一次
   * 可读的失败变成一次远端的怪错。
   */
  async readUntilFlushPkt() {
    let off = 0;
    for (;;) {
      if (this.buf.length - off < 4) {
        if (!(await this.fill())) return null; // EOF 且没有 flush-pkt：会话结束
        continue;
      }
      const hex = this.buf.toString("ascii", off, off + 4);
      const len = Number.parseInt(hex, 16);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        fail("non-pkt-line bytes appeared in the fetch-side request body (read \"" + hex + "\" at offset " + off + "): cannot delimit the request.");
      }
      if (len === 0) {
        // flush-pkt：请求到此结束，把它一起发出去（smart HTTP 的请求体含这个 0000）。
        const body = this.buf.subarray(0, off + 4);
        this.buf = this.buf.subarray(off + 4);
        return Buffer.from(body);
      }
      if (len < 4) {
        off += 4; // 0001 / 0002 / 0003：无载荷的特殊包
        continue;
      }
      if (this.buf.length - off < len) {
        if (!(await this.fill())) return null;
        continue;
      }
      off += len;
    }
  }
}

// ───────────────────────────── 取侧：stateless-connect ─────────────────────────────

/**
 * 取侧中继：GET 广告 → 逐轮「读一个请求 → POST → 写回 + response-end-pkt」。
 *
 * 这就是取侧的全部工作：**搬字节 + 加 Authorization**，不解析协议内容。git 在那根管道后面
 * 跑的是它自己的 fetch-pack / ls-refs 实现。
 *
 * ## 为什么能处理多轮
 *
 * `stateless-connect` 就是 git 为无状态传输设计的形态（git 自带的 `git-remote-http` 走的就是
 * 它）：git 知道每一轮都要**自足**，所以它每轮发的是一个完整的请求（v2 的 ls-refs / fetch
 * 各自带全自己的参数），而不是 `connect` 那种「服务端记得上一轮」的增量——第二轮只发一个
 * `done` 的形态不再出现。实测：分叉场景下 `ls-refs` 2 轮 + `fetch` 命令 8 次跳 5 个 POST、
 * `have` 124 次，exit=0，FETCH_HEAD 正确。
 *
 * 广告在会话开头发一次，之后每轮一个请求对一个 POST。
 *
 * @param {{base: string}} remote
 * @param {string} token
 */
async function relayFetch(remote, token) {
  // v2 广告：不带 Git-Protocol 头拿到的是 v1 广告，git 会报
  // `expected response end packet after ref listing`。GET 与 POST 都要带。
  const advertUrl = remote.base + "/info/refs?service=" + SERVICE_UPLOAD;
  const advertRes = await githubFetch(advertUrl, token, {
    accept: "application/x-" + SERVICE_UPLOAD + "-advertisement",
    headers: GIT_PROTOCOL_V2,
  });
  const advertBuf = Buffer.from(await advertRes.arrayBuffer());
  if (!advertRes.ok) {
    await failWithRemoteError("GET", advertUrl, advertRes, advertBuf);
  }
  // 剥掉 HTTP 专有的 `# service=…` 前缀后原样转给 git（不剥 git 会报 protocol error）。
  // 广告后不需要额外的 end packet。
  writeOut(stripServicePreamble(advertBuf));

  const postUrl = remote.base + "/" + SERVICE_UPLOAD;
  // 首轮等首字节（读完之后 git 立刻发请求）；后续轮由 stateless-connect 的语义保证：
  // git 有下一轮就马上写，没有就关管道（readUntilFlushPkt 返回 null）。
  let firstRound = true;
  for (;;) {
    if (firstRound) {
      if (!(await stdin.peek(REQUEST_FIRST_BYTE_TIMEOUT_MS))) {
        fail(
          "after stateless-connect " + SERVICE_UPLOAD + " git sent no request bytes at all (timed out after " +
            REQUEST_FIRST_BYTE_TIMEOUT_MS + "ms).\n" +
            "this helper relaying is stateless; if git writes nothing on this pipe, the remote service cannot start.",
        );
      }
      firstRound = false;
    }
    // 结构定界：读到 flush-pkt（0000）为止。null = 对端关管道且没有 flush-pkt → 会话结束。
    const body = await stdin.readUntilFlushPkt();
    if (body === null || body.length === 0) return;

    // redirect 用 manual：POST 遇 301/302 时 fetch 会把请求**降级成 GET**（并丢掉 body），
    // 那会把一次请求悄悄变成一次空读。仓库改名/搬家这类重定向如实按状态码报出来更好。
    const res = await githubFetch(postUrl, token, {
      method: "POST",
      accept: "application/x-" + SERVICE_UPLOAD + "-result",
      contentType: "application/x-" + SERVICE_UPLOAD + "-request",
      headers: GIT_PROTOCOL_V2,
      body,
      redirect: "manual",
    });
    if (!res.ok) {
      const errBuf = Buffer.from(await res.arrayBuffer());
      await failWithRemoteError("POST", postUrl, res, errBuf);
    }
    await pipeBodyToStdout(res.body);
    // 每轮响应之后必须有 response-end-pkt（0002）：git 靠它判「这一轮完了」。
    // 写成 0001（delim）git 报 `expected response end packet`。
    writeOut(RESPONSE_END_PKT);
  }
}

// ───────────────────────────── push 侧：connect ─────────────────────────────

/**
 * push 侧中继：GET 广告 → 读请求体到 **EOF** → POST → 响应写回 → 退出。
 *
 * receive-pack 协议**没有协商阶段**（客户端一次发完命令 + packfile，服务端回一次
 * report-status 就结束），所以只跑一轮。这条路上 git 的 send-pack 是原生的：
 * 它按 native 协议写 update-request + packfile 到 stdin，本项目只把字节搬过 HTTP。
 *
 * 广告**不带** `Git-Protocol: version=2`：receive-pack 没有 v2。
 *
 * @param {{base: string}} remote
 * @param {string} token
 */
async function relayPush(remote, token) {
  const advertUrl = remote.base + "/info/refs?service=" + SERVICE_RECEIVE;
  const advertRes = await githubFetch(advertUrl, token, {
    accept: "application/x-" + SERVICE_RECEIVE + "-advertisement",
  });
  const advertBuf = Buffer.from(await advertRes.arrayBuffer());
  if (!advertRes.ok) {
    await failWithRemoteError("GET", advertUrl, advertRes, advertBuf);
  }
  writeOut(stripServicePreamble(advertBuf));

  if (!(await stdin.peek(REQUEST_FIRST_BYTE_TIMEOUT_MS))) {
    fail(
      "after connect " + SERVICE_RECEIVE + " git sent no request bytes at all (timed out after " +
        REQUEST_FIRST_BYTE_TIMEOUT_MS + "ms).\n" +
        "this helper relaying is full-duplex; if git writes nothing on this pipe, the remote service cannot start.",
    );
  }
  // 只认 EOF：git 写完命令 + packfile 就关管道。不能按静默窗口定界——那会在 pack-objects
  // 停顿超窗时截断 pack（远端报 unpack 失败）。防御上限设得极长，撞到即报错、不发半截请求。
  const body = await stdin.readToEof(PUSH_BODY_IDLE_LIMIT_MS);
  if (body.length === 0) return; // 空请求 = 收工

  const postUrl = remote.base + "/" + SERVICE_RECEIVE;
  const res = await githubFetch(postUrl, token, {
    method: "POST",
    accept: "application/x-" + SERVICE_RECEIVE + "-result",
    contentType: "application/x-" + SERVICE_RECEIVE + "-request",
    body,
    redirect: "manual",
  });
  if (!res.ok) {
    const errBuf = Buffer.from(await res.arrayBuffer());
    await failWithRemoteError("POST", postUrl, res, errBuf);
  }
  await pipeBodyToStdout(res.body);
}

// ───────────────────────────── 命令循环 ─────────────────────────────

/**
 * 解析 argv：包装脚本传 `<mode> <repository> [<URL>]`。
 *
 * mode 是**必需**的：没有它就无法决定报哪个能力，而报错能力会让 git 走错传输形态。
 * 缺 mode 时报可读的错，而不是猜一个默认值。
 */
function parseArgs(argv) {
  const mode = String(argv[0] || "");
  if (mode !== MODE_FETCH && mode !== MODE_PUSH) {
    fail(
      "no run mode received (argv[0] should be \"" + MODE_FETCH + "\" or \"" + MODE_PUSH + "\", but got: " +
        (argv.length ? JSON.stringify(argv[0]) : "(empty)") + ").\n" +
        "this helper is launched by the git-remote-githana / git-remote-githana-push wrapper scripts, which pass the mode.\n" +
        "start the operation from GitHana's tool surface (the wrappers are generated by tools/lib/remote-helper-shim.js).",
    );
  }
  // git 传 <repository> [<URL>]：有第二个就用第二个，否则第一个本身就是地址。
  const rest = argv.slice(1);
  const remoteUrl = rest.length >= 2 ? rest[1] : rest[0];
  return { mode, remoteUrl };
}

/** 逐条处理 git 的命令流。 */
async function main() {
  const { mode, remoteUrl } = parseArgs(process.argv.slice(2));
  const remote = parseRemote(remoteUrl);
  // 凭据只在真正要连远端时解（capabilities 不需要），解不开的引导即时报出。
  let token = null;
  const tokenOnce = () => {
    if (token === null) token = loadToken();
    return token;
  };
  const pushMode = mode === MODE_PUSH;

  for (;;) {
    const line = await stdin.readLine();
    if (line === null) return; // EOF：git 收工
    const cmd = line.trim();
    if (cmd === "") continue;

    if (cmd === "capabilities") {
      // 取侧只报 stateless-connect（无状态，对齐 GitHub 的 smart HTTP，多轮协商成立）；
      // push 侧只报 connect（有状态全双工，packfile 才从 stdin 进来）。
      // **一个进程只报一个**：实测同时报两个时 git 一律选 connect。
      writeOut(Buffer.from((pushMode ? CAP_CONNECT : CAP_STATELESS_CONNECT) + "\n\n", "utf8"));
      continue;
    }

    if (pushMode) {
      if (cmd.startsWith("connect ")) {
        const service = cmd.slice("connect ".length).trim();
        if (service !== SERVICE_RECEIVE) {
          fail("the push side only serves " + SERVICE_RECEIVE + " (received: " + service + ").");
        }
        // 空行 = 连接已建立；此后这根 stdin/stdout 就是 git 与远端服务之间的原生协议管道。
        writeOut(Buffer.from("\n", "utf8"));
        await relayPush(remote, tokenOnce());
        // 会话结束就**显式退出**：peek 可能留了一次底层 fs.read 在飞，而 git 那边未必会关掉
        // 管道——不退出的话事件循环会一直等那个读，helper 就挂在那里不结束。
        process.exit(0);
      }
    } else if (cmd.startsWith("stateless-connect ")) {
      const service = cmd.slice("stateless-connect ".length).trim();
      if (service !== SERVICE_UPLOAD) {
        fail("the fetch side only serves " + SERVICE_UPLOAD + " (received: " + service + ").");
      }
      // 空行 = 连接已建立。
      writeOut(Buffer.from("\n", "utf8"));
      await relayFetch(remote, tokenOnce());
      process.exit(0);
    }

    // 没收到的命令 git 正常不会发；发了就记一条，不断流。
    warn("received an unadvertised command: " + cmd + " (ignored, connection continues).");
  }
}

const stdin = new StdinReader(0);
main().catch((e) => fail("uncaught failure: " + msgOf(e)));
