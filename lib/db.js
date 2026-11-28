// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/db.js — GitHana 的本地数据文件（<dataDir>/data.db，SQLite）。
 *
 * 一张表装全部本地状态：
 *   store(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
 *
 * value 存 **JSON 文本**，updated_at 存 **ISO 8601 文本**（`2026-11-28T02:37:01.339Z`）。
 * 读写频率极低（启动读一次凭据、设置页偶尔写一次），jsonb 的二进制体积与解析优势用不上，
 * 时间戳同理：可读、可 diff、能用 SQLite 的 `datetime()` 直接算，比一串毫秒数有用。
 *
 * 现有的两条记录：
 *   credential   OAuth 凭据（DPAPI 密文 + 账号摘要）
 *   commit       提交署名（通道 + 共同署名集合）
 *
 * 不进库的东西：gitconfig、gpg.key.json、gpg.key.pub.asc —— git 与 gpg shim 按路径直读，
 * 必须是文件；临时产物（.runtime-tmp、verify 之类）也不进。
 *
 * node:sqlite 随宿主运行时提供（Node 26）；打不开时 openDb 返回 null，读路径按「没有记录」
 * 处理，写路径抛错——不静默降级成明文文件。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_FILE = "data.db";

/** dataDir → DatabaseSync | null（打开失败缓存 null，避免每次调用都重试） */
const connections = new Map();

export function dbFilePath(dataDir) {
  return path.join(dataDir || "", DB_FILE);
}

function openDb(dataDir) {
  const dir = dataDir || "";
  if (!dir) return null;
  if (connections.has(dir)) return connections.get(dir);

  let db = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(dbFilePath(dir));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS store (" +
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    // 署名偏好：主键就是身份，用途摊在各列上。三个「单选」列由写入端保证恰好一行
    // 为 1；agent 只能做共同作者，用 CHECK 直接卡住。
    db.exec(
      "CREATE TABLE IF NOT EXISTS author (" +
        "author TEXT PRIMARY KEY CHECK (author IN ('user','app','agent'))," +
        "commit_author INTEGER NOT NULL DEFAULT 0 CHECK (commit_author IN (0,1)) CHECK (author != 'agent' OR commit_author = 0)," +
        "coa INTEGER NOT NULL DEFAULT 0 CHECK (coa IN (0,1))," +
        "comment INTEGER NOT NULL DEFAULT 0 CHECK (comment IN (0,1)) CHECK (author != 'agent' OR comment = 0)," +
        "pr INTEGER NOT NULL DEFAULT 0 CHECK (pr IN (0,1)) CHECK (author != 'agent' OR pr = 0))",
    );
  } catch {
    // 打开失败不缓存：可能是瞬时（文件锁、权限），下一次调用应该重试。
    return null;
  }
  connections.set(dir, db);
  return db;
}

/**
 * 读一条记录。
 * @returns {object|null} 解析后的对象；没有记录 / 打不开 / 内容不是对象 → null
 */
export function getRecord(dataDir, key) {
  const db = openDb(dataDir);
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM store WHERE key = ?").get(String(key));
    if (!row) return null;
    const value = JSON.parse(String(row.value));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 写一条记录（覆盖）。写不进去直接抛错：凭据这类数据不能悄悄丢。
 */
export function setRecord(dataDir, key, value) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so nothing was saved.");
  db.prepare(
    "INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(String(key), JSON.stringify(value), new Date().toISOString());
}

/** 删一条记录（不存在则忽略）。删除失败要报出来：凭据没删掉就不能当已登出。 */
export function deleteRecord(dataDir, key) {
  const db = openDb(dataDir);
  // 库打不开等同于「删不掉」：不能因为读不到就宣称已经删了。
  if (!db) throw new Error("the local data.db could not be opened, so the record was not deleted.");
  db.prepare("DELETE FROM store WHERE key = ?").run(String(key));
}

/** 读 author 表全部行（空数组 = 还没写过）。 */
export function readAuthorRows(dataDir) {
  const db = openDb(dataDir);
  if (!db) return [];
  return db.prepare("SELECT author, commit_author, coa, comment, pr FROM author").all();
}

/** 在一个事务里写 author 表（整表覆盖）。 */
export function writeAuthorRows(dataDir, rows) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so nothing was saved.");
  const up = db.prepare(
    "INSERT INTO author (author, commit_author, coa, comment, pr) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(author) DO UPDATE SET commit_author = excluded.commit_author, coa = excluded.coa, " +
      "comment = excluded.comment, pr = excluded.pr",
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      up.run(String(r.author), r.commit_author ? 1 : 0, r.coa ? 1 : 0, r.comment ? 1 : 0, r.pr ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已经结束 */
    }
    throw e;
  }
}

/** 关闭所有连接（卸载 / 重载时调用；Windows 上不关会占着 data.db 不让删）。 */
export function closeDatabases() {
  for (const [dir, db] of connections) {
    try {
      if (db) db.close();
    } catch {
      /* 已经关了 */
    }
    connections.delete(dir);
  }
}
