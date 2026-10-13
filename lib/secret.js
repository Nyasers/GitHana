// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/secret.js — GitHub 凭据的本地加密存放（后端可插拔）。
 *
 * ## 为什么不是「交给 gh 的系统凭据库」
 *
 * GitHana 的隔离原则是「密钥不出 App 边界」：gitconfig 隔离、私钥只落本 App 的 dataDir（DPAPI 加密）、
 * 令牌只在 App 进程内存与 REST worker 之间流转。把令牌塞进 gh 的全局存储，等于让用户自己的 gh、
 * 还把 App 的操作变成全局状态变更——爆炸半径反而变大。所以凭据留在 App 自己的命名空间里。
 *
 * ## 为什么必须加密
 *
 * 明文落盘的问题是真的：.hanako 下的 ACL 对 Authenticated Users 是 Modify，令牌一旦以明文
 * 落在数据目录里，同用户进程都能读。所以令牌只走加密后端，没有明文回退。
 *
 * ## 凭据形态：只有 OAuth 一种
 *
 * 凭据来自 GitHub App device flow 签发的 user access token（`ghu_`）。文件结构：
 *
 *   { schemaVersion: 2, kind: "oauth", backend, alg, storage, cipher,
 *     meta: { login, name, expiresAt, refreshExpiresAt, clientId, needsReauth? } }
 *
 * `cipher` 经后端保护，解出来是 JSON `{ accessToken, refreshToken }`；`meta` 是非机密对象，
 * 明文可读——设置页据此显示账号与到期时间，不需要解密，也不必把令牌送进页面。
 *
 * 旧记录（schemaVersion 1，密文解出裸 PAT）**读但不采用**：不报错、不动文件、不注入
 * GH_TOKEN，设置页提示「PAT 通道已停用」并提供显式清除入口。
 *
 * ## Client ID 由本 App 固定
 *
 * Client ID 非机密，就是本 App 注册的那一个（DEFAULT_CLIENT_ID），不支持用户修改：改它只会
 * 让登录指向别的 GitHub App，而本 App 的权限与发布链路都绑在注册的那个上。凭据记录里的
 * `meta.clientId` 只记录「这份令牌由哪个 Client 签发」，不承担配置职责。
 *
 * ## 后端可插拔（当前只有 Windows）
 *
 * 每个后端提供 { id, alg, storage, available, protect, unprotect }：
 *   - win32  ：DPAPI（CurrentUser）→ 密文写 <dataDir>/credential.json          [已实现]
 *   - darwin ：（待接）Keychain `security add-generic-password`，服务名入 App 命名空间
 *   - linux  ：（待接）libsecret `secret-tool store/lookup`，属性带 App 命名空间
 *   - none   ：无可用后端 → **拒绝保存**（明确报错），读取按「未配置」处理
 *
 * 后端为 keyring 形态时，密文不进文件，文件里只留一条定位记录（service/account）；
 * 文件里的 `alg` 用来判定「这份密文是不是本机这个后端写的」——不匹配就明说解不开，
 * 不静默当未配置（避免用户以为配好了）。
 *
 * ## 进程内缓存
 *
 * 解密是异步的（win32 要拉起 powershell 调 ProtectedData），而工具调用需要在发起请求前
 * 同步知道“有没有令牌”；所以结果写进 tools/lib/context.js 的单例（令牌 + meta），工具只同步读。
 * 令牌由 REST worker 的调用方经 stdin 传给它（见 tools/lib/rest.js），不经子进程 env。
 */
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../tools/lib/exec.js";
import { getToolDataDir, setToolSecretToken, setToolOAuthMeta } from "../tools/lib/context.js";

const SECRET_FILE = "credential.json";
/** 凭据记录结构版本：2 = OAuth（1 = 已停用的 PAT 记录） */
const SCHEMA_VERSION = 2;
/** keyring 形态下写进文件的定位记录（不含密文） */
const KEYRING_SERVICE = "hana-githana";

/**
 * 本 App 注册的 GitHub App Client ID（非机密）。
 * 权限、发布链路与 device flow 都绑在这个 App 上，所以它是常量，不开放覆盖。
 */
