// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/deploy.mjs — 把源码部署到宿主加载位。
 *
 * 源码真身：<repo>（本项目）
 * 宿主加载位：<HANA_HOME>/apps/<manifest.id>（HANA_HOME 默认 E:\Hanako\.hanako，可用环境变量覆盖）
 *
 * 只做「镜像」：robocopy /MIR，排除 node_modules 与 .git。首次部署后需在宿主里批准该 App；
 * 之后的改动走 App 详情页「重新加载」，或再跑一次本脚本。
 *
 * 用法：node scripts/deploy.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
// App id 只有一处真相：manifest.id。宿主加载位是 <HANA_HOME>/apps/<id>/，目录名必须与 id 一致，
// 所以从这里读，而不是在脚本里再写一份字面量（改 id 时不会漏掉这一处）。
const appId = JSON.parse(readFileSync(path.join(appDir, "manifest.json"), "utf8")).id;
if (typeof appId !== "string" || !appId) {
  console.error("[deploy] manifest.json 里读不到 id，无法确定宿主加载位。");
  process.exit(1);
}
const hanaHome = process.env.HANA_HOME || "E:\\Hanako\\.hanako";
const target = path.join(hanaHome, "apps", appId);

console.log(`[deploy] ${appDir}\n     ->  ${target}`);

const args = [appDir, target, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD", "node_modules", ".git"];
const r = spawnSync("robocopy", args, { stdio: "inherit" });
// robocopy 退出码：0-7 都是成功语义（0=无变化，1=有复制，… ）
if (r.status !== null && r.status > 7) {
  console.error(`[deploy] robocopy 失败，退出码 ${r.status}`);
  process.exit(r.status);
}
console.log("[deploy] 完成。若首次部署，请在宿主里批准该 App；否则在 App 详情页点「重新加载」。");
