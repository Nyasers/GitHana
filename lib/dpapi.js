// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/dpapi.js — Windows DPAPI（CurrentUser）加解密的最小实现。
 *
 * ## 为什么单独一个文件
 *
 * 两处消费者，分属不同进程：
 *   · App 进程（lib/secret.js 存 OAuth 令牌、lib/openpgp-key.js 存私钥）；
 *   · 签名 shim（由 git spawn 的独立进程，要解开私钥才能签）。
 * 两者各自被打进不同的 bundle，所以这份实现不能依赖 App 侧的模块（bin.js / exec.js
 * 会带进 pluginRoot 推导等一堆东西）。它只依赖 node 内置，两边都能直接内联。
 *
 * ## 为什么走 powershell
 *
 * Node 没有内置 DPAPI 绑定。ProtectedData 在 System.Security 程序集里，只能经
 * powershell 调。代价是每次加解密一个进程（约 150ms）——签名每次提交一次，可接受。
 *
 * ## 只有 win32
 *
 * macOS / Linux 没有 DPAPI。这两平台的凭据存储本来就是未实现状态（lib/secret.js 的
 * keychain / libsecret 后端都是 TODO），所以这里如实返回不可用，由调用方报「本平台暂
 * 无可用的加密后端」，不静默降级到明文。
 */
import { execFileSync } from "node:child_process";

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

/** 本机是否可用（仅 Windows）。 */
export function dpapiAvailable() {
  return process.platform === "win32";
}

/** 同步跑一段 powershell，stdin 传入 input，返回 stdout（trim）。 */
function runPowerShellSync(script, input) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: String(input ?? ""), encoding: "utf8", windowsHide: true, timeout: 60_000 },
  ).trim();
}

/** 加密一段文本，返回 base64 密文。非 win32 抛出。 */
export function dpapiProtect(text) {
  if (!dpapiAvailable()) throw new Error("DPAPI 仅在 Windows 上可用");
  return runPowerShellSync(PS_PROTECT, String(text ?? ""));
}

/** 解密 base64 密文，返回原文。非 win32 抛出。 */
export function dpapiUnprotect(cipher) {
  if (!dpapiAvailable()) throw new Error("DPAPI 仅在 Windows 上可用");
  return runPowerShellSync(PS_UNPROTECT, String(cipher ?? ""));
}
