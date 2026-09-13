// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/secret.js — GitHub 令牌的本地加密存放（后端可插拔）。
 *
 * ## 为什么不是「交给 gh 的系统凭据库」
 *
 * GitHana 的隔离原则是「密钥不出 App 边界」：gitconfig 隔离、GNUPGHOME 隔离、GH_TOKEN
 * 按次注入。把令牌塞进 gh 的全局存储，等于让用户自己的 gh、任何同用户进程都能用它，
 * 还把 App 的操作变成全局状态变更——爆炸半径反而变大。所以凭据留在 App 自己的命名空间里。
 *
 * ## 为什么必须加密
 *
 * 明文落盘的问题是真的：.hanako 下的 ACL 对 Authenticated Users 是 Modify，令牌一旦以明文
 * 落在数据目录里，同用户进程都能读。所以令牌只走加密后端，没有明文回退。
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
 * 解密是异步的（win32 要拉起 powershell 调 ProtectedData），而 buildBinEnv 必须在 spawn
 * 前同步拿到 GH_TOKEN；所以结果写进 tools/lib/context.js 的单例，工具只同步读。
 */
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../tools/lib/exec.js";
import { getToolDataDir, setToolSecretToken } from "../tools/lib/context.js";

const SECRET_FILE = "credential.json";
const SCHEMA_VERSION = 1;
/** keyring 形态下写进文件的定位记录（不含密文） */
const KEYRING_SERVICE = "hana-githana";

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
    omitToken: true,
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
// 上层（saveSecret / loadSecretIntoContext / secretInfo）不需要改。

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

// ───────────────────────────── 对外行为 ─────────────────────────────

/**
 * 启动时把令牌解进进程缓存。永不抛出：解不开就按未配置处理，让 gh 自己回报「未登录」。
 * @returns {{ source: string, configured: boolean, error?: string }}
 */
export async function loadSecretIntoContext(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);

  if (rec && rec.cipher) {
    // 密文带 alg：不匹配说明是别的平台/别的后端写的，明确说明而不是静默当未配置。
    if (rec.alg && backend.alg && rec.alg !== backend.alg) {
      setToolSecretToken("");
      return {
        source: "encrypted",
        configured: false,
        error: `密文由 ${rec.alg} 保护，本机后端是 ${backend.alg}，无法解开`,
      };
    }
    try {
      const text = await backend.unprotect(rec.cipher);
      setToolSecretToken(text);
      return { source: "encrypted", configured: !!text };
    } catch (e) {
      setToolSecretToken("");
      return { source: "encrypted", configured: false, error: String((e && e.message) || e) };
    }
  }

  setToolSecretToken("");
  return { source: "none", configured: false };
}

/**
 * 保存令牌：走后端加密落盘。没有可用后端时**直接失败**，不写明文。
 */
export async function saveSecret({ dataDir, token } = {}) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  if (backend.storage === "none") {
    throw new Error("本平台暂无可用的加密后端（Windows 用 DPAPI，macOS/Linux 后端待接）：拒绝以明文保存令牌。");
  }
  const cipher = await backend.protect(token);
  writeSecretRecord(dir, { backend: backend.id, alg: backend.alg, storage: backend.storage, cipher });
  setToolSecretToken(token);
  return { protection: backend.alg, backend: backend.id };
}

/** 清除令牌：删记录 + 清进程缓存（keyring 形态时 backend.clear 由各后端实现）。 */
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
  return { cleared: true };
}

/** 给设置页看的摘要：是否已配置、保护方式、存放位置、后端是否可用（不回传明文）。 */
export function secretInfo(dataDir) {
  const dir = dataDir || getToolDataDir();
  const backend = pickBackend();
  const rec = readSecretRecord(dir);
  const available = backend.storage !== "none";
  if (rec && rec.cipher) {
    const mismatch = !!(rec.alg && backend.alg && rec.alg !== backend.alg);
    return {
      configured: !mismatch,
      protection: rec.alg || backend.alg,
      location: backend.storage === "keyring" ? `${backend.id}（保险箱）` : secretFilePath(dir),
      backend: rec.backend || backend.id,
      backendAvailable: available,
      readable: !mismatch,
    };
  }
  return {
    configured: false,
    protection: null,
    location: backend.storage === "keyring" ? `${backend.id}（保险箱）` : secretFilePath(dir),
    backend: backend.id,
    backendAvailable: available,
    readable: true,
  };
}
