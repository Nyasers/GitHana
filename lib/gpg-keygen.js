// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/gpg-keygen.js — 隔离签名身份的实现：初始化隔离 git 身份 + 生成/轮换签名密钥。
 *
 * 调用方只有设置页的「生成 / 轮换密钥」动作（lib/routes/actions.js）。密钥的生成与公钥查看
 * 都不在 Agent 工具面：生成不可逆（轮换会让 GitHub 上已上传的旧公钥立即失效），要用户点按钮
 * 二次确认；公钥的查看与复制也只在设置页。
 *
 * 放在 lib/ 而不是 tools/：`tools/<name>.js` 这个位置在本仓表示「一个工具入口」（宿主按
 * `apply` 里的注册拿到它们，见 app.js），而本文件不是工具、也不该被误认作工具。它的同类
 * （gpg-publish / oauth / openpgp-key / secret / dpapi）都在 lib/ 下。
 *
 * 为什么不把这段塞进路由：密钥生成、指纹提取、gitconfig 写入都在本地完成，报告与公钥可展示，
 * 私钥材料不进对话。路由只负责鉴权与传参，实现留在这里（export execute({ name?, email? }, ctx)）。
 *
 * ## 实现（OpenPGP.js，不再是 gpg 二进制）
 *
 * 1. 提交者身份：完全由已登录账号推导，不接受参数覆盖——邮箱用 GitHub noreply 格式
 *    （GET /user → {id}+{login}@users.noreply.github.com），名字走三级链（user.name →
 *    login）；身份写入隔离 gitconfig（<dataDir>/gitconfig，经 GIT_CONFIG_GLOBAL 生效）。
 *    推导失败（未登录 / 请求失败）→ 中止并提示先完成登录，不生成不删除不写身份。
 * 2. 签名密钥：由 lib/openpgp-key.js 生成 ed25519（UID name+email），私钥经 DPAPI 加密落
 *    <dataDir>/gpg.key.json，公钥明文落 <dataDir>/gpg.key.pub.asc。
 *    首次执行 = 生成；重复执行 = 轮换（**直接覆盖**：旧密钥由新记录取代，不像 gpg 环那样
 *    需要先删后建——没有 keyring 的 UID 冲突问题）。
 * 3. 签名接线：指纹写入隔离 gitconfig（user.signingkey + commit.gpgsign=true）。
 *    gpg.program **不写文件**：每次 spawn 由 buildBinEnv 现算注入，指向随包的签名 shim
 *    （tools/lib/gpg.shim.mjs，经 tools/lib/sign-shim.js 的包装脚本）。**不再有 GNUPGHOME**
 *    ——gpg 二进制不在包里了，那套隔离机制（gpgconf.ctl、agent 收尾）随之消失。
 * 4. 生成与上传是一个动作（不可分割）：先快照本地密钥与签名接线，再生成并接线，最后上传。
 *    上传失败就把本地**整体退回生成前状态**（密钥文件、公钥文件、签名接线全回去）——
 *    本地不该留一把 GitHub 上没有的密钥（那就是把“本地有密钥”与“账号上有公钥”拆成了两件事）。
 *    轮换时这个回滚同样成立：新钥上传失败就继续用旧钥，而不是把旧的先删掉。
 *    上传环节自己保证**只删本 App 上传过的那把**（逐条核对指纹，见 lib/gpg-publish.js）。
 *
 * email 语义：密钥 UID 邮箱必须等于提交作者邮箱（令牌推导的 noreply 邮箱）才能被 GitHub
 * 验证为 verified——生成密钥强制用该邮箱，不另设参数。
 *
 * 权限：plugin_output（只写插件自有 dataDir，无外部副作用）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  deriveNameFromUser,
  noreplyEmailFromUser,
} from "../tools/lib/identity.js";
import { runCli } from "../tools/lib/exec.js";
import { callRest, errorDetail } from "../tools/lib/rest.js";
import { initToolContext, getToolDataDir, getToolSecretToken } from "../tools/lib/context.js";
import {
  generateSigningKey,
  saveKey,
  keyInfo,
  keyFilePath,
  pubkeyFilePath,
  snapshotKeyFiles,
  restoreKeyFiles,
} from "./openpgp-key.js";
import { publishKey } from "./gpg-publish.js";

