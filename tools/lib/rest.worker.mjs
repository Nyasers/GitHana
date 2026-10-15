// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/rest.worker.mjs — GitHub REST 的 HTTP 执行体（独立子进程）。
 *
 * ## 为什么单独一个进程
 *
 * App 的 apply() 跑在宿主给的 AppHost 子进程里，那个进程开了 Node Permission Model，
 * 且**没有** `--allow-net`（宿主按清单能力只给 `--allow-child-process`）。权限模型下进程内
 * 的 `fetch` 会被运行时拒掉（实测 DNS 报 `getaddrinfo ERR_ACCESS_DENIED api.github.com`）。
 * 而 `app/process.spawn` 授权下起的外部进程不继承该模型——gh CLI 以前就是这么联网的。
 *
 * 换成我们自己写的 node 脚本后，spawn 时要**显式**补 `--allow-net`：Node 26 的
 * `--permission` 会经 `NODE_OPTIONS` 传染给子进程（子进程继承权限模型），而放行项不会跟着走。
 * 这不是新增清单能力，是 node 运行时层面的旗标（见 tools/lib/rest.js 的 spawnRestWorker）。
 *
 * ## 这个进程只认识 HTTP
 *
 * 它不认识 GitHub 的语义：路径、字段、错误码文案都在 App 侧（tools/github-*.js、
 * lib/oauth.js、lib/gpg-publish.js）。这里只做「发请求、读响应、原样回报」，因此可以被
 * 单独审阅——它没有能力去往非白名单主机发东西；文件读写也只在调用方点名的那个路径上做。
 *
 * ## 二进制通道（字节原样进、字节原样出）
 *
 * 请求带 `file`（本地路径）→ 用 `fs.createReadStream` 作 fetch 的 body，并显式带
 * `Content-Length`：文件不进内存，也不走分块编码（发布资产端点要的是原始二进制体）。
 * 请求带 `toFile`（本地路径）→ 把响应体流式写进那个文件，不按 UTF-8 解码、不截断。
 * 两条路都不经过 JSON 载荷，所以任意字节都过得去。
 *
 * 进程仍然不认识 GitHub：它只知道「这个路径的字节发出去」「响应的字节写到那个路径」。
 * 本地路径的读写权限由 spawn 侧放行（tools/lib/rest.js 按请求里的路径补
 * `--allow-fs-read` / `--allow-fs-write`）——本进程在权限模型下运行时，没放行的路径读写不到。
 *
 * ## 主机白名单在进程内自查
 *
 * `--allow-net=<host>` 的收窄语法在当前 node（实测 v26.8.1）**不生效**：指定
 * `--allow-net=api.github.com` 后请求 `example.com` 仍然成功。运行时的门只能全开，
 * 那就在这一层把门收窄到实际需要的主机（再加一个**重定向目标**白名单）。
 *
 * ## 协议
 *
 *   stdin : { token, requests: [ { id?, method?, url, headers?, json?, form?, body?, file?,
 *                                 hashFile?, contentType?, maxFileBytes?, toFile?, overwrite?,
 *                                 auth?, timeoutMs?, paginate?, maxPages? } ] }
 *   stdout: { results: [ { id?, ok, status, json, text, truncated, pages?, link?, bytes?,
 *                          code?, size?, sha256?, error? } ] }
 *
 * `auth` 缺省 true → 带 `Authorization: Bearer <token>`；false → 不带该头。
 * `paginate` true → 跟随 `Link: rel="next"` 合并 JSON 数组（上限 maxPages，缺省 10）。
 * `redirect` 不交给 fetch：每一跳都过 REDIRECT_HOSTS，离开 api.github.com 后不带走凭据。
 * 无正文响应（204/304/HEAD）返回 `json: null, text: ""`，不是错误。
 *
 * `file` 与 `json` / `form` / `body` 互斥（优先级 json > form > body > file）：给了它就是
 * 「把那个文件的字节原样发出去」，`contentType` 缺省 `application/octet-stream`，
 * `maxFileBytes` 给了就在**发请求前**比一次体积（超限直接拒，不白传）。
 * `hashFile` true → 顺带算这条流的 sha256 并在 `sha256` 里回报（App 侧读不到那个文件，
 * 算不了；字节反正要从这里过）。
 * `toFile` 给了就是「把响应的字节原样写到那个路径」：此时不回 text / json，回 `bytes`
 * （写进去的字节数）；`overwrite` 不为 true 且文件已存在时拒写。响应不是 2xx 时**不落盘**，
 * 按普通错误回报（把错误正文留在 text / json 里，调用方看得见 GitHub 的原话）。
 * 读不了本地文件 / 写不了目标路径时回 `code`（`file_unreadable` / `file_too_large` /
 * `target_exists` / `target_unwritable` / `body_read_failed` / `download_truncated`）与 `size`，
 * 供 App 侧拼可读文案。
 * stdout 只有一行 JSON；诊断一律走 stderr（App 侧只解析 stdout）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

