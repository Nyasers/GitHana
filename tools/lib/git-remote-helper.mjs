// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/git-remote-helper.mjs — 自写的 git remote helper（transport = githana）。
 *
 * ## 它是什么
 *
 * git 把 URL 形如 `<transport>::<address>` 的远端交给 `git-remote-<transport>` 这个
 * **外部程序**处理（见 gitremote-helpers(7)）。本文件就是 scheme 为 `githana` 的那一个，
 * 随包进 `bin/git-remote-helper.mjs`，运行期由 tools/lib/remote-helper-shim.js 生成的
 * `git-remote-githana` 包装脚本拉起。
 *
 * 于是 github.com 的 https 远端整条传输层落在本进程里：**令牌只在这里**，git 全程不接触它
 * （不进 git 子进程 env、不进命令行、不进远端 URL、不进 gitconfig、不进任何文件）。
 *
 * ## 为什么是 `connect` 而不是 `push` / `fetch`（实测）
 *
 * gitremote-helpers(7) 给 `push` / `fetch` 这两个能力规定的交互里，**packfile 根本不从 helper
 * 的 stdin 进来**——那两条路是「helper 自己生成 / 消费对象」，helper 只报 ref 表与逐条成败。
 * 实测证实：桩 helper 报 `push` 时，git 依次发 `list for-push`、`push <src>:<dst>`，
 * 然后 stdin 上**再无一个字节**（12 秒静默、bytes=0），git 从不送 packfile。
 *
 * `connect` 才是「全双工、原生协议字节」那条：git 说 `connect git-receive-pack`（或
 * `git-upload-pack`），helper 回一个空行表示连接已建立，**此后这根 stdin/stdout 就是 git 与
 * 远端服务之间的原生协议管道**——git 自己按 native 协议写 update-request + packfile、
 * 读 report-status，本项目只负责把字节搬过 HTTP。实测：报 `connect` 后 git 立刻发
 * 106B + 1299B(PACK…) + 20B 的原生字节。
 *
 * 所以本 helper 是**一条双向中继**，不做任何协议解析：
 *
 *   capabilities        → 回 `connect`
 *   connect <service>   → 回空行，然后中继这一个 service（read/write 都走它）
 *
 * 好处是读写用同一条路：push 与 fetch / clone / pull / ls-remote 全部由 git 自己的原生实现
 * 驱动，本进程只搬字节——没有「helper 自己生成 pack」「自己解 report-status」这些活。
 *
 * ## 中继怎么走（smart HTTP 两步）
 *
 *   GET  <base>/info/refs?service=<service>   拿 ref 广告 → 写 stdout
 *   读 git 的请求体（update-request + packfile，或 want/have/done）→ POST
 *   POST <base>/<service>                     响应体 → 写 stdout
 *
 * **广告要剥掉 HTTP 专有的前缀**：smart HTTP 的广告以 pkt-line 包着一行
 * `# service=<service>\n` 加一个 `0000` 开头（实测 34 字节）。那是 HTTP 传输层的东西，
 * 原生协议里没有它——不剥，git 直接报
 * `fatal: protocol error: unexpected '# service=git-upload-pack'`。剥法是读长度、看内容是不是
 * `# service=` 起头，是就跳过并按需跨过紧随的 `0000`（**不硬编码 34**，见 stripServicePreamble）。
 *
 * 广告与响应都**原样写 stdout**（Buffer 直写，不经过 UTF-8 字符串）。响应可能很大
 * （实测 12MB 的 PACK），所以按块流式写、绝不截断。
 *
 * push 一轮（receive-pack 没有协商），fetch 可多轮（upload-pack 的 multi_ack 协商）——
 * 详见 relay。
 *
 * ## 请求体读多久（本方案唯一的启发式）
 *
 * git 把请求写到本进程 stdin 之后**未必**关管道（实测：真 GitHub 的 clone 是「写完静默」结束，
 * 本地 receive-pack 中继则是 EOF 结束），所以两个终止条件都要：
 *   · EOF → 立即返回；
 *   · 连续静默超过窗口 → 认为写完。
 * 详见 StdinReader.readBody 与 STALL_UPLOAD_MS / STALL_RECEIVE_MS。
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

