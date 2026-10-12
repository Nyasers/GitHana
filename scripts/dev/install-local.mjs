// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/install-local.mjs — 把本地打好的 zip 装进宿主（开发循环用）
//
// 走宿主自己的扩装面（与界面里「安装本地包」同一条）：
//   DELETE /api/extensions/app:<id>
//   → POST /api/extensions/install（source = { type: "local", path }）
//   → POST /api/extensions/staged/<stagedId>/confirm
//   → 轮询本 App 的 Status 端点，确认服务端入口已加载、路由应答
// 宿主的地址与令牌取自 <HANA_HOME>/server-info.json（{ port, token }）——HANA_HOME 缺省
// 是 ~/.hanako，可用 --home 或环境变量 HANA_HOME 覆盖。
//
// **就绪判据与本 App 的形态相配**：GitHana 没有受管运行时（DSHana 那种要等 runtime start），
// 安装后服务端入口由宿主重新 import、路由随即注册。所以“就绪”= Status 端点能应答出一份快照，
// 而不是等某个 phase。拿 DSHana 的 boot-state 当通用判据会永远等不到。
//
// 为什么是脚本不是 README 里的一段手工步骤：这条循环每次改完都要走一遍，且“卸载→提交→确认→
// 等就绪”四步里任何一步的口径（幂等卸载、stagedId 从哪取、就绪判据是什么）都容易记岔；跨平台
// 一份脚本比在每个平台上各养一份 ps1/sh 划算，还能顺带打 SHA/包大小/版本。
//
// 用法：node scripts/dev/install-local.mjs [--zip] <包>.zip [--id githana] [--home <HANA_HOME>]
//        [--no-uninstall] [--timeout <秒>] [--quiet]
// 退出码：0 = 安装完成且路由已应答；1 = 任一步骤失败或超时；2 = 参数/环境问题。
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errText } from "../shared/err-text.mjs";
import { hasFlag, positionals, value } from "../shared/args.mjs";

const zipArg = value("--zip") || positionals(["--zip", "--id", "--home", "--timeout"])[0];
const appId = value("--id") || "githana";
const home = resolve(value("--home") || process.env.HANA_HOME || join(homedir(), ".hanako"));
const uninstallFirst = !hasFlag("--no-uninstall");
const quiet = hasFlag("--quiet");
const readyTimeoutSec = Number(value("--timeout") || 600);
// 未校验时 Number("abc") → NaN，deadline 也变 NaN，而 `Date.now() > NaN` 恒为 false ——
// 就绪轮询会**永不超时**。参数错按本文件头声明的退出码 2。
if (!Number.isFinite(readyTimeoutSec) || readyTimeoutSec <= 0) {
  fail(2, `--timeout 需为正数秒（收到：${value("--timeout")}）`);
}

/** 参数/环境问题（退出码 2）或运行失败（退出码 1）。 */
function fail(code, message) {
  console.error(`[install-local] ${message}`);
  process.exit(code);
}

if (!zipArg) fail(2, "缺包路径：node scripts/dev/install-local.mjs [--zip] <包>.zip（用法见本文件头注释）");
const zip = resolve(zipArg);
if (!existsSync(zip)) fail(2, `包不存在：${zip}`);

const infoPath = join(home, "server-info.json");
if (!existsSync(infoPath)) fail(2, `找不到 ${infoPath}（宿主没在跑？）`);
const info = JSON.parse(readFileSync(infoPath, "utf8"));
if (!info || typeof info.port !== "number" || typeof info.token !== "string") {
  fail(2, `${infoPath} 形状不对（需要 { port, token }）`);
}
const base = `http://127.0.0.1:${info.port}`;
const log = (...args) => {
  if (!quiet) console.log("[install-local]", ...args);
};

/** 一次宿主 API 调用。 */
async function api(method, path, body, timeoutMs = 1800000) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${info.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 原样带回 */
  }
  if (!res.ok) {
    const detail = parsed ? JSON.stringify(parsed) : text.slice(0, 400);
    throw new Error(`${method} ${path} → HTTP ${res.status}：${detail}`);
  }
  return parsed;
}

/** zip 的 SHA256（流式，几百 MB 也不吃内存）。 */
function digest(path) {
  return new Promise((ok, no) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", no);
    stream.on("end", () => ok(hash.digest("hex").toUpperCase()));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bytes = statSync(zip).size;
  const sha = await digest(zip);
  log(`包：${zip}`);
  log(`  大小 ${bytes.toLocaleString("en-US")} 字节 · SHA256 ${sha}`);

  if (uninstallFirst) {
    log("1/4 卸载旧版 …");
    // 没装过不是失败：宿主回 404 EXTENSION_NOT_FOUND，卸载这一步是幂等的。
    try {
      const removed = await api("DELETE", `/api/extensions/app:${appId}`, undefined, 300000);
      log(`  卸载 ok=${String(removed && removed.ok === true)}`);
    } catch (e) {
      const text = errText(e);
      if (!/HTTP 404|EXTENSION_NOT_FOUND/.test(text)) throw e;
      log(`  本机没装过 ${appId}，跳过卸载`);
    }
  } else {
    log("1/4 跳过卸载（--no-uninstall）");
  }

  log("2/4 提交 staging（本地包要解包，慢是正常的）…");
  const staged = await api("POST", "/api/extensions/install", {
    kind: "app",
    source: { type: "local", path: zip },
  });
  const stagedId = staged && staged.staged && staged.staged.stagedId;
  if (typeof stagedId !== "string" || !stagedId) {
    throw new Error(`提交后没拿到 stagedId：${JSON.stringify(staged).slice(0, 400)}`);
  }
  log(
    `  status=${staged.status} stagedId=${stagedId} version=${staged.staged.version}` +
      ` warnings=${Array.isArray(staged.staged.warnings) ? staged.staged.warnings.length : 0}`,
  );

  log("3/4 确认安装 …");
  const confirmed = await api("POST", `/api/extensions/staged/${stagedId}/confirm`, undefined, 900000);
  log(`  status=${confirmed.status} version=${confirmed.record.version}`);

  log(`4/4 等 Status 端点应答（最多 ${readyTimeoutSec} 秒）…`);
  const deadline = Date.now() + readyTimeoutSec * 1000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await sleep(attempt === 1 ? 1000 : 3000);
    // 本 App 的就绪面：路由注册完 → /routes/status 能给出快照。
    // 判据是 appId 对得上（快照由本 App 的注册函数应答），不断言工具字段：
    // 那属于平台差异（如 macOS 走系统 gpg），不是“装没装上”的信号。
    let snapshot = null;
    try {
      snapshot = await api("GET", `/api/apps/${appId}/routes/status`, undefined, 20000);
    } catch (e) {
      log(`  第 ${attempt} 次：status 取不到（${errText(e)}）`);
    }
    if (snapshot && snapshot.appId === appId) {
      const tools = snapshot.tools || {};
      const bundled = Object.entries(tools)
        .filter(([, v]) => v && v.bundled)
        .map(([k]) => k);
      log(`  第 ${attempt} 次：status 应答正常（内嵌工具：${bundled.join(", ") || "无"}）`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`等待路由应答超时（${readyTimeoutSec}s）`);
  }
}

main().then(
  () => {
    log("完成。");
  },
  (e) => fail(1, `失败：${errText(e)}`),
);
