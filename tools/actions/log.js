// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * log：最近提交速览（只读面 action）。
 *
 * 输出最近 N 条提交（默认 10，1~100）：短 hash、作者名、相对时间、首行。
 * 空仓库（无 HEAD / 尚无提交）返回「暂无提交」不报错。纯读。
 *
 * 实现：git log --pretty=format 定制格式 "%h\t%an\t%ar\t%s"，每条记录占一行、
 * 字段以 TAB 分层——%s（首行主题）不可能含换行（git 提交信息首行以换行结束），
 * 因此换行分层天然防分隔符混淆。
 */
import { z } from "zod";
import { runCli, checkCwd } from "../lib/exec.js";
import * as params from "../lib/params.js";

export const command = "log";
export const summary = "最近提交速览";

export const schema = {
  cwd: params.cwd,
  // 范围只写在描述里、不写成 min/max：越界在本 action 是**收敛到边界**（见 run()），不是拒绝——
  // 收敛是既有行为，收紧成拒绝会改语义（见 spec tool-surface 的 Boundary Conditions）。
  n: z.number().int().optional().describe("返回条数：默认 10，范围 1~100，越界自动收敛到边界"),
};

/** 模型面专属（不参与运行期校验）：把范围与默认值写进参数摘要；运行期越界是收敛而不是拒绝。 */
export const modelFields = {
  n: z.number().int().min(1).max(100).default(10).describe("返回条数：默认 10，范围 1~100，越界自动收敛到边界"),
};

export async function run(input, ctx, { label }) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return label + " 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();

  // n 归一：默认 10，1~100 收敛（形状由 schema 保证，越界在这里收敛而不是拒绝）
  let n = 10;
  if (input?.n !== undefined && input?.n !== null) {
    n = Math.min(100, Math.max(1, Math.floor(input.n)));
  }

  const r = await runCli(
    "git",
    ["log", "-n", String(n), "--pretty=format:%h%x09%an%x09%ar%x09%s"],
    { cwd },
  );
  if (!r.ok) {
    const raw = (r.stderr || r.stdout || "").trim();
    // 空仓库（分支尚无任何提交）→ 按规范返回「暂无提交」，不当作错误
    if (/does not have any commits yet|your current branch.*does not have any commits|fatal: bad default revision/i.test(raw)) {
      return label + "：" + cwd + " 仓库暂无提交（该分支尚无 commit，HEAD 不存在）。";
    }
    if (/not a git repository|does not appear to be a git repository|not our repo/i.test(raw)) {
      return label + "：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
    }
    return label + " 执行失败：\n" + (r.message || raw || "未知错误");
  }

  const text = r.stdout || "";
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  if (lines.length === 0) {
    return label + "：" + cwd + " 仓库暂无提交（该分支尚无 commit）。";
  }

  const out = ["最近 " + lines.length + " 条提交（" + cwd + "）："];
  lines.forEach((l, i) => {
    // 字段：hash / author / relative / subject（%s 不含换行，TAB 分层解析）
    const idx1 = l.indexOf("\t");
    const idx2 = idx1 === -1 ? -1 : l.indexOf("\t", idx1 + 1);
    const idx3 = idx2 === -1 ? -1 : l.indexOf("\t", idx2 + 1);
    if (idx3 === -1) {
      out.push((i + 1) + ". " + l);
      return;
    }
    const hash = l.slice(0, idx1);
    const author = l.slice(idx1 + 1, idx2);
    const when = l.slice(idx2 + 1, idx3);
    const subject = l.slice(idx3 + 1);
    out.push((i + 1) + ". " + hash + "  " + author + "  " + when + "  " + subject);
  });
  return out.join("\n");
}