export const DEFAULT_CLIENT_ID = "Iv23li0dA1IaFVs6klAc";

/** <dataDir>/credential.json */
export function secretFilePath(dataDir) {
  return path.join(dataDir || getToolDataDir() || "", SECRET_FILE);
}

// ───────────────────────────── win32：DPAPI ─────────────────────────────

const PS_PROTECT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch { }",
  "$in=[Console]::OpenStandardInput()",
  "$ms=New-Object System.IO.MemoryStream",
  "$in.CopyTo($ms)",
  "$bytes=$ms.ToArray()",
  "$p=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Convert]::ToBase64String($p)",
].join("; ");

const PS_UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch { }",
  "$sr=New-Object System.IO.StreamReader([Console]::OpenStandardInput())",
  "$b64=$sr.ReadToEnd().Trim()",
  "$p=[Convert]::FromBase64String($b64)",
  "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Text.Encoding]::UTF8.GetString($bytes)",
].join("; ");

async function runPowerShell(script, input) {
  const r = await runCli("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    timeoutSec: 60,
  });
  if (!r.ok) {
    const raw = [r.stdout, r.stderr].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
    throw new Error(raw || r.message || "powershell 调用失败");
  }
  return String(r.stdout || "").trim();
}

const WIN32_BACKEND = {
  id: "win32-dpapi",
  alg: "dpapi-current-user",
  storage: "file",
  available: () => process.platform === "win32",
  protect: (text) => runPowerShell(PS_PROTECT, String(text)),
  unprotect: (cipher) => runPowerShell(PS_UNPROTECT, String(cipher)),
};

// ─────────────────────── 待接后端（跨平台时补齐） ───────────────────────
//
// 两个都应当是 keyring 形态：密文交给系统保险箱，App 命名空间体现在 service/account 上，
// 文件里只留定位记录。下面留出契约，实现时替换 available/protect/unprotect 即可，
// 上层（saveCredential / loadSecretIntoContext / secretInfo）不需要改。

const DARWIN_BACKEND = {
  id: "darwin-keychain",
  alg: "keychain",
  storage: "keyring",
  available: () => false, // TODO(cross-platform): process.platform === "darwin"
  service: KEYRING_SERVICE,
  protect: async () => {
    throw new Error("macOS Keychain 后端尚未实现");
  },
  unprotect: async () => {
    throw new Error("macOS Keychain 后端尚未实现");
  },
};

const LINUX_BACKEND = {
  id: "linux-libsecret",
  alg: "libsecret",
  storage: "keyring",
  available: () => false, // TODO(cross-platform): 探测 `secret-tool` 是否在 PATH
  service: KEYRING_SERVICE,
  protect: async () => {
    throw new Error("Linux libsecret 后端尚未实现");
  },
  unprotect: async () => {
    throw new Error("Linux libsecret 后端尚未实现");
  },
};

const NONE_BACKEND = {
  id: "none",
  alg: null,
  storage: "none",
  available: () => true,
  protect: async () => {
    throw new Error("本平台暂无可用的加密后端，拒绝以明文落盘");
  },
  unprotect: async () => {
    throw new Error("本平台暂无可用的加密后端");
  },
};

/** 选后端：按平台顺序取第一个可用的；都不行则 none（拒绝保存）。
 *  platform 参数保留给测试注入；实际判定由各后端自己的 available() 决定。
 */
export function pickBackend(platform = process.platform) {
  void platform;
  const candidates = [WIN32_BACKEND, DARWIN_BACKEND, LINUX_BACKEND];
  for (const b of candidates) {
    if (b.available()) return b;
  }
  return NONE_BACKEND;
}

// ───────────────────────────── 记录读写 ─────────────────────────────

/** 读记录；文件不存在/损坏 → null。 */
export function readSecretRecord(dataDir) {
  try {
    const raw = fs.readFileSync(secretFilePath(dataDir), "utf8");
    const rec = JSON.parse(raw);
    if (rec && typeof rec === "object") return rec;
    return null;
  } catch {
    return null;
  }
}