/** 本 helper 接受的两个 service（git 在 connect 里给的 service 名）。 */
const SERVICE_RECEIVE = "git-receive-pack";
const SERVICE_UPLOAD = "git-upload-pack";

/**
 * `connect` 之后等 git 送请求体**首字节**的窗口（毫秒）。
 *
 * git 收到空行后基本立刻开始写（它只是在生成请求），这个窗口只用来把「git 其实没打算在
 * 这根管道上写东西」变成一句可读诊断，而不是让整个操作挂死。
 */
const REQUEST_FIRST_BYTE_TIMEOUT_MS = 15000;

/**
 * 请求体「写完」的静默窗口（毫秒），**按 service 分档**。
 *
 * **这是本方案唯一依赖启发式的地方。** git 把请求写完之后未必关管道（实测：真 GitHub 的
 * clone 就是「写完静默」结束），靠 EOF 判断会挂死；而「停止吐字节」在两种形态下都是同一个
 * 信号，所以连续静默这么久就认为写完了。
 *
 * 分档的理由是两边请求体的性质完全不同：
 *
 *   · `git-upload-pack`（fetch / clone）：请求体是 want / have / done 清单，实测一次 clone
 *     只有 199B，**瞬间写完**；但断流窗口同时是「还有没有下一轮」的判断依据，所以给小值，
 *     否则每次 clone 白等。
 *   · `git-receive-pack`（push）：请求体里含**整个 packfile**，由 pack-objects 边生成边吐，
 *     大仓库/慢磁盘上对象之间出现秒级停顿是正常的。窗口给小了会把请求体**截断成半个 pack**，
 *     远端报 unpack 失败。而 push 只有一轮（见 relay 的说明），所以给小值的收益也不存在，
 *     干脆给足。
 */
const STALL_UPLOAD_MS = 2000;
const STALL_RECEIVE_MS = 15000;

/**
 * 写完一轮响应后，等「git 是否还有下一轮请求」的窗口（毫秒），只用于 upload-pack。
 *
 * 多轮只出现在 fetch 的协商里（multi_ack / multi_ack_detailed：没找到共同基点时再送一轮
 * have）。git 处理完我们的响应、决定继续谈之后是**立刻**写下一轮的，所以这个窗口只需覆盖
 * git 解析响应 + 组下一批 have 的时间，给 2 秒足够宽松。
 *
 * push 不走这里：receive-pack 的协议没有协商阶段（客户端一次发完命令 + pack，服务端回一次
 * report-status 就结束），多轮等待只会让每次推送白白慢这么久。所以那个分支不循环。
 */
