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
 * 不进库的东西：gitconfig、gpg.key.bin、gpg.key.pub.asc —— git 与 gpg shim 按路径直读，
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
      "CREATE TABLE IF NOT EXISTS settings (" +
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    // 凭据单独一张表：只有一行（id = 1），密文直接存 BLOB，运维时能直接看出
    // 「这是哪一类、什么时候写的」，不必先解析 JSON。
    db.exec(
      "CREATE TABLE IF NOT EXISTS credential (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "kind TEXT NOT NULL," +
        "alg TEXT NOT NULL," +
        "cipher BLOB NOT NULL," +
        "login TEXT," +
        "name TEXT," +
        "expires_at TEXT," +
        "refresh_expires_at TEXT," +
        "needs_reauth INTEGER NOT NULL DEFAULT 0 CHECK (needs_reauth IN (0,1))," +
        "updated_at TEXT NOT NULL)",
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
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(String(key));
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
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(String(key), JSON.stringify(value), new Date().toISOString());
}

/** 删一条记录（不存在则忽略）。删除失败要报出来：凭据没删掉就不能当已登出。 */
export function deleteRecord(dataDir, key) {
  const db = openDb(dataDir);
  // 库打不开等同于「删不掉」：不能因为读不到就宣称已经删了。
  if (!db) throw new Error("the local data.db could not be opened, so the record was not deleted.");
  db.prepare("DELETE FROM settings WHERE key = ?").run(String(key));
}

/** 读凭据行（cipher 保持 BLOB）；没有行 → null。 */
export function readCredentialRow(dataDir) {
  const db = openDb(dataDir);
  if (!db) return null;
  const row = db.prepare("SELECT * FROM credential WHERE id = 1").get();
  if (!row) return null;
  const meta = {};
  if (row.login) meta.login = String(row.login);
  if (row.name) meta.name = String(row.name);
  if (row.expires_at) meta.expiresAt = String(row.expires_at);
  if (row.refresh_expires_at) meta.refreshExpiresAt = String(row.refresh_expires_at);
  if (Number(row.needs_reauth) === 1) meta.needsReauth = true;
  return {
    kind: String(row.kind),
    alg: String(row.alg),
    cipher: Buffer.isBuffer(row.cipher) ? row.cipher : Buffer.from(row.cipher || []),
    meta,
    updatedAt: String(row.updated_at || ""),
  };
}

/** 写凭据行（整行覆盖）。cipher 必须是 Buffer。 */
export function writeCredentialRow(dataDir, { kind, alg, cipher, meta }) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so nothing was saved.");
  const m = meta && typeof meta === "object" ? meta : {};
  db.prepare(
    "INSERT INTO credential (id, kind, alg, cipher, login, name, expires_at, refresh_expires_at, needs_reauth, updated_at) " +
      "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, alg = excluded.alg, cipher = excluded.cipher, " +
      "login = excluded.login, name = excluded.name, expires_at = excluded.expires_at, " +
      "refresh_expires_at = excluded.refresh_expires_at, needs_reauth = excluded.needs_reauth, " +
      "updated_at = excluded.updated_at",
  ).run(
    String(kind),
    String(alg),
    cipher,
    m.login ? String(m.login) : null,
    m.name ? String(m.name) : null,
    m.expiresAt ? String(m.expiresAt) : null,
    m.refreshExpiresAt ? String(m.refreshExpiresAt) : null,
    m.needsReauth ? 1 : 0,
    new Date().toISOString(),
  );
}

/** 删凭据行（不存在则忽略）。删不掉要报错：没删掉就不能当已登出。 */
export function clearCredentialRow(dataDir) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so the record was not deleted.");
  db.prepare("DELETE FROM credential WHERE id = 1").run();
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