/**
 * 允许出站的主机（其余一律在发请求前拒绝）。
 *
 * `uploads.github.com` 是发布资产的上传端点：它**不在** api.github.com 上（GitHub 把上传
 * 单独摆了一个域），所以只列 api / github 会让上传在起请求前就被拒。凭据与 api 同一枚
 * （同一个 Bearer 头），这里只放行域，不改凭据形态。
 */
const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "uploads.github.com"]);

/**
 * 允许**重定向落到**的主机（精确 host）。
 *
 * GitHub 的内容端点会 302 到别处：`/repos/{o}/{r}/tarball/...` 与 `/repos/{o}/{r}/zipball/...`
 * 落到 codeload.github.com（GitHub 自己的下载域）；release 资产（`github.com/{o}/{r}/releases/
 * download/{tag}/{name}` 与 API 的 `Accept: application/octet-stream` 那条）落到
 * `release-assets.githubusercontent.com`（实测：一跳 302 → 200）；Actions 的日志与产物落到
 * `objects.githubusercontent.com`（日志直出时不经它）。
 *
 * 不把这些列进来就会让下载硬失败，而把 redirect 交给 fetch 自己 follow（旧写法）则等于放弃
 * 白名单——两者都不可取。所以：逐跳校验，且离开 api.github.com 后**不带走凭据**（见带 auth 的复件）。
 *
 * Azure 存储那条见 `REDIRECT_HOST_SUFFIXES`：它的子域是存储账号名，列不全。
 */
const REDIRECT_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "uploads.github.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/**
 * 允许**重定向落到**的后缀（写成 `*.` 开头，匹配任意子域，**含**裸域本身）。
 *
 * Actions 产物（`.../artifacts/{id}/zip`）与部分日志会 302 到 Azure 存储：
 * `productionresultssa12.blob.core.windows.net` 这类——**子域是存储账号名**，随账号与区域变化，
 * 用精确 `Set` 列不全（列几个看着像支持、实则漏）。所以只对这一档开后缀匹配。
 *
 * 为什么这是安全的：`blob.core.windows.net` 是 Azure 自有域，子域只能由 Azure 存储账号充当；
 * 而落到这里的跳转**已经不带凭据**（离开 api.github.com 后 Authorization 被摘掉），
 * 最坏情况是把一次公开下载引到另一个 Azure 存储账号上——下载的是它给的内容，不是我们的令牌。
 * 后缀匹配**只对 REDIRECT_HOSTS 生效**：起始请求（我们主动打的面）仍只认精确 host，
 * 否则一个形如 `evil-api.github.com` 的域就能冒充 api.github.com。
 */
const REDIRECT_HOST_SUFFIXES = ["*.blob.core.windows.net"];

/** 单请求最多跟随的重定向跳数（防卷回的 Location 把一次调用转死）。 */
const MAX_REDIRECTS = 5;