const NEXT_ROUND_MS = 2000;

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
      "没有收到 " + DATA_DIR_ENV + "：无法定位 App 数据目录，读不到凭据。\n" +
        "请从 GitHana 的工具面发起操作（本 helper 由 git 拉起，dataDir 由 App 注入）。",
    );
  }
  const file = path.join(dataDir, SECRET_FILE);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(
      "读凭据文件失败（" + file + "）：" + msgOf(e) + "\n" +
        "请到 GitHana 设置页点「用 GitHub 登录」完成授权后重试。",
    );
  }
  if (!rec || typeof rec !== "object" || rec.kind !== "oauth" || typeof rec.cipher !== "string" || !rec.cipher) {
    fail(
      "凭据文件里没有可用的 OAuth 密文（" + file + "）。\n" +
        "请到 GitHana 设置页点「用 GitHub 登录」完成授权后重试。",
    );
  }
  if (rec.alg && rec.alg !== DPAPI_ALG) {
    fail(
      "密文由 " + rec.alg + " 保护，本机后端是 " + DPAPI_ALG + "：无法解开（换机器或换用户了？）。\n" +
        "请在本机重新点「用 GitHub 登录」。",
    );
  }
  let payload = null;
  try {
    payload = JSON.parse(dpapiUnprotect(rec.cipher));
  } catch (e) {
    fail(
      "解密凭据失败：" + msgOf(e) + "（换机器或换用户了？）。\n" +
        "请到 GitHana 设置页重新点「用 GitHub 登录」。",
    );
  }
  const token = String((payload && payload.accessToken) || "");
  if (!token) {
    fail(
      "凭据里没有 accessToken（授权记录不完整）。\n" +
        "请到 GitHana 设置页点「用 GitHub 登录」重新授权。",
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
 *   · `Nyasers/GitHana.git`        —— 配置好的远端经 insteadOf 重写后的 `<address>`
 *   · `githana::Nyasers/GitHana`   —— 命令行直写时 git 也可能原样传
 *   · `https://github.com/o/r.git` —— 万一没经重写（或用户直写完整地址）
 *
 * 非 github.com 的地址一律拒绝：本 helper 的凭据只对 github.com 有意义，硬发出去是把令牌
 * 送给别人的服务器。
 */
function parseRemote(remoteUrl) {
  let s = String(remoteUrl || "").trim();
  if (!s) fail("git 没有给出远端地址（argv 为空）。");
  const schemeForm = /^[A-Za-z][A-Za-z0-9+.-]*::(.*)$/.exec(s);
  if (schemeForm) s = schemeForm[1];
  const httpForm = /^https?:\/\/[^/]+\/(.*)$/i.exec(s);
  if (httpForm) {
    const host = /^https?:\/\/([^/]+)\//i.exec(s);
    if (!host || host[1].toLowerCase() !== GITHUB_HOST) {
      fail("本 helper 只服务 " + GITHUB_HOST + " 的 https 远端（收到：" + remoteUrl + "）。");
    }
    s = httpForm[1];
  }
  s = s.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) {
    fail("无法从远端地址解析出 owner/repo：" + remoteUrl);
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
 */
async function githubFetch(url, token, { method = "GET", accept, contentType, body, redirect = "follow" } = {}) {
  const headers = {
    Authorization: authHeader(token),
    "User-Agent": USER_AGENT,
  };
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
          "本进程没有网络权限（ERR_ACCESS_DENIED）：连不上 " + GITHUB_HOST + "。\n" +
            "这是 App 缺少网络放行——git 子进程的 NODE_OPTIONS 里没有 --allow-net。\n" +
            "请从 GitHana 的工具面发起操作（由 App 注入该旗标）。",
        );
      }
      // 只有「连接都没建立」才重试：那意味着请求没到达远端。
      const retriable = CONNECT_RETRIABLE.has(code);
      if (!retriable || i === attempts) {
        const attemptsNote =
          i > 1 ? "（已试 " + i + " 次，每次都是 " + code + "）" : "";
        fail("请求 " + url + " 失败" + attemptsNote + "：" + msgOf(e) + describeFetchCause(e));
      }
      lastErr = e;
      warn("连接 " + GITHUB_HOST + " 失败（" + code + "），重建连接后重试（第 " + i + "/" + attempts + " 次）…");
      sleepSync(300 * i);
    }
  }
  /* c8 ignore next：循环要么返回要么 fail，到不了这里 */
  fail("请求 " + url + " 失败：" + msgOf(lastErr));
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
      const bit = code && msg && !msg.includes(code) ? code + "（" + msg + "）" : code || msg;
      if (bit && !parts.includes(bit)) parts.push(bit);
    }
    collect(x.cause, depth + 1);
    if (Array.isArray(x.errors)) for (const y of x.errors) collect(y, depth + 1);
  };
  collect(e, 0);
  const interesting = parts.filter((p) => p !== "fetch failed");
  if (interesting.length === 0) return "";
  return "\n底层原因：" + interesting.join(" ← ");
}

