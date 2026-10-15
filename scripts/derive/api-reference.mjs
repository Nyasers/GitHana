// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/api-reference.mjs — `githana_api` 裸调参考（每一分类一份 SKILL 引用件）
//
// ## 为什么有这条任务
//
// `githana_api` 是逃生门：类型化动词覆盖不到的长尾能力都从它走。但它**没有自己的参数面**——
// 调用方得先知道「这个动作打哪个端点、要哪个权限」。此前这些只散在 SKILL.md 的缺口登记里，
// 遇到没登记过的动作就只能靠猜。
//
// 参考件的作用是**把「能用的端点」摊开**，按需读取：一个分类一份，每份都能一次读完。
//
// ## 为什么按权限筛，而不是把 GitHub 全量端点评进来
//
// 本 App 的权限集是固定的九项（spec D7 实测）。**没声明的权限，走 api 也会 403**，
// 所以那些端点进文档只是噪声——它会把「能做什么」和「注定失败」混在一起。
//
// 筛选依据取自 GitHub 官方那份**按权限索引端点**的数据
// （`github/docs` 的 `src/github-apps/data/<version>/server-to-server-permissions.json`）：
// 它的自述就是「for each permission granted, these are the REST API endpoints that the app
// can use」，正是「持有该权限 ⇒ 这些端点可用」的充分语义。一份表即可定论，
// 不必去猜 GitHub 的 OR/AND 语义（同一端点出现在多个权限下即任一满足）。
//
// `additional-permissions` 的处理：官方说明它表示「该端点需要不止一个权限，或一组权限里任一
// 即可」（两种都标 true）。所以判定取保守读法——命中的权限里只要有一条 `addl=false`，
// 该端点单权限即够；否则要求该端点所列权限**全部**在手。两种读法实测只差 4 个端点
// （fork / create-repo 这类还要 administration 的），保守读法把它们挡在外面是对的。
//
// ## 产物语言
//
// 英文。这些文件的读者是模型/Agent（配合 `skills/githana/SKILL.md`），与手册同口径。
//
// ## 数据源与缓存
//
// 上游表与缓存位置声明在 `api-source.mjs`（与拉取脚本共用一份，避免两处各写一遍 URL 与
// 版本段）。本任务**只读缓存**：网络拉取由 `fetch-permission-table.mjs` 负责，两件事分开。
// 缓存缺失时明确报错并指出该跑哪条命令，不自己偷偷联网、也不产出半份。
import fs from "node:fs";
import path from "node:path";
import { at } from "../shared/root.mjs";
import { API_VERSION, SOURCE, CACHE_FILE } from "./api-source.mjs";

/** 参考件落点（随包，App 根目录约定下由宿主读 skills/）。 */
const OUT_DIR = "skills/githana/references";

/**
 * 本 App 已授权的权限（GitHub App 的权限名，小写下划线形式）。
 * 这是**人维护的事实**：改 App 权限后要同步这里（spec D7 是它的书面出处）。
 */
const GRANTED = [
  "actions",
  "checks",
  "contents",
  "gpg_keys",
  "issues",
  "metadata",
  "pull_requests",
  "repository_creation",
  "workflows",
];

/** 工具面已封装的端点族 → 该用哪个动词。命中即在文档里标注「优先用工具」。 */
const WRAPPED = [
  [["repos", "*", "*", "pulls"], "githana_pr"],
  [["repos", "*", "*", "issues"], "githana_issue"],
  [["repos", "*", "*", "labels"], "githana_label"],
  [["repos", "*", "*", "releases"], "githana_release"],
  [["repos", "*", "*", "actions", "caches"], "githana_cache"],
  [["repos", "*", "*", "actions", "runs"], "githana_run"],
  [["repos", "*", "*", "actions", "workflows"], "githana_workflow"],
  [["repos", "*", "*", "actions", "artifacts"], "githana_run"],
  [["repos", "*", "*", "check-runs"], "githana_pr"],
  [["repos", "*", "*", "check-suites"], "githana_pr"],
  [["repos", "*", "*", "contents"], "githana_repo"],
  [["repos", "*", "*", "gitignore"], "githana_repo"],
  [["repos", "*", "*", "forks"], "githana_repo"],
  [["licenses"], "githana_repo"],
  [["user", "repos"], "githana_repo"],
  [["users", "*", "repos"], "githana_repo"],
  [["user", "gpg_keys"], "settings page"],
];

const segsOf = (p) => p.split("/").filter(Boolean);
/** 前缀匹配：`*` 匹配一个 `{...}` 变量段。 */
function prefixHits(pre, segs) {
  if (pre.length > segs.length) return false;
  for (let i = 0; i < pre.length; i += 1) {
    if (pre[i] === "*") {
      if (!segs[i].startsWith("{")) return false;
      continue;
    }
    if (pre[i] !== segs[i]) return false;
  }
  return true;
}
const wrappedBy = (p) => {
  const segs = segsOf(p);
  for (const [pre, name] of WRAPPED) if (prefixHits(pre, segs)) return name;
  return null;
};