/**
 * 主机是否被允许：精确命中 `Set`，或命中 `suffixes` 里某个 `*.` 后缀（含裸域）。
 *
 * 后缀只给重定向那一侧用（见 REDIRECT_HOST_SUFFIXES）；起始请求只认精确 host。
 */
function hostAllowed(host, allowedHosts, suffixes) {
  if (allowedHosts.has(host)) return true;
  for (const pattern of suffixes || []) {
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : pattern; // "*.a.b" → ".a.b"
    if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
  }
  return false;
}

/**
 * 校验一个出站 URL：主机在白名单内，**且协议是 https**。
 *
 * 只比 host 不够：`new URL("http://api.github.com/x").host` 也是 `api.github.com`，于是明文
 * 请求会带着 Bearer token 发出去。调用点有三处（请求起点、每跳、分页 Link），共用这一个函数，
 * 而非各写一遍——三份逻辑迟早会漂，而这里是安全边界。
 *
 * @param {URL} target 已解析的 URL
 * @param {Set<string>} allowedHosts 允许的主机集（精确匹配）
 * @param {string} what 报错文案里的行为名（如“请求”/“重定向”）
 * @param {string[]} [suffixes] 允许的 `*.` 后缀（只给重定向侧）
 * @returns {string|null} 不通过时返可读原因，通过返 null
 */
function outboundReject(target, allowedHosts, what, suffixes) {
  if (target.protocol !== "https:") {
    return `拒绝${what}：${target.protocol}// 不是 https。`;
  }
  if (!hostAllowed(target.host, allowedHosts, suffixes)) {
    return `拒绝${what}：${target.host} 不在允许的主机（${[...allowedHosts, ...(suffixes || [])].join(" / ")}）。`;
  }
  return null;
}

/** 单次响应的读取上限（字节）：GitHub 的正常响应远小于此，超限截断并标记。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 单请求缺省超时。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 连接层失败的重试次数。
 *
 * 只重试**连接未建立**的错误（DNS 失败、连接被拒、连接超时）：那些情况下请求根本没
 * 到达 GitHub，重试无论对幂等的 GET 还是对 POST 都安全。
 *
 * **不包含 `UND_ERR_SOCKET`**：它在 undici 里表示 socket 于请求或响应中途关闭——请求可能已经
 * 到达并对服务端生效，重试 POST/PUT/DELETE 会双写。已拿到响应后的错误（含超时、ECONNRESET）同理。
 */
const CONNECT_RETRIES = 2;

/** 连接层错误码（未到达服务端，重试安全）。 */
const CONNECT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** 从 undici 错误里取出连接层错误码；不是连接层错误返回 null。 */
function connectErrorCode(e) {
  const cause = e && e.cause ? e.cause : null;
  const code = (cause && cause.code) || (e && e.code) || "";
  return CONNECT_ERROR_CODES.has(String(code)) ? String(code) : null;
}

/** 跟随分页的页数上限（防病态链把一次工具调用拖死）。 */
const DEFAULT_MAX_PAGES = 10;

/** 读 stdin 全文。 */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** 有界读取响应体：超限截断并标记，不把整块读进内存。204/304 无正文，直接返回空。 */
async function readBounded(res, limit) {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > limit) {
      chunks.push(value.subarray(0, limit - size));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* 流已结束 */
      }
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** 解析 JSON 文本；不是 JSON 返回 null（调用方据 text 自行处理）。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 Link 头里取 rel="next" 的地址。 */
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** 需要跟随的状态码。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 带逐跳白名单校验的 fetch。
 *
 * 不用 `redirect:"follow"`：那样等于把起始 URL 的白名单校验作废——任何一个 302 都能把请求引到
 * 任意主机（实测：`/repos/o/r/tarball/x` 会 302 到 codeload.github.com）。这里手工跟：**每一跳的
 * URL 都过白名单**（起始用 ALLOWED_HOSTS，重定向目标用 REDIRECT_HOSTS）。
 *
 * 逐跳校验对**分页**同样重要：`Link: rel="next"` 的地址是外部给的，若只校验首请求，
 * 一个异常的 Link 就能把带凭据的请求送到别的域。
 *
 * 另外，离开 `api.github.com` 后**不带走 Authorization**：codeload 不需要凭据，而把凭据送到
 * 白名单里的非 API 域没有必要。
 *
 * `makeBody` 是**造体函数**而不是体本身：流只用一次就没了，而 307/308 会把体带着再发一跳、
 * 连接层失败也会重试一次。所以每一跳各自现造，而不是复用上一条已经读干的流。
 *
 * 跳数超限或目标不在白名单时**抛出**（不是当作 3xx 回报）：这是拒绝，不是服务端的正常响应。
 */