/** HTTP 状态 → 可读原因（401/403/404 各自说清可修之处）。 */
function httpStatusReason(status) {
  if (status === 401) {
    return (
      "GitHub 拒绝认证（401）：App 令牌已失效或被撤销。\n" +
        "请到 GitHana 设置页重新点「用 GitHub 登录」后重试。"
    );
  }
  if (status === 403) {
    return (
      "GitHub 拒绝访问（403）：令牌在位，但授权范围不覆盖这次操作。\n" +
        "推带 .github/workflows/ 改动的提交需要 `workflows: write`；" +
        "私有仓库需要 `contents` 权限。请到 GitHana 设置页重新点「用 GitHub 登录」拿到新范围。"
    );
  }
  if (status === 404) {
    return "GitHub 报 404：仓库不存在、或令牌看不到它（私有仓库需要 contents 权限）。";
  }
  return "GitHub 返回 HTTP " + status + "。";
}

/**
 * 非 2xx 的统一处理：把 GitHub 的错误文本转给 stderr（原文，不吞），退非零号。
 *
 * git 会把本进程的 stderr 原样显示给用户，所以这里就是「远端拒绝要能看见」的落点。
 */
async function failWithRemoteError(what, url, res, buf) {
  warn(httpStatusReason(res.status) + "\n（" + what + " " + url + "）");
  const detail = String(buf || "").trim().slice(0, 800);
  if (detail) warn("GitHub 响应原文：" + detail);
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
 * 立刻发来的协议字节」不会被两个读者各读走一半：中继阶段的 `readBody` 从缓冲里接着拿。
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
   * 且**只有那一次**会把读到的字节并进 buf。这一点是必需的——`peek` 的超时与 `readBody` 的
   * 静默窗口都可能在底层读还没返回时就放行，随后又发起下一次 fill；若两个调用各持同一份
   * 字节各并一次，缓冲里就会出现重复字节，直接破坏协议流。
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
   * 读请求体：直到 **EOF**，或**连续 stallMs 没有新字节**。
   *
   * 两个终止条件都要，因为它们对应 git 两种收尾方式（实测都出现过）：
   *   · 本地 receive-pack 中继：git 写完就关管道 → EOF 立即返回；
   *   · 真 GitHub 的 clone：git 写完 `want … done` 后**不关** stdin，转去读响应 →
   *     纯等 EOF 会挂死，靠静默窗口收尾。
   *
   * 不按协议结构去算长度（want/have 流、packfile 的对象数与 zlib 流）——那正是本方案要避开的
   * 「解析重构」。这里只认流的行为，不认流的内容。
   *
   * @param {number} stallMs 连续无字节多久算写完
   */
  async readBody(stallMs) {
    const parts = [this.buf];
    this.buf = Buffer.alloc(0);
    for (;;) {
      let timer = null;
      const stalled = new Promise((resolve) => {
        timer = setTimeout(() => resolve("stall"), stallMs);
      });
      const which = await Promise.race([this.fill().then((ok) => (ok ? "data" : "eof")), stalled]);
      if (timer) clearTimeout(timer);
      if (which === "eof") {
        this.eof = true;
        break;
      }
      if (which === "stall") break;
      parts.push(this.buf);
      this.buf = Buffer.alloc(0);
    }
    return Buffer.concat(parts);
  }
}

// ───────────────────────────── 中继 ─────────────────────────────

