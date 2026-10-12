// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/rest-worker.mjs — GitHub REST 的 HTTP 执行体（独立子进程）。
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
 * 单独审阅——它没有能力去往非白名单主机发东西，也没有能力读写文件。
 *
 * ## 主机白名单在进程内自查
 *
 * `--allow-net=<host>` 的收窄语法在当前 node（实测 v26.8.1）**不生效**：指定
 * `--allow-net=api.github.com` 后请求 `example.com` 仍然成功。运行时的门只能全开，
 * 那就在这一层把门收窄到实际需要的两个主机（再加一个**重定向目标**白名单）。
 *
 * ## 协议
 *
 *   stdin : { token, requests: [ { id?, method?, url, headers?, json?, form?, body?,
 *                                 auth?, timeoutMs?, paginate?, maxPages? } ] }
 *   stdout: { results: [ { id?, ok, status, json, text, truncated, pages?, link?, error? } ] }
 *
 * `auth` 缺省 true → 带 `Authorization: Bearer <token>`；false → 不带该头。
 * `paginate` true → 跟随 `Link: rel="next"` 合并 JSON 数组（上限 maxPages，缺省 10）。
 * `redirect` 不交给 fetch：每一跳都过 REDIRECT_HOSTS，离开 api.github.com 后不带走凭据。
 * 无正文响应（204/304/HEAD）返回 `json: null, text: ""`，不是错误。
 * stdout 只有一行 JSON；诊断一律走 stderr（App 侧只解析 stdout）。
 */

/** 允许出站的主机（其余一律在发请求前拒绝）。 */
const ALLOWED_HOSTS = new Set(["api.github.com", "github.com"]);

/**
 * 允许**重定向落到**的主机。
 *
 * GitHub 的内容端点（`/repos/{o}/{r}/tarball/...`、`/repos/{o}/{r}/zipball/...`、release 资产）
 * 会 302 到 codeload.github.com；它是 GitHub 自己的下载域。不把它列进来就会让这类调用硬失败，
 * 而把 redirect 交给 fetch 自己 follow（旧写法）则等于放弃白名单——两者都不可取。
 * 所以：逐跳校验，且离开 api.github.com 后**不带走凭据**（见带 auth 的复件）。
 */
const REDIRECT_HOSTS = new Set(["api.github.com", "github.com", "codeload.github.com"]);

/** 单请求最多跟随的重定向跳数（防卷回的 Location 把一次调用转死）。 */
const MAX_REDIRECTS = 5;

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
 * 跳数超限或目标不在白名单时**抛出**（不是当作 3xx 回报）：这是拒绝，不是服务端的正常响应。
 */
async function fetchChecked(startUrl, { method, headers, body, timeoutMs }) {
  let url = startUrl;
  let headersNow = headers;
  let methodNow = method;
  let bodyNow = body;
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
    if (!allowed.has(target.host)) {
      throw new Error(
        "拒绝请求：" + target.host + " 不在允许的主机（" + [...allowed].join(" / ") + "）。",
      );
    }
    const res = await fetch(url, {
      method: methodNow,
      headers: headersNow,
      body: bodyNow,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const loc = res.headers.get("location");
    if (!loc) return res;
    let next;
    try {
      next = new URL(loc, url);
    } catch {
      return res; // Location 不是合法 URL：当最终响应回报
    }
    if (!REDIRECT_HOSTS.has(next.host)) {
      throw new Error(
        "拒绝重定向：" + next.host + " 不在允许跟随的主机（" + [...REDIRECT_HOSTS].join(" / ") + "）。",
      );
    }
    // 离开 api.github.com 后不带走凭据：codeload 是公开下载域，把令牌送过去没有必要。
    if (next.host !== "api.github.com" && headersNow.Authorization) {
      const { Authorization, ...rest } = headersNow;
      headersNow = rest;
    }
    // 303 与历史上常见的 301/302 会把非 GET 降为 GET；307/308 保留方法与体。
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && methodNow !== "GET")) {
      methodNow = "GET";
      bodyNow = undefined;
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

/** 组请求体：json → JSON 文本；form → urlencoded；body → 原样字符串。三者互斥，json 优先。 */
function buildBody(req) {
  if (req.json !== undefined && req.json !== null) {
    return { body: JSON.stringify(req.json), contentType: "application/json" };
  }
  if (req.form !== undefined && req.form !== null) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) params.append(k, String(v));
    return { body: params.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (typeof req.body === "string" && req.body !== "") {
    return { body: req.body, contentType: null };
  }
  return { body: undefined, contentType: null };
}

/** 发一个请求（含分页跟随），返回归一化结果。永不抛出。 */
async function executeOne(req, token) {
  const id = req.id;
  const method = String(req.method || "GET").toUpperCase();

  let url;
  try {
    url = new URL(String(req.url || ""));
  } catch {
    return { id, ok: false, status: null, error: "URL 非法：" + String(req.url || "") };
  }
  if (!ALLOWED_HOSTS.has(url.host)) {
    return {
      id,
      ok: false,
      status: null,
      error:
        "拒绝出站：" + url.host + " 不在本 App 的白名单（" +
        [...ALLOWED_HOSTS].join(" / ") + "）。",
    };
  }

  const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxPages = Number(req.maxPages) > 0 ? Number(req.maxPages) : DEFAULT_MAX_PAGES;
  const { body, contentType } = buildBody(req);

  const pages = [];
  let current = url.toString();
  let last = null;

  for (let page = 0; page < (req.paginate ? maxPages : 1); page += 1) {
    const headers = buildHeaders(req, token);
    if (contentType && body !== undefined) headers["Content-Type"] = contentType;

    let res;
    let lastErr = null;
    // 连接层失败重试（见 CONNECT_ERROR_CODES）：只重试“请求没到服务端”的情形。
    for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt += 1) {
      try {
        res = await fetchChecked(current, {
          method,
          headers,
          body: body === undefined ? undefined : body,
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
        return {
          id,
          ok: false,
          status: null,
          error:
            "请求失败：" + String((e && e.message) || e) + (cause ? "（" + cause + "）" : "") +
            (code ? "［连接层错误已重试 " + CONNECT_RETRIES + " 次］" : ""),
        };
      }
    }
    if (!res) {
      const cause = lastErr && lastErr.cause ? String(lastErr.cause.message || lastErr.cause.code || "") : "";
      return { id, ok: false, status: null, error: "请求失败：" + (cause || "连接未能建立") };
    }

    // 读体单独包起来：`AbortSignal.timeout` 可能在响应头已到、体还在读时中止；流也可能中途断开。
    // 旧写法让这两种错误冒到 main().catch，**整批请求都报废**——而写操作可能已经生效
    //（如 PR 已创建），调用方重试会撞 422。这里只让该条请求失败，带上已拿到的状态码。
    let read;
    try {
      read = await readBounded(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.message || e.cause.code || "") : "";
      return {
        id,
        ok: false,
        status: res.status,
        error:
          "读取响应体失败（HTTP " + res.status + "）：" + String((e && e.message) || e) +
          (cause ? "（" + cause + "）" : "") +
          "。注意：服务端可能已经处理了该请求，重试写操作前请先确认。",
      };
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