async function fetchChecked(startUrl, { method, headers, makeBody, streamBody, timeoutMs }) {
  let url = startUrl;
  let headersNow = headers;
  let methodNow = method;
  let makeBodyNow = makeBody;
  let streamBodyNow = streamBody === true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // 每一跳的 URL 都要过白名单：分页时它取自上一页的 Link 头，与 redirect 一样是**外部给的**，
    // 不能假定它仍是 api.github.com（否则一个恶意/异常的 Link 就能把令牌送到别处）。
    // 起始 URL 用 ALLOWED_HOSTS（我们主动请求的面）；重定向目标用 REDIRECT_HOSTS（多含 codeload）。
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new Error("URL 非法：" + String(url));
    }
    const allowed = hop === 0 ? ALLOWED_HOSTS : REDIRECT_HOSTS;
    // 后缀白名单只给重定向侧：起始请求是我们主动打的面，只认精确 host。
    const reject = outboundReject(target, allowed, "请求", hop === 0 ? [] : REDIRECT_HOST_SUFFIXES);
    if (reject) throw new Error(reject);
    // 每一跳现造请求体：307/308 会带着体再发一次，而**流用过一次就没了**——
    // 复用上一跳那条流会发出空体（甚至已经 aborted 的流）。造体函数对文件那支每次新开读流。
    const init = {
      method: methodNow,
      headers: headersNow,
      body: makeBodyNow ? makeBodyNow() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    };
    // 流式体要显式声明 `duplex: "half"`：undici 对「body 是流」的请求要求这个，缺了会当场抛。
    // 只对文件那一支加——给字符串体带上它虽然无害（多余键会被忽略），但那是让读的人多想一层。
    if (streamBodyNow) init.duplex = "half";
    const res = await fetch(url, init);
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const loc = res.headers.get("location");
    if (!loc) return res;
    let next;
    try {
      next = new URL(loc, url);
    } catch {
      return res; // Location 不是合法 URL：当最终响应回报
    }
    // 跳转目标同样既要过主机白名单（含 Azure 存储那条后缀），也要是 https。
    const rejectNext = outboundReject(next, REDIRECT_HOSTS, "跳转", REDIRECT_HOST_SUFFIXES);
    if (rejectNext) throw new Error(rejectNext);
    // 离开 api.github.com 后不带走凭据：codeload 是公开下载域，把令牌送过去没有必要。
    if (next.host !== "api.github.com" && headersNow.Authorization) {
      const { Authorization, ...rest } = headersNow;
      headersNow = rest;
    }
    // 303 与历史上常见的 301/302 会把非 GET 降为 GET；307/308 保留方法与体。
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && methodNow !== "GET")) {
      methodNow = "GET";
      makeBodyNow = null;
      streamBodyNow = false;
    }
    url = next.toString();
  }
  throw new Error("重定向次数超过上限（" + MAX_REDIRECTS + " 次）。");
}

/** 组请求头：Authorization 按 auth 开关，Accept/UA 固定，JSON 体带 content-type。 */
function buildHeaders(req, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GitHana",
    ...(req.headers && typeof req.headers === "object" ? req.headers : {}),
  };
  if (req.auth !== false && token) headers.Authorization = "Bearer " + token;
  return headers;
}

