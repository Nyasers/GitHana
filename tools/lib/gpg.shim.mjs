// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * tools/lib/gpg.shim.mjs — 顶替 gpg 可执行文件的签名/验签程序（独立入口，随包）。
 *
 * ## 为什么存在
 *
 * git 通过 `gpg.program` 调一个**外部程序**来完成签名与验签。它不要求那个程序是 gpg，
 * 只要求它符合下面这套契约（本文件实现的就是这套契约）。于是我们可以用纯 JS 的
 * OpenPGP.js 顶替 GnuPG 二进制：包体只留一份 395 KB 的库文件（原先随包的 GnuPG 压缩后 5.45 MB），
 * 三平台同一实现，且不再需要 GNUPGHOME 隔离与 gpg-agent 收尾。
 *
 * ## git 的契约（均为实测）
 *
 *   签名：<prog> --status-fd=<fd> -bsau <keyid>
 *         payload 走 **stdin**；armored detached 签名写 **stdout**；
 *         进度/状态写 `--status-fd` 指向的 fd。
 *   验签：<prog> --keyid-format=long --status-fd=<fd> --verify <sigfile> -
 *         `<sigfile>` 里**只有签名**（没有 payload）；payload 走 **stdin**（末尾的 `-`）。
 *         git 会解析 status-fd 上的 `GOODSIG` / `VALIDSIG` / `TRUST_ULTIMATE` 行判定结果——
 *         **只退 0 不够**，缺 TRUST_* 时 `%G?` 会落到 U 而不是 G。可读文本走 stderr，
 *         git 原样转发给 `--show-signature` 的显示。
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

/**
 * 解析 git 传来的签名密钥选择（`-bsau <selector>` 的 selector 值；也兼容 `-u` / `--local-user`）。
 *
 * git 把 `user.signingKey` 的**原值**原样放在这里（实测）：可能是完整指纹、短/长 keyID，
 * 也可能是 uid 或邮箱；未配 `user.signingKey` 时，git 传的是合成身份 `Name <email>`。
 * 没给出选择时返回 null。
 */
function parseSigningSelector(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-u" || a === "--local-user") return argv[i + 1] ?? null;
    if (a.startsWith("--local-user=")) return a.slice("--local-user=".length);
    // 合并短选项组（git 实际发的是 `-bsau`）：u 后面紧跟值，或值在下一个 token。
    const m = /^-[a-zA-Z]*u(.+)?$/.exec(a);
    if (m) return m[1] ?? argv[i + 1] ?? null;
  }
  return null;
}