/** 原子写记录（先写临时文件再 rename）。 */
function writeSecretRecord(dataDir, record) {
  const dir = dataDir || getToolDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = secretFilePath(dir);
  const tmp = target + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...record }),
    "utf8",
  );
  fs.renameSync(tmp, target);
}

/** 删除记录（不存在则忽略）。 */
export function removeSecretRecord(dataDir) {
  try {
    fs.unlinkSync(secretFilePath(dataDir));
  } catch {
    /* 不存在 / 权限问题：调用方按「已无本地凭据」处理 */
  }
}

/** 这份记录是不是 OAuth 凭据（v2 固定 kind: "oauth"；其余一律按旧 PAT 记录对待）。 */
function isOAuthRecord(rec) {
  return !!(rec && rec.cipher && rec.kind === "oauth");
}

/** 这份记录是不是旧 PAT 记录（有密文但不是 OAuth 形态）。 */
function isLegacyRecord(rec) {
  return !!(rec && rec.cipher && rec.kind !== "oauth");
}

/** 后端能不能解开这份密文（alg 不匹配 = 别的平台/后端写的）。 */
function backendMismatch(rec, backend) {
  return !!(rec && rec.alg && backend.alg && rec.alg !== backend.alg);
}

/**
 * 本 App 注册的 Client ID。它是常量，不接受覆盖；保留函数形态是为了让调用方不必知道
 * 「从哪来」，将来若真需要多租户再改这里一处即可。
 */
export function readClientId() {
  return DEFAULT_CLIENT_ID;
}

// ───────────────────────────── 对外行为 ─────────────────────────────

/**
 * 启动时把凭据解进进程缓存。永不抛出：解不开就按未配置处理，让 gh 自己回报「未登录」。
 * 旧 PAT 记录走 `source: "legacy-pat"`——读到了但**不采用**，不注入 GH_TOKEN。
 * @returns {{ source: "oauth"|"legacy-pat"|"none", configured: boolean, error?: string, needsReauth?: boolean }}
 */
export async function loadSecretIntoContext(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);

  // 每次加载都先清空进程缓存：凭据被清/被换时不会留下上一份的残留。
  setToolSecretToken("");
  setToolOAuthMeta(null);

  if (isOAuthRecord(rec)) {
    if (backendMismatch(rec, backend)) {
      return {
        source: "oauth",
        configured: false,
        error: `密文由 ${rec.alg} 保护，本机后端是 ${backend.alg}，无法解开`,
      };
    }
    let payload = null;
    try {
      payload = JSON.parse(await backend.unprotect(rec.cipher));
    } catch (e) {
      return { source: "oauth", configured: false, error: String((e && e.message) || e) };
    }
    const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
    setToolOAuthMeta(meta);
    // 刷新令牌已判失效：不注入失效令牌（无其它凭据可降级），设置页据此显示「需重新授权」。
    if (meta.needsReauth === true) {
      return { source: "oauth", configured: false, needsReauth: true };
    }
    const token = String((payload && payload.accessToken) || "");
    setToolSecretToken(token);
    return { source: "oauth", configured: !!token };
  }

  if (isLegacyRecord(rec)) {
    // 旧 PAT：读但不采用。文件保持原样（用户可能还想自己备份），设置页提示 + 提供清除入口。
    return { source: "legacy-pat", configured: false };
  }

  return { source: "none", configured: false };
}

/**
 * 读凭据（解密）。无 OAuth 凭据 / 后端不匹配 / 密文损坏 → null。
 * @returns {Promise<{ token: string, refreshToken: string, meta: object } | null>}
 */
export async function readCredential(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);
  if (!isOAuthRecord(rec)) return null;
  if (backendMismatch(rec, backend)) return null;
  let payload = null;
  try {
    payload = JSON.parse(await backend.unprotect(rec.cipher));
  } catch {
    return null;
  }
  return {
    token: String((payload && payload.accessToken) || ""),
    refreshToken: String((payload && payload.refreshToken) || ""),
    meta: rec.meta && typeof rec.meta === "object" ? { ...rec.meta } : {},
  };
}

