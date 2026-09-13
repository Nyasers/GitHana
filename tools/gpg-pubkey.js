// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * gpg_pubkey：读当前活动 GPG 签名公钥（给 Agent 用的数据工具，不出界面）。
 *
 * 背景：gpg_keygen 每次生成/轮换后把新公钥落盘为 <dataDir>/github-toolkit-gpg-pubkey.asc
 * （固定名，恒为当前活动密钥）。本工具只返回**数据**：指纹、UID、公钥全文与文件路径。
 *
 * 界面在哪：公钥的查看/复制只有一处 —— 设置页「隔离 GPG 签名身份」区块（查看公钥 / 复制公钥）。
 * 早先本工具还会返回 details.card 在会话流里挂一张公钥复制卡，现已撤掉：同一件事维护两个界面
 * 不划算，且那条卡路由带 ?ts= 查询串，与当前宿主的卡路由校验（禁止 query）相抵。
 *
 * 公钥非敏感（本来就要公开上传），进入会话流无泄露风险；私钥永不触碰。
 * 只读 App 自有数据目录（公钥文件 + 隔离 gitconfig），无任何外部副作用。
 */
import { initToolContext, getToolDataDir } from "./lib/context.js";
import { collectPubkeyData } from "../lib/routes/pubkey.js";

export const name = "gpg_pubkey";

export const description = [
  "读 GitHana（githana）当前活动的 GPG 签名公钥，返回数据（不出界面）：完整指纹、UID（隔离 gitconfig 的 user 身份）、公钥全文与落盘路径。",
  "公钥文件不存在（尚未运行 gpg_keygen）时返回可读提示，引导先运行 gpg_keygen；本工具无参数、只读、无副作用。",
  "用户侧的「查看公钥 / 复制公钥」在设置页「隔离 GPG 签名身份」区块（本工具不再返回流内卡）。",
  "常见用途：把公钥转述给用户贴到 GitHub（Settings → SSH and GPG keys → New GPG key）、轮换后核对指纹、排查签名未 verified。",
].join(" ");

export const sessionPermission = { kind: "plugin_output" };

export const parameters = { type: "object", properties: {} };

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const dataDir = getToolDataDir();
  if (!dataDir) {
    return "gpg_pubkey：无法定位插件数据目录（ctx.dataDir 缺失）。";
  }

  const pub = collectPubkeyData(dataDir);
  if (!pub.hasKey) {
    return (
      "尚未生成密钥（未找到 " + dataDir + " 下的公钥文件），先运行 gpg_keygen。\n" +
      "生成/轮换完成后再次调用本工具即可读到新公钥。"
    );
  }

  const lines = [
    "公钥已就绪" + (pub.fpr ? "（fpr " + pub.fpr + "）" : "") + "。",
    pub.uid ? "UID：" + pub.uid : "",
    "文件：" + dataDir + "/github-toolkit-gpg-pubkey.asc",
    "",
    "把下面这段贴到 GitHub（Settings → SSH and GPG keys → New GPG key）；",
    "用户也可以到设置页「隔离 GPG 签名身份」区块点「复制公钥」直接复制。",
    "",
    pub.pubkey,
  ].filter((l) => l !== "");
  return lines.join("\n");
}