/** 归一化：压空白、去首尾、小写（keyID 与 uid 比对都按这个口径）。 */
function normId(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 本机密钥能被 git/GnuPG 用来指认自己的所有写法：完整指纹、长/短 keyID、每个 uid 全文、
 * uid 里的邮箱。用于比对 `-u` 的 selector——对不上说明 git 要的是**另一把**密钥。
 */
function keyIdentifiers(priv) {
  const set = new Set();
  const add = (s) => {
    const v = normId(s);
    if (v) set.add(v);
  };
  add(priv.getFingerprint());
  const keyId = priv.getKeyID().toHex();
  add(keyId);
  add(keyId.slice(-8)); // 短 keyID
  for (const uid of priv.getUserIDs()) {
    add(uid);
    const m = /<([^>]+)>/.exec(uid);
    if (m) add(m[1]);
  }
  return set;
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
    // 验签：sigfile 只含签名（armored 文本），payload 走 stdin。
    const sigFile = argv.find((a) => !a.startsWith("--") && a !== "-");
    if (!sigFile) {
      status("FAILURE verify_missing_arg");
      die("验签缺少签名文件参数。", 2);
    }
    let sigText = "";
    let payload = Buffer.alloc(0);
    try {
      sigText = fs.readFileSync(sigFile, "utf8");
    } catch (e) {
      status("FAILURE verify_read");
      die("读签名文件失败：" + String((e && e.message) || e), 2);
    }
    try {
      // 按**原始字节**读（不定编码）：git 签的是提交对象的精确字节，用文本模式读会把
      // 非法 UTF-8 字节换成 U+FFFD，凭空改变被验的内容。
      payload = fs.readFileSync(0);
    } catch {
      /* 无 stdin */
    }
    let sig;
    try {
      sig = await openpgp.readSignature({ armoredSignature: sigText });
    } catch (e) {
      status("FAILURE verify_read");
      die("签名文件不可解析：" + String((e && e.message) || e), 2);
    }
    // 先认签名者是不是本机这把密钥。不是的话，这是「本地没有对应公钥」，不是「签名坏了」：
    // GnuPG 对未知密钥发 ERRSIG/NO_PUBKEY 并退 2，而不是 BADSIG。混为一谈会让
    // `git log --show-signature` 把协作者（或 GitHub web-flow）的有效签名报成伪造。
    const signerIds = sig.getSigningKeyIDs().map((k) => k.toHex().toUpperCase());
    if (!signerIds.includes(keyId)) {
      status("ERRSIG " + (signerIds[0] || "") + " 22 8 00 0 9");
      status("NO_PUBKEY " + (signerIds[0] || ""));
      die("本地没有签署该内容的公钥（署名 keyID " + signerIds.join("/") + "，本机是 " + keyId + "）。", 2);
    }
    try {
      const res = await openpgp.verify({
        message: await openpgp.createMessage({ binary: payload }),
        signature: sig,
        verificationKeys: priv.toPublic(),
      });
      await res.signatures[0].verified; // 不通过会抛
      // 状态行与可读文本都照 GnuPG 的口径发：git 自己只看状态行，可读的那几行由它原样
      // 转给用户（`--show-signature` 的显示就是这些）。
      const pack = sig.packets && sig.packets[0];
      const created = pack && pack.created instanceof Date ? pack.created : null;
      const createdIso = created ? created.toISOString().replace("T", " ").replace(/\.\d+Z$/, "") : "2026-01-01 00:00:00";
      // VALIDSIG 的第 3 项是签名时间（UTC，秒级）+ 时区。git 用它填 %GS / %GG 一类的字段。
      const packHashAlg = pack && Number.isInteger(pack.hashAlgorithm) ? pack.hashAlgorithm : 8;
      const packPubAlg = pack && Number.isInteger(pack.publicKeyAlgorithm) ? pack.publicKeyAlgorithm : 22;
      status("NEWSIG");
      status("GOODSIG " + keyId + " " + uid);
      status(
        "VALIDSIG " + fpr + " " + createdIso + " 0 0 " + packPubAlg + " " + packHashAlg + " 00 " + fpr,
      );
      // TRUST_ULTIMATE：走到这里意味着签名者就是本机这把、且私钥就在本机。
      // GnuPG 对自用密钥（私钥在环里）也报 ultimate，缺这行 git 判不出来，“%G?”落到
      // U（good, unknown validity）而不是 G——`log --show-signature` 于是显示
      // “Good signature”却带个“未验证信任”的尾巴，与真实 gpg 的行为不符。
      // 只影响自签：别人的签名在上面 signerIds 不匹配时已经 ERRSIG/NO_PUBKEY 返回。
      status("TRUST_ULTIMATE 0 pgp");
      // 可读文本（走 stderr，git 原样转发）：不写这几行，`--show-signature` 在验签
      // 成功时反而什么都不显示——只有状态行、没有人的语言。
      const algName = packPubAlg === 22 ? "EDDSA" : String(packPubAlg);
      process.stderr.write("gpg: Signature made " + createdIso + " UTC\n");
      process.stderr.write("gpg:                using " + algName + " key " + fpr + "\n");
      process.stderr.write('gpg: Good signature from "' + uid + '" [ultimate]\n');
      process.exit(0);
    } catch {
      status("BADSIG " + keyId + " " + uid);
      process.stderr.write('gpg: BAD signature from "' + uid + '"\n');
      die("签名验证不通过（Signed digest did not match）。", 1);
    }
  }

  // 签名：payload 走 stdin（**原始字节**），armored detached 签名到 stdout。
  // 不用文本模式：`createMessage({ text })` 会按 UTF-8 解码、且以文本签名（类型 0x01）
  // 规范化行尾——git 与 GitHub 期望的是对提交对象的**精确字节**签名。
  //
  // 先核对 git 指定的签名密钥：`user.signingKey` 指向另一把时，git 以为签出来的是那把，
  // 实际却由本机唯有的这把签——身份与用户的指定不符。GnuPG 对这个场景也是 FAILURE（§"签名密钥
  // 不符"），所以照它的口径拒掉：发 FAILURE sign 并退 2，而不是默默签完。
  const selector = parseSigningSelector(argv);
  if (selector && !keyIdentifiers(priv).has(normId(selector))) {
    status("FAILURE sign 17");
    die(
      "git 指定的签名密钥（" + selector + "）不是本机密钥（" + fpr + "，keyID " + keyId + "）：拒绝用别的身份签名。",
      2,
    );
  }
  let payload = Buffer.alloc(0);
  try {
    payload = fs.readFileSync(0);
  } catch {
    /* 空 payload */
  }
  let sig;
  try {
    sig = await openpgp.sign({
      message: await openpgp.createMessage({ binary: payload }),
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