/**
 * 保存 OAuth 凭据：走后端加密落盘。没有可用后端时**直接失败**，不写明文。
 * @param {{ dataDir?: string, token: string, refreshToken: string, meta: object }} args
 */
export async function saveCredential({ dataDir, token, refreshToken, meta } = {}) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  if (backend.storage === "none") {
    throw new Error("本平台暂无可用的加密后端（Windows 用 DPAPI，macOS/Linux 后端待接）：拒绝以明文保存令牌。");
  }
  const payload = JSON.stringify({
    accessToken: String(token || ""),
    refreshToken: String(refreshToken || ""),
  });
  const cipher = await backend.protect(payload);
  const cleanMeta = meta && typeof meta === "object" ? { ...meta } : {};
  writeSecretRecord(dir, {
    kind: "oauth",
    backend: backend.id,
    alg: backend.alg,
    storage: backend.storage,
    cipher,
    meta: cleanMeta,
  });
  setToolSecretToken(String(token || ""));
  setToolOAuthMeta(cleanMeta);
  return { protection: backend.alg, backend: backend.id, meta: cleanMeta };
}

/**
 * 只改 meta（不解密、不动密文）——刷新失败打 needsReauth 标记走这里，
 * 避免为改一个布尔值去拉一次 powershell。
 * @returns {object | null} 合并后的 meta（记录不存在/不是 OAuth → null）
 */
export function updateCredentialMeta(dataDir, patch) {
  const dir = dataDir || getToolDataDir();
  const rec = readSecretRecord(dir);
  if (!isOAuthRecord(rec)) return null;
  const meta = { ...(rec.meta && typeof rec.meta === "object" ? rec.meta : {}), ...(patch || {}) };
  // 只保留业务字段；schemaVersion / updatedAt 由 writeSecretRecord 统一重写。
  const rest = { ...rec };
  delete rest.schemaVersion;
  delete rest.updatedAt;
  writeSecretRecord(dir, { ...rest, meta });
  return meta;
}

/** 清除凭据：删记录 + 清进程缓存。 */
export async function clearSecret({ dataDir } = {}) {
  const backend = pickBackend();
  if (backend.storage === "keyring" && typeof backend.clear === "function") {
    try {
      await backend.clear();
    } catch {
      /* 保险箱里没这条 / 删不掉，不影响后续 */
    }
  }
  removeSecretRecord(dataDir || getToolDataDir());
  setToolSecretToken("");
  setToolOAuthMeta(null);
  return { cleared: true };
}

/** 本地是否存在旧 PAT 记录（供设置页提示「PAT 通道已停用」）。 */
export function readLegacyPat(dataDir) {
  return isLegacyRecord(readSecretRecord(dataDir || getToolDataDir()));
}

/**
 * 给设置页看的摘要：是否已授权、保护方式、存放位置、后端是否可用、账号与到期时间
 * （不回传明文；meta 本来就是明文，可以直接读）。
 */
export function secretInfo(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);
  const available = backend.storage !== "none";
  const location = backend.storage === "keyring" ? `${backend.id}（保险箱）` : secretFilePath(dir);
  const legacyPatPresent = isLegacyRecord(rec);
  const oauthRec = isOAuthRecord(rec) ? rec : null;
  const mismatch = oauthRec ? backendMismatch(oauthRec, backend) : false;
  const meta = oauthRec && oauthRec.meta && typeof oauthRec.meta === "object" ? oauthRec.meta : {};

  return {
    configured: !!oauthRec && !mismatch,
    kind: oauthRec ? "oauth" : null,
    protection: (oauthRec && oauthRec.alg) || (legacyPatPresent ? rec.alg || null : null),
    location,
    backend: (rec && rec.backend) || backend.id,
    backendAvailable: available,
    readable: !mismatch,
    login: meta.login ? String(meta.login) : null,
    name: meta.name ? String(meta.name) : null,
    expiresAt: meta.expiresAt ? String(meta.expiresAt) : null,
    refreshExpiresAt: meta.refreshExpiresAt ? String(meta.refreshExpiresAt) : null,
    needsReauth: meta.needsReauth === true,
    legacyPatPresent,
  };
}