/** 把端点表规范化成 `Map<"VERB /path", {verb,path,hits:Map<perm,{uat,addl,cat,sub,access}>}>`。 */
function indexEndpoints(table) {
  const byEp = new Map();
  for (const perm of Object.keys(table)) {
    const entries = (table[perm] && table[perm].permissions) || [];
    for (const e of entries) {
      if (!e || !e.requestPath || !e.verb) continue;
      const key = `${e.verb.toUpperCase()} ${e.requestPath}`;
      if (!byEp.has(key)) byEp.set(key, { verb: e.verb.toUpperCase(), path: e.requestPath, hits: new Map() });
      const rec = byEp.get(key);
      const next = {
        uat: e["user-to-server"] === true,
        addl: e["additional-permissions"] === true,
        acc: e.access || "",
        cat: e.category || "uncategorized",
        sub: e.subcategory || "uncategorized",
      };
      const prev = rec.hits.get(perm);
      // 同一 (端点, 权限) 可能多条：保留对判定最有利的一条（addl=false 优先）。
      if (!prev || (prev.addl && !next.addl)) rec.hits.set(perm, next);
    }
  }
  return byEp;
}

/**
 * 判定某端点是否落在权限面内。
 * 返回 null 表示面外；否则返回 `{via, cat, sub, acc}`（via = 支撑它的已授权权限）。
 */
function surfaceOf(rec) {
  const granted = [...rec.hits.entries()].filter(([perm, v]) => GRANTED.includes(perm) && v.uat);
  if (!granted.length) return null;
  // addl=false 的任一命中即单权限够用。
  const simple = granted.find(([, v]) => !v.addl);
  if (simple) return { via: [simple[0]], cat: simple[1].cat, sub: simple[1].sub, acc: simple[1].acc };
  // 否则要求该端点所列的 UAT 权限全部在手（保守读法）。
  const allUat = [...rec.hits.entries()].filter(([, v]) => v.uat);
  const complete = allUat.every(([perm]) => GRANTED.includes(perm));
  if (!complete) return null;
  return { via: granted.map(([perm]) => perm), cat: granted[0][1].cat, sub: granted[0][1].sub, acc: granted[0][1].acc };
}

const titleCase = (s) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** 渲染一份分类文件。 */
function renderCategory(cat, rows) {
  const L = [];
  L.push(`# \`githana_api\` — ${cat}`);
  L.push("");
  L.push(`${rows.length} endpoint${rows.length === 1 ? "" : "s"} reachable with this App's permission set.`);
  L.push("Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.");
  L.push("");
  L.push("| Endpoint | Permission | Action | Notes |");
  L.push("|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb))) {
    const perm = r.via.join(" or ");
    const w = wrappedBy(r.path);
    L.push(`| \`${r.verb} ${r.path}\` | ${perm} | ${r.acc} | ${w ? `prefer \`${w}\`` : ""} |`);
  }
  L.push("");
  return L.join("\n");
}

/** 索引：一行一个分类，含端点计数与文件名。 */
function renderIndex(cats) {
  const L = [];
  L.push("# `githana_api` — endpoint reference");
  L.push("");
  L.push("Endpoints this App can actually call through `githana_api`, grouped by category.");
  L.push("Filtered by the App's permission set: anything needing an undeclared permission is");
  L.push("left out, because `api` cannot reach it either (GitHub answers 403).");
  L.push("");
  L.push("Read one category file when you need it — each is small enough to read in one go.");
  L.push("");
  L.push("| Category | Endpoints | File |");
  L.push("|---|---|---|");
  for (const [cat, rows] of cats) L.push(`| \`${cat}\` | ${rows.length} | [\`${cat}.md\`](${cat}.md) |`);
  L.push("");
  return L.join("\n");
}

/**
 * 任务：api-reference —— 上游权限表（缓存）+ 本 App 权限集 → `skills/githana/references/*.md`。
 *
 * 只读缓存；缓存由 `fetch-permission-table.mjs` 拉取（见文件头）。
 */
export const apiReferenceTask = {
  name: "api-reference",
  about: `permission table (${API_VERSION}) + granted set → ${OUT_DIR}/*.md`,
  plan: () => {
    const cacheFile = at(CACHE_FILE);
    if (!fs.existsSync(cacheFile)) {
      throw new Error(
        `缺权限表缓存：${CACHE_FILE}\n` +
          `  先跑一次联网获取：node scripts/derive/fetch-permission-table.mjs`,
      );
    }
    const table = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const byEp = indexEndpoints(table);

    const cats = new Map();
    let inSurface = 0;
    for (const rec of byEp.values()) {
      const s = surfaceOf(rec);
      if (!s) continue;
      inSurface += 1;
      const cat = s.cat;
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat).push({ verb: rec.verb, path: rec.path, via: s.via, acc: s.acc });
    }
    if (!inSurface) throw new Error("权限面内端点为 0——权限集或上游表形状变了，先核对再生成");

    // 稳定排序，避免 Map 迭代顺序影响产物
    const ordered = [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const files = [{ rel: path.posix.join(OUT_DIR, "INDEX.md"), content: renderIndex(ordered) }];
    for (const [cat, rows] of ordered) {
      files.push({ rel: path.posix.join(OUT_DIR, `${cat}.md`), content: renderCategory(cat, rows) });
    }
    return files;
  },
};

export { GRANTED, OUT_DIR };