/**
 * 中继一个 service：GET 广告 → 读 git 请求体 → POST → 响应写回。
 *
 * 这就是 helper 的全部工作：**搬字节 + 加 Authorization**，不解析、不重构任何协议内容。
 * git 在那根管道后面跑的就是它自己的原生实现（send-pack / fetch-pack），
 * 所以 push 与 fetch 走的是同一段代码。
 *
 * ## 一轮还是多轮
 *
 * smart HTTP 是无状态的：一轮 = 一次 POST = 一次 HTTP 请求。而原生协议在**同一根管道**上
 * 可以来回多轮——upload-pack 的协商（multi_ack / multi_ack_detailed）在没有找到共同基点时
 * 会再发一轮 have；协议 v2 也是 ls-refs、fetch 分轮走。git 在 `connect` 形态下不知道自己
 * 后面接的是 HTTP，只当那是根全双工管道，所以会**接着往 stdin 写下一轮请求**。
 *
 * 两个 service 的形状不同，所以分支处理：
 *
 *   · `git-receive-pack`（push）：协议**没有协商**——客户端一次发完命令 + pack，服务端回一次
 *     report-status 就结束。所以只跑一轮，然后退出；不设「等下一轮」的窗口，免得每次推送
 *     白等一次。
 *   · `git-upload-pack`（fetch / clone）：可能多轮，所以循环。实测的 clone 是单轮
 *     （`want … done` 一次到底），循环是单轮的严格超集——只跑一轮时，第二轮会因 git 关管道
 *     （EOF）立即结束，或按 NEXT_ROUND_MS 静默收尾。
 *
 * 收工判据（两种都要，理由同 StdinReader.readBody）：
 *   · git 关掉 stdin（EOF）→ 结束；
 *   · git 静默超过窗口 → 认为没有下一轮了，结束。
 *
 * @param {string} service git-receive-pack（push）或 git-upload-pack（fetch）
 * @param {{base: string}} remote
 * @param {string} token
 */
async function relay(service, remote, token) {
  const forPush = service === SERVICE_RECEIVE;
  // —— 1) ref 广告（整个会话只发一次） ——
  const advertUrl = remote.base + "/info/refs?service=" + service;
  const advertRes = await githubFetch(advertUrl, token, {
    accept: "application/x-" + service + "-advertisement",
  });
  const advertBuf = Buffer.from(await advertRes.arrayBuffer());
  if (!advertRes.ok) {
    await failWithRemoteError("GET", advertUrl, advertRes, advertBuf);
  }
  // 剥掉 HTTP 专有的 `# service=…` 前缀后原样转给 git（不剥 git 会报 protocol error）。
  writeOut(stripServicePreamble(advertBuf));

  // 请求体写完的静默窗口按 service 分档（push 的请求体含整个 packfile，停顿更长）。
  const stallMs = forPush ? STALL_RECEIVE_MS : STALL_UPLOAD_MS;
  const postUrl = remote.base + "/" + service;

  for (let round = 0; ; round += 1) {
    // 首轮等得宽些（git 收到广告后基本立刻开始写）；后续轮只在 git 确实还要谈时才有，
    // 而 push 根本不进后续轮。
    const waitMs = round === 0 ? REQUEST_FIRST_BYTE_TIMEOUT_MS : NEXT_ROUND_MS;
    if (!(await stdin.peek(waitMs))) {
      if (round === 0) {
        fail(
          "connect " + service + " 之后 git 没有送来任何请求字节（等待 " +
            REQUEST_FIRST_BYTE_TIMEOUT_MS + "ms 超时）。\n" +
            "本 helper 走的是全双工中继形态；若 git 没在这根管道上写东西，远端服务无从发起。",
        );
      }
      return; // 没有下一轮：会话结束
    }
    // git **确实**还要再谈一轮：这在 connect + 无状态 HTTP 下跑不通，立即报可读的错
    // （不能放着挂死，也不能发出一个服务端无法自足处理的请求）。
    // 单轮操作不受影响——它们在 round 0 就把响应送达，下一轮 peek 会因 git 关管道而返回 false。
    if (round >= 1 && !forPush) {
      fail(
        "这次取远端需要多轮协商，而当前传输形态提供不了。\n" +
          "helper 走的是 `connect`（把 git 的原生协议整个中继给 GitHub）——它在**单轮**操作下是对的\n" +
          "（普通 clone / fetch / pull / ls-remote / push 均已验证），但 git 在还需再谈时会按「服务端\n" +
          "记得上一轮」的有状态语义只发一个 `done`，而 GitHub 的 smart HTTP 是**无状态**的（每轮 POST\n" +
          "自足），两边对不上。\n" +
          "触发它的典型操作：浅克隆（`--depth`）、`--deepen`。绕过：去掉 `--depth` 做完整克隆，\n" +
          "或改用本机 git 原生凭据跑这些操作。",
      );
    }
    const body = await stdin.readBody(stallMs);
    if (body.length === 0) return; // 空请求 = 收工

    // redirect 用 manual：POST 遇 301/302 时 fetch 会把请求**降级成 GET**（并丢掉 body），
    // 那会把一次推送悄悄变成一次空读。仓库改名/搬家这类重定向如实按状态码报出来更好。
    const res = await githubFetch(postUrl, token, {
      method: "POST",
      accept: "application/x-" + service + "-result",
      contentType: "application/x-" + service + "-request",
      body,
      redirect: "manual",
    });
    if (!res.ok) {
      const errBuf = Buffer.from(await res.arrayBuffer());
      await failWithRemoteError("POST", postUrl, res, errBuf);
    }
    await pipeBodyToStdout(res.body);

    // push 没有协商阶段：这一轮就是全部，响应已送达，收工。
    if (forPush) return;
  }
  // 连接结束，helper 退出（gitremote-helpers(7) 的 'connect' 一节：连接结束后 helper 退出）。
}

