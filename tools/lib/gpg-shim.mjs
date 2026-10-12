// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/gpg-shim.mjs — 顶替 gpg 可执行文件的签名/验签程序（独立入口，随包）。
 *
 * ## 为什么存在
 *
 * git 通过 `gpg.program` 调一个**外部程序**来完成签名与验签。它不要求那个程序是 gpg，
 * 只要求它符合下面这套契约（本文件实现的就是这套契约）。于是我们可以用纯 JS 的
 * OpenPGP.js 顶替随包的 GnuPG 二进制：包体省 5.45 MB（压缩后），三平台同一实现，
 * 且不再需要 GNUPGHOME 隔离与 gpg-agent 收尾。
 *
 * ## git 的契约（均为实测）
 *
 *   签名：<prog> --status-fd=<fd> -bsau <keyid>
 *         payload 走 **stdin**；armored detached 签名写 **stdout**；
 *         进度/状态写 `--status-fd` 指向的 fd。
 *   验签：<prog> --keyid-format=long --status-fd=<fd> --verify <sigfile> -
 *         `<sigfile>` 里**只有签名**（没有 payload）；payload 走 **stdin**（末尾的 `-`）。
 *         git 会解析 status-fd 上的 `GOODSIG` / `VALIDSIG` 行判定结果——**只退 0 不够**。
 *
 * ## 密钥从哪来
 *
 * 环境变量 `GITHANA_KEY_FILE` 指向 dataDir 下的 gpg-key.json（DPAPI 加密的 armored 私钥）。
 * 本进程在 AppHost 的权限模型下运行（`--permission` 经 NODE_OPTIONS 传染），能读 dataDir
 * 是因为宿主的 AppHost 命令行带了 `--allow-fs-read=<dataDir>`（实测）。
 *
 * ## stdout 只走协议
 *
 * stdout 只有签名（git 直接拿它当 gpgsig 内容），诊断一律走 stderr。
 *
 * ## 它不认识 GitHub
 *
 * 上传公钥、账号绑定那些都在 App 侧（lib/gpg-publish.js）。这里只做「拿密钥签/验一段字节」。
 */
import fs from "node:fs";
import * as openpgp from "openpgp";
import { dpapiUnprotect } from "../../lib/dpapi.js";

/** 密钥文件里记录的加密算法标识（与 lib/secret.js 的后端 alg 同口径）。 */
const DPAPI_ALG = "dpapi-current-user";

function die(msg, code = 2) {
  process.stderr.write("[githana-gpg-shim] " + msg + "\n");
  process.exit(code);
}

/** 解析 `--status-fd=N`。 */
function parseStatusFd(argv) {
  for (const a of argv) {
    const m = /^--status-fd=(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 往 status fd 写一行（[GNUPG:] 前缀是 git 认的格式）。 */
function makeStatus(fd) {
  return (line) => {
    if (fd === null) return;
    try {
      fs.writeSync(fd, "[GNUPG:] " + line + "\n");
    } catch {
      /* fd 不可写（git 版本差异）：不影响主流程 */
    }
  };
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

/** 读并解密 armored 私钥。 */
function loadPrivateKeyArmored() {
  const keyFile = readEnv("GITHANA_KEY_FILE");
  if (!keyFile) die("未提供 GITHANA_KEY_FILE：无法定位签名密钥。");
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  } catch (e) {
    die("读密钥文件失败（" + keyFile + "）：" + String((e && e.message) || e));
  }
  if (!rec || typeof rec.cipher !== "string" || !rec.cipher) {
    die("密钥文件里没有密文：请到设置页重新生成密钥。");
  }
  if (rec.alg && rec.alg !== DPAPI_ALG) {
    die("密钥由 " + rec.alg + " 保护，本机后端是 " + DPAPI_ALG + "：无法解密（换机器或换用户了？）。");
  }
  try {
    return dpapiUnprotect(rec.cipher);
  } catch (e) {
    die("解密私钥失败：" + String((e && e.message) || e) + "（换机器或换用户了？）");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const status = makeStatus(parseStatusFd(argv));
  const isVerify = argv.includes("--verify");

  const armored = loadPrivateKeyArmored();
  let priv;
  try {
    priv = await openpgp.readKey({ armoredKey: armored });
  } catch (e) {
    die("私钥不可解析：" + String((e && e.message) || e));
  }
  const fpr = priv.getFingerprint().toUpperCase();
  const keyId = priv.getKeyID().toHex().toUpperCase();
  const uid = (() => {
    try {
      const u = priv.getUserIDs()[0] || "";
      return u;
    } catch {
      return "";
    }
  })();

  if (isVerify) {
    // 验签：sigfile 只含签名，payload 走 stdin。
    const sigFile = argv.find((a) => !a.startsWith("--") && a !== "-");
    if (!sigFile) {
      status("FAILURE verify_missing_arg");
      die("验签缺少签名文件参数。", 2);
    }
    let sigText = "";
    let payload = "";
    try {
      sigText = fs.readFileSync(sigFile, "utf8");
    } catch (e) {
      status("FAILURE verify_read");
      die("读签名文件失败：" + String((e && e.message) || e), 2);
    }
    try {
      payload = fs.readFileSync(0, "utf8");
    } catch {
      /* 无 stdin */
    }
    try {
      const sig = await openpgp.readSignature({ armoredSignature: sigText });
      const res = await openpgp.verify({
        message: await openpgp.createMessage({ text: payload }),
        signature: sig,
        verificationKeys: priv.toPublic(),
      });
      await res.signatures[0].verified; // 不通过会抛
      status("NEWSIG");
      status("GOODSIG " + keyId + " " + uid);
      status("VALIDSIG " + fpr + " 2026-01-01 0 0 4 0 1 8 00 " + fpr);
      process.exit(0);
    } catch {
      status("BADSIG " + keyId + " " + uid);
      die("签名验证不通过（Signed digest did not match）。", 1);
    }
  }

  // 签名：payload 走 stdin，armored detached 签名到 stdout。
  let payload = "";
  try {
    payload = fs.readFileSync(0, "utf8");
  } catch {
    /* 空 payload */
  }
  let sig;
  try {
    sig = await openpgp.sign({
      message: await openpgp.createMessage({ text: payload }),
      signingKeys: priv,
      detached: true,
      format: "armored",
    });
  } catch (e) {
    die("签名失败：" + String((e && e.message) || e));
  }
  process.stdout.write(sig.endsWith("\n") ? sig : sig + "\n");
  status("SIG_CREATED B 1 22 8 00 0 " + fpr);
  process.exit(0);
}

main().catch((e) => die(String((e && e.message) || e)));