/**
 * 组请求体：json → JSON 文本；form → urlencoded；body → 原样字符串；file → 本地文件的流。
 * 四者互斥，优先级 json > form > body > file。
 *
 * `file` 这一支返回的是**造体函数**而不是体本身：连接层失败会重试、307/308 会带着体再跳一跳，
 * 而 ReadableStream 用过一次就没了——每次都要新开一条 `fs.createReadStream`。
 *
 * @returns {{ make: (() => any) | null, contentType: string|null, isFile: boolean, sha256: () => string|null }}
 *   `sha256` 只在 `hashFile` 为 true 时有值（文件体边上顺带算的那份摘要）。
 */
function buildBody(req) {
  if (req.json !== undefined && req.json !== null) {
    const text = JSON.stringify(req.json);
    return { make: () => text, contentType: "application/json", isFile: false, sha256: () => null };
  }
  if (req.form !== undefined && req.form !== null) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) params.append(k, String(v));
    const text = params.toString();
    return { make: () => text, contentType: "application/x-www-form-urlencoded", isFile: false, sha256: () => null };
  }
  if (typeof req.body === "string" && req.body !== "") {
    return { make: () => req.body, contentType: null, isFile: false, sha256: () => null };
  }
  if (typeof req.file === "string" && req.file !== "") {
    // 二进制体：流式读，不整块进内存（资产可能几百 MB）。Content-Type 由调用方定，
    // 缺省 application/octet-stream——发布资产端点收的就是这个。
    const p = req.file;
    // 顺带算摘要的落点：最后一次造体的那条流读完时写入（见 withHash）。
    const state = { hex: null };
    const make = () => (req.hashFile === true ? withHash(fs.createReadStream(p), state) : fs.createReadStream(p));
    return { make, contentType: "application/octet-stream", isFile: true, sha256: () => state.hex };
  }
  return { make: null, contentType: null, isFile: false, sha256: () => null };
}

/**
 * 给读流串一个 sha256 计数器，返回**新的一条**流给 fetch 用。
 *
 * 为什么让 worker 算：**App 进程常常读不到这个文件**（它在许可根外，只有 worker 被放行过），
 * 所以「本地摘要」不能指望 App 侧算。而字节正好从 worker 手上过一遍——顺手摘要一次，
 * 上行流量之外的开销只是哈希，代价可以忽略。
 *
 * 为什么用 Transform 而不是给读流挂个 `data` 监听：挂 `data` 会把流切进 **flowing 模式**，
 * 数据按最快的速度涌出来——fetch 还没来得及消费，开头那几个 chunk 就丢了（那会静默发出一个
 * 内容不对的请求体）。Transform 只在**被读的时候**处理数据，背压照旧传回源流，一个字节都不丢。
 *
 * 结果写进 `state.hex`（读到底才写）：调用方在响应读完之后取，那时它一定有值。
 */
function withHash(stream, state) {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  tap.on("end", () => {
    // 到 end 就是**读完了**（流没被读到底不会有这个事件），所以这里记下的就是全文件的摘要。
    // 不按字节数判：空文件也有一个合法的 sha256，跳过它只会让上传空文件时少一项核对。
    state.hex = hash.digest("hex");
  });
  stream.pipe(tap);
  return tap;
}

/** 失败结果的统一形状：带上可判别的 code 与 errno，供 App 侧拼可读文案。 */
function fail(id, error, extra) {
  return { id, ok: false, status: null, error, ...(extra || {}) };
}

/**
 * 二进制请求体的发前检查：文件必须存在、是普通文件、体积不超调用方给的上限。
 *
 * **在发请求前**查，是为了「不白传一遍」——体积超 GitHub 硬限的文件若先传一遍再被拒，
 * 几百 MB 的上行流量与几分钟就白花了。
 *
 * @returns {{ error: object } | { size: number }}
 */