// ───────────────────────────── 命令循环 ─────────────────────────────

/** 逐条处理 git 的命令流。 */
async function main() {
  const argv = process.argv.slice(2);
  // git 传 <repository> [<URL>]：有第二个就用第二个，否则第一个本身就是地址。
  const remoteUrl = argv.length >= 2 ? argv[1] : argv[0];
  const remote = parseRemote(remoteUrl);
  // 凭据只在真正要连远端时解（capabilities 不需要，connect 才需要），解不开的引导即时报出。
  let token = null;
  const tokenOnce = () => {
    if (token === null) token = loadToken();
    return token;
  };

  for (;;) {
    const line = await stdin.readLine();
    if (line === null) return; // EOF：git 收工
    const cmd = line.trim();
    if (cmd === "") continue;

    if (cmd === "capabilities") {
      // 只报 connect：它一条通吃读写（push / fetch / clone / pull / ls-remote 都由 git 自己
      // 的原生实现驱动）。报 push/fetch 会走「helper 自己生成 pack」那条路——实测 git 在那条
      // 路上从不把 packfile 送进来。
      writeOut(Buffer.from("connect\n\n", "utf8"));
      continue;
    }

    if (cmd.startsWith("connect ")) {
      const service = cmd.slice("connect ".length).trim();
      if (service !== SERVICE_RECEIVE && service !== SERVICE_UPLOAD) {
        // 未实现的 service：按协议退出并说明（不回 fallback——本 helper 没有 dumb 传输可退）。
        fail("不支持的 service：" + service + "（本 helper 只做 " + SERVICE_RECEIVE + " / " + SERVICE_UPLOAD + "）。");
      }
      // 空行 = 连接已建立；此后这根 stdin/stdout 就是 git 与远端服务之间的原生协议管道。
      writeOut(Buffer.from("\n", "utf8"));
      await relay(service, remote, tokenOnce());
      // 会话结束就**显式退出**：peek 的超时可能留了一次底层 fs.read 在飞，而 git 那边未必
      // 会关掉管道——不退出的话事件循环会一直等那个读，helper 就挂在那里不结束。
      process.exit(0);
    }

    // 没广告 option / list / push / fetch，git 正常不会发这些；发了就记一条，不断流。
    warn("收到未广告的命令：" + cmd + "（已忽略，连接继续）。");
  }
}

const stdin = new StdinReader(0);
main().catch((e) => fail("未捕获的失败：" + msgOf(e)));
