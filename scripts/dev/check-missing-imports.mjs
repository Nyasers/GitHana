// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * 扫一遍 tools/ 下的 .js，找出「用了某个共享 helper 但从没 import 过」的地方。
 *
 * 为什么需要它：`node --check` 只做语法解析，抓不到未定义引用；这类错要等对应分支真的
 * 跑起来才炸（run/download 的 artifacts 分支就漏了 callRest，logs 分支跑通也发现不了）。
 * selfcheck 的语法关守不住这条，所以单独一个能进 CI 的检查。
 *
 * 只认一份「必然来自共享模块」的名单：名字太泛的（baseName / pick / clamp 这种）各文件
 * 可能自己定义，不列进来，免得误报。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(ROOT, "tools");

/** 共享 helper 名单：用了就必须 import（或在本文件里定义）。 */
const HELPERS = [
  "callRest", "apiUrl", "apiRoot", "uploadUrl", "webUrl",
  "resolveContext", "describeFailure", "parseRepo", "defaultBranch",
  "taskCapabilityError", "createSessionTask", "updateTask", "completeTask",
  "failTask", "readTaskRecord", "taskLog", "githanaMetaOf",
  "registerTaskResumer", "resumePendingTasks", "isTerminalTaskStatus",
  "makeRestTransfer", "makeRestUpload", "startTransferTask", "startCommandTask",
  "runCommandTask", "runTransferTask", "resolveTargetPath",
  "normalizeAbsolutePath", "safeFileName", "transferFailureText", "formatBytes",
  "runCli", "checkCwd", "removeTree", "formatCliResult",
  "resolveRunId", "pickedNote",
];

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * 去掉注释（保留字符串字面量）。
 *
 * 查 import 必须用这个版本：`import { a } from "./x.js"` 的模块说明符是个字符串，
 * 若先把它剥掉，`from "` 就永远匹配不上，结果会把所有 import 都判成缺失。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { out += src[i]; i += 1; }
        if (i < n) { out += src[i]; i += 1; }
      }
      if (i < n) { out += src[i]; i += 1; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 再去掉字符串字面量，只留真正的代码（查调用用）。
 *
 * 不做这一步会把字符串里的 `foo()` 当成调用，也会把注释里提到的 `foo()` 算进来
 * （watch.js 的注释就写着 resumePendingTasks()）——那种误报会让人直接把检查器关掉。
 */
function stripStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n && code[i] !== quote) {
        if (code[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      out += " "; // 留下空格，避免两侧 token 粘在一起
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 收集一个文件里所有被 import 绑定的名字（含 `as` 重命名后的本地名）。
 *
 * 逐条 import 语句处理，不用一条跨行大正则：多行 `import { a,\n b } from "…"` 会让
 * 「从第一个 import 到某个 from」的懒匹配吞掉中间所有语句，进而把真实用法判成缺失。
 */
function importedNames(code) {
  const names = new Set();
  const importRe = /import\s+([^;]*?)\s+from\s*["']/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    const clause = m[1].trim();
    // 默认导入：import X from "…" / import X, { a } from "…"
    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defaultMatch && !clause.startsWith("{") && !clause.startsWith("*")) names.add(defaultMatch[1]);
    // 命名导入：{ a, b as c }
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
        names.add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
      }
    }
    // 命名空间导入：* as ns
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) names.add(nsMatch[1]);
  }
  return names;
}

const problems = [];
for (const file of walk(TOOLS, [])) {
  const raw = readFileSync(file, "utf8");
  const noComments = stripComments(raw);
  const code = stripStrings(noComments);
  const imported = importedNames(stripComments(raw));
  for (const h of HELPERS) {
    if (imported.has(h)) continue;
    // 调用形态：h( ——前面不能是 . 或标识符字符（排除 obj.h( 与 xh(）
    const used = new RegExp("(^|[^\\w.$])" + h + "\\s*\\(", "m").test(code);
    if (!used) continue;
    const defined = new RegExp("(?:function|class)\\s+" + h + "\\b|(?:const|let|var)\\s+" + h + "\\s*=").test(code);
    if (!defined) {
      problems.push(relative(ROOT, file).replace(/\\/g, "/") + " uses " + h + "() but never imports or defines it");
    }
  }
}

if (problems.length) {
  console.error("[check-imports] " + problems.length + " problem(s):");
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}
console.log("[check-imports] ok: no undefined shared helpers");