/** 读隔离 gitconfig 里的一个键（缺省/未设为 ""）。走 git 本身，引号与转义都由它处理。 */
async function readGitConfig(key) {
  const r = await runCli("git", ["config", "--global", "--get", key], {});
  return r.ok ? String(r.stdout || "").trim() : "";
}

/**
 * 把签名接线恢复到快照前。`--unset` 不存在的键会退非零，这里不看结果：
 * 幂等语义是「恢复到没有该键」，unset 失败通常就是本来就没有。
 */
async function restoreGitSigning(snap) {
  const set = async (key, value) => {
    if (value) await runCli("git", ["config", "--global", key, value], {});
    else await runCli("git", ["config", "--global", "--unset", key], {});
  };
  await set("user.signingkey", snap.signingkey);
  await set("commit.gpgsign", snap.gpgsign);
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  return runKeygen();
}

/**
 * 主体实现（身份解析 → gitconfig 写入 → 密钥生成/轮换 → 签名接线 → 公钥发布）。
 * 各分支直接 return 报告文本。
 */
async function runKeygen() {
  const dataDir = getToolDataDir();
  if (!dataDir) {
    return "密钥生成：无法定位插件数据目录（ctx.dataDir 缺失），无法初始化隔离配置。";
  }
  fs.mkdirSync(dataDir, { recursive: true });

  const lines = [];
  const cfgPath = path.join(dataDir, "gitconfig");

  // —— 0. 提交者身份解析（email/name）——
  // 身份完全由已登录账号推导，没有覆盖入口：邮箱用 GitHub noreply 格式，名字走
  // user.name → login。推导失败（未登录 / 请求失败 / 解析失败）→ 中止并报错区分原因。
  let email = "";
  let name = "";
  let login = "";
  let userId = null;
  {
    const token = String(getToolSecretToken() || "").trim();
    if (!token) {
      return (
        "密钥生成：尚未完成 GitHub App 授权（进程内没有 OAuth 令牌）。提交者身份依赖令牌自动推导" +
        "（GET /user → noreply 邮箱 {id}+{login}@users.noreply.github.com）。\n" +
        "请到设置页点「用 GitHub 登录」完成授权后重跑。本次未生成/删除任何密钥、未写身份。"
      );
    }
    const userR = await callRest([{ url: "https://api.github.com/user", timeoutMs: 30_000 }], { timeoutSec: 30 });
    const userRes = userR.ok ? userR.results[0] : null;
    if (!userRes || !userRes.ok) {
      return (
        "密钥生成：令牌自动推导提交者身份失败——GET /user 调用失败：" +
        ((userRes && errorDetail(userRes)) || userR.message || "未知错误") + "\n" +
        "请确认授权有效（该端点不需要任何额外权限）。本次未生成/删除任何密钥、未写身份。"
      );
    }
    const user = userRes.json;
    const id = user && user.id;
    login = user && user.login ? String(user.login).trim() : "";
    if (id === undefined || id === null || id === "" || !login) {
      return (
        "密钥生成：令牌自动推导提交者身份失败——GET /user 响应解析失败" +
        "（未取得 {id, login}；原始输出前 200 字符：" + String(userRes.text || "").slice(0, 200) + "）。\n" +
        "请检查授权与网络后重试。本次未生成/删除任何密钥、未写身份。"
      );
    }
    userId = id;
    email = noreplyEmailFromUser(id, login);
    name = deriveNameFromUser(user);
  }

  // —— 1. git 身份写入隔离 gitconfig ——
  {
    const setEmail = await runCli("git", ["config", "--global", "user.email", email], {});
    let ok = setEmail.ok;
    if (name) {
      const setName = await runCli("git", ["config", "--global", "user.name", name], {});
      ok = ok && setName.ok;
    }
    if (ok) {
      lines.push("git 身份已写入隔离配置：" + (name ? name + " <" + email + ">" : "<仅邮箱> " + email));
      lines.push("  配置： " + cfgPath);
    } else {
      lines.push("git 身份写入失败：" + (setEmail.message || "未知错误"));
    }
  }

  // —— 2. 生成 / 轮换签名密钥 ——
  // 先快照密钥文件与签名接线：生成+上传是一个动作，上传不成就整体退回这里。
  const snapFiles = snapshotKeyFiles(dataDir);
  const snapSigning = {
    signingkey: await readGitConfig("user.signingkey"),
    gpgsign: await readGitConfig("commit.gpgsign"),
  };

  const before = keyInfo(dataDir);
  if (before.hasKey) {
    lines.push(
      "轮换替换：已有签名密钥（" + (before.fingerprint || "?") + "），生成新密钥并取代它…",
    );
  } else {
    lines.push("首次生成：生成 ed25519 签名密钥（UID=" + (name || email) + " <" + email + ">）…");
  }

  let gen;
  try {
    gen = await generateSigningKey({ name, email });
  } catch (e) {
    lines.push("签名密钥生成失败（未改动任何既有密钥）：" + String((e && e.message) || e));
    return lines.join("\n");
  }

  let saved;
  try {
    saved = await saveKey({ dataDir, ...gen, email });
  } catch (e) {
    lines.push("签名密钥保存失败：" + String((e && e.message) || e));
    return lines.join("\n");
  }

  lines.push("签名密钥已生成，指纹：" + saved.fingerprint);
  lines.push("  私钥（DPAPI 加密）：" + keyFilePath(dataDir));
  lines.push("  公钥： " + pubkeyFilePath(dataDir));
  if (before.hasKey && before.fingerprint && before.fingerprint !== saved.fingerprint) {
    lines.push("旧密钥已由新记录取代：" + before.fingerprint + " → " + saved.fingerprint +
      "；若旧公钥已贴 GitHub，发布环节会替换它。");
  }

  // —— 3. 签名接线（指纹写入隔离 gitconfig；gpg.program 由运行时注入，见文件头注）——
  {
    const s1 = await runCli("git", ["config", "--global", "user.signingkey", saved.fingerprint], {});
    const s2 = await runCli("git", ["config", "--global", "commit.gpgsign", "true"], {});
    lines.push(
      "签名已接线（user.signingkey + commit.gpgsign=true；gpg.program 由运行时按当前安装注入，" +
      "不写进配置文件）：此后 githana_git(action=\"commit\") 自动签名，签名由随包的签名 shim（纯 JS）完成。" +
      (s1.ok && s2.ok ? "" : "（配置写入异常：" + ([s1.message, s2.message].filter(Boolean).join("；") || "?") + "）"),
    );
  }

  // —— 4. 上传公钥（与生成同属一个动作）——
  // 上传不成就整体退回：密钥文件回快照、签名接线回原值。轮换时也一样——新钥传不上去
  // 就继续用旧钥，而不是把旧的先删掉、留一个没有对应公钥的本地密钥。
  const armored = gen.publicKeyArmored;
  const pubResult = await publishKey({
    dataDir,
    pubkeyArmored: armored,
    fingerprint: saved.fingerprint,
    login,
    id: userId,
  });
  if (!pubResult.ok) {
    restoreKeyFiles(dataDir, snapFiles);
    await restoreGitSigning(snapSigning);
    lines.push("");
    lines.push("GitHub 公钥发布未完成，已回退本次生成（本地密钥与签名接线回到操作前）：");
    lines.push("  " + pubResult.message);
    lines.push(
      before.hasKey
        ? "  仍在使用原有密钥：" + (before.fingerprint || "?") + "。请处理上述原因后重试。"
        : "  当前没有签名密钥。请处理上述原因后重试；需要先登录 GitHub 账号。",
    );
    return lines.join("\n");
  }

  lines.push("");
  lines.push("GitHub 公钥发布：成功");
  lines.push("  " + pubResult.message);

  lines.push("");
  lines.push("初始化完成。已生成隔离 git 配置：githana 的 git 动作均不读用户 ~/.gitconfig。");
  return lines.join("\n");
}