function checkFileBody(req) {
  const p = String(req.file);
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    return { error: { code: "file_unreadable", cause: String((e && e.code) || ""), error: "本地文件读不到：" + p } };
  }
  if (!st.isFile()) {
    return { error: { code: "file_unreadable", cause: "EISDIR", error: "这个路径不是文件：" + p } };
  }
  const max = Number(req.maxFileBytes);
  if (Number.isFinite(max) && max > 0 && st.size >= max) {
    return { error: { code: "file_too_large", size: st.size, error: "本地文件超过上限：" + p } };
  }
  return { size: st.size };
}

/**
 * 写盘失败的 errno → 可判别的 code。
 *
 * `EEXIST` 要单独认出来：它表示目标已存在（`wx` 挡下的），是「换个名字或传 overwrite」，
 * 而不是「这个目录写不了」——两种错法给调用方的做法完全不同。
 */
function writeErrorCode(e) {
  const code = String((e && e.code) || "");
  if (code === "EEXIST") return "target_exists";
  return "target_unwritable";
}

/**
 * 尽最大努力删掉一个落盘失败留下的文件。
 *
 * 为什么非要删：调用方看到的是一个**目标路径**，而半份文件与完整文件在盘上长得一样——
 * 「看着下好了、其实不完整」比一次明确的报错坏得多（那会被当成成功，直到有人去用它）。
 *
 * 删不掉（Windows 上句柄还开着、或权限被改）就留着并让错误照报——这里不因为清理失败而
 * 改写结论，调用方的报错里已经写明「这份不完整」。
 */
function discard(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    /* 句柄还开着或无权删：留着，错误照报 */
  }
}

/**
 * 响应体流式写盘（二进制通道的下载侧）。
 *
 * 用 `Readable.fromWeb(res.body)` 接到 `fs.createWriteStream`：字节原样落盘，不按 UTF-8 解码、
 * 不套 2MB 的有界读——那样 ZIP / 压缩包从第 4 个字节起就被改写并截断。
 *
 * 只在响应 ok 时调用（调用方保证）：4xx/5xx 的正文是 GitHub 的错误 JSON，那种要按文本读出来
 * 给人看，写进目标文件只会把错误变成一堆看不懂的字节，还会留下一个半成品文件。
 *
 * @returns {Promise<{ bytes: number } | { error: object }>}
 */
function streamToFile(res, target, overwrite) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // 不给 overwrite 时用 `wx`：目标已存在就失败，不悄悄覆盖用户手上的文件。存在性在发请求前
    // 已查过一次（那是为了早点报错），这里再让内核判一次，挡住两次检查之间的新建。
    // createWriteStream 的失败走异步 `error` 事件（不是抛），所以不包 try——见下面的处理。
    const out = fs.createWriteStream(target, { flags: overwrite ? "w" : "wx" });
    out.on("error", (e) => {
      // 半成品不留在盘上：写到一半失败（ENOSPC / 权限 / 目标被占用）时删掉这个文件。
      // 先 destroy 再删：Windows 上文件句柄还开着时 unlink 会失败（EPERM）。
      try {
        out.destroy();
      } catch {
        /* 已经毁了 */
      }
      discard(target);
      try {
        res.body && res.body.cancel();
      } catch {
        /* 流已结束 */
      }
      done({ error: { code: writeErrorCode(e), cause: String((e && e.code) || ""), error: String((e && e.message) || e) } });
    });
    // finish 处理器先挂上再决定要不要写体：2xx 但无正文的响应（理论上 200 也可能没体）会走
    // `out.end()`，那时若 finish 还没挂，这个 Promise 就永远不结算——worker 会一直挂到超时。
    // 写完看字节数对不对：响应头声明的 content-length 与实收字节不符 = 下载被截断。
    // 那种情况删掉盘上那份并报错——「不假装成功」在这里就是宁可没有文件，也不要半份。
    //
    // 字节数取 `out.bytesWritten`（写流自己的计数），不给 src 挂 `data` 监听：那会把源流切进
    // flowing 模式，而 pipe 也还在消费它——多一个监听就多一次 race 的余地，没必要。
    out.on("finish", () => {
      const bytes = out.bytesWritten;
      // 只在**确实带了** content-length 时才比对：缺这个头时 `Number(null)` 是 0，直接比会把
      // 每一次正常下载都误报成「声明 0 字节、实收 N 字节」。分块编码的响应本来就没有它。
      const clHeader = res.headers.get("content-length");
      if (clHeader === null) return done({ bytes });
      const declared = Number(clHeader);
      if (Number.isFinite(declared) && declared >= 0 && declared !== bytes) {
        discard(target);
        return done({
          error: {
            code: "download_truncated",
            size: bytes,
            error: "下载不完整：声明 " + declared + " 字节，实收 " + bytes + " 字节。",
          },
        });
      }
      done({ bytes });
    });

    if (!res.body) {
      out.end();
      return;
    }
    const src = Readable.fromWeb(res.body);
    src.on("error", (e) => {
      const cause = e && e.cause ? String(e.cause.message || e.cause.code || "") : "";
      // 网络中途断开：盘上那份是不完整的，删掉再报错（不假装成功，也不留半成品）。
      try {
        out.destroy();
      } catch {
        /* 已经毁了 */
      }
      discard(target);
      done({ error: { code: "body_read_failed", cause, error: String((e && e.message) || e) } });
    });
    src.pipe(out);
  });
}

/** 发一个请求（含分页跟随），返回归一化结果。永不抛出。 */
async function executeOne(req, token) {
  const id = req.id;
  const method = String(req.method || "GET").toUpperCase();

  let url;
  try {
    url = new URL(String(req.url || ""));
  } catch {
    return fail(id, "URL 非法：" + String(req.url || ""));
  }
  const reject = outboundReject(url, ALLOWED_HOSTS, "出站");
  if (reject) {
    return fail(id, reject);
  }

  const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxPages = Number(req.maxPages) > 0 ? Number(req.maxPages) : DEFAULT_MAX_PAGES;
  const bodySpec = buildBody(req);

  // 二进制体的发前检查与响应落盘的目标检查都放在起请求之前：超限 / 写不了要在**白传一遍之前**
  // 就知道（AC11 / AC14），而不是传完几百 MB 再说。
  const fileSize = bodySpec.isFile ? checkFileBody(req) : null;
  if (fileSize && fileSize.error) return fail(id, fileSize.error.error, fileSize.error);
  const size = fileSize ? fileSize.size : undefined;

  const toFile = typeof req.toFile === "string" && req.toFile !== "" ? req.toFile : "";
  if (toFile && req.overwrite !== true) {
    let exists = false;
    try {
      exists = fs.existsSync(toFile);
    } catch {
      exists = false; // 许可根外判不了存在性，交给 createWriteStream 去报
    }
    if (exists) {
      return fail(id, "目标文件已存在：" + toFile, { code: "target_exists" });
    }
  }

  const pages = [];
  let current = url.toString();
  let last = null;

  for (let page = 0; page < (req.paginate ? maxPages : 1); page += 1) {
    const headers = buildHeaders(req, token);
    if (bodySpec.contentType && bodySpec.make) headers["Content-Type"] = bodySpec.contentType;
    // 发布资产端点要的是原始二进制体，**必须显式带 Content-Length**：给了它 undici 才不走
    // 分块编码（实测：3MB 文件 sha256 一字不差、Transfer-Encoding 未使用）。
    if (bodySpec.isFile && size !== undefined) headers["Content-Length"] = String(size);

    let res;
    let lastErr = null;
    // 连接层失败重试（见 CONNECT_ERROR_CODES）：只重试“请求没到服务端”的情形。
    for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt += 1) {
      try {
        res = await fetchChecked(current, {
          method,
          headers,
          // 造体函数（不是体本身）：每次尝试、每一跳都要一个新体——流用过一次就没了。
          makeBody: bodySpec.make,
          streamBody: bodySpec.isFile,
          timeoutMs,
        });
        lastErr = null;
        break;
      } catch (e) {
        const code = connectErrorCode(e);
        if (code && attempt < CONNECT_RETRIES) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        const cause = e && e.cause ? String(e.cause.message || e.cause.code || "") : "";
        return fail(
          id,
          "请求失败：" + String((e && e.message) || e) + (cause ? "（" + cause + "）" : "") +
            (code ? "［连接层错误已重试 " + CONNECT_RETRIES + " 次］" : ""),
        );
      }
    }
    if (!res) {
      const cause = lastErr && lastErr.cause ? String(lastErr.cause.message || lastErr.cause.code || "") : "";
      return fail(id, "请求失败：" + (cause || "连接未能建立"));
    }

    // 下载侧：响应 ok 且给了 toFile → 字节原样落盘（不读进内存、不按 UTF-8 解码）。
    // 非 2xx 不落盘，走下面那条文本读法，把 GitHub 的错误原文交给调用方。
    if (toFile && res.ok) {
      const written = await streamToFile(res, toFile, req.overwrite === true);
      if (written.error) return fail(id, "写本地文件失败：" + toFile + "：" + written.error.error, written.error);
      last = { id, ok: true, status: res.status, json: null, text: "", truncated: false, bytes: written.bytes, link: res.headers.get("link") || null };
      break;
    }

    // 读体单独包起来：`AbortSignal.timeout` 可能在响应头已到、体还在读时中止；流也可能中途断开。
    // 旧写法让这两种错误冒到 main().catch，**整批请求都报废**——而写操作可能已经生效
    //（如 PR 已创建），调用方重试会撞 422。这里只让该条请求失败，带上已拿到的状态码。
    let read;
    try {
      read = await readBounded(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.message || e.cause.code || "") : "";
      return fail(
        id,
        "读取响应体失败（HTTP " + res.status + "）：" + String((e && e.message) || e) +
          (cause ? "（" + cause + "）" : "") +
          "。注意：服务端可能已经处理了该请求，重试写操作前请先确认。",
        { status: res.status },
      );
    }
    const parsed = parseJson(read.text);
    last = {
      id,
      ok: res.ok,
      status: res.status,
      json: parsed,
      text: read.text,
      truncated: read.truncated,
      link: res.headers.get("link") || null,
    };

    if (!req.paginate || !res.ok) break;
    // 先把本页收进结果，再看有没有下一页：末页的 Link 没有 rel="next"，
    // 先判 next 会把它（也就是最后一页）丢掉。
    if (!Array.isArray(parsed)) break; // 分页端点应回数组；不是就不继续，避免把对象拼坏
    pages.push(...parsed);
    const next = nextLink(last.link);
    if (!next) break;
    current = next;
  }

  if (req.paginate && pages.length > 0 && last) {
    last.json = pages;
    last.pages = pages.length;
  }
  // 文件体的大小与（可选的）本地摘要回给 App 侧：调用方要能报「传了多少字节、传的是哪一份」，
  // 而不是自己再 stat / 再哈希一次——App 进程读不到许可根外的文件，那两件事它都做不了。
  if (last && size !== undefined) last.size = size;
  if (last) {
    const hex = bodySpec.sha256 ? bodySpec.sha256() : null;
    if (hex) last.sha256 = hex;
  }
  return last;
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.log(JSON.stringify({ fatal: "stdin 不是 JSON：" + String((e && e.message) || e) }));
    return;
  }
  const token = typeof input.token === "string" ? input.token : "";
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const results = [];
  for (const req of requests) {
    results.push(await executeOne(req && typeof req === "object" ? req : {}, token));
  }
  console.log(JSON.stringify({ results }));
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: String((e && e.message) || e) }));
});
