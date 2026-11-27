// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/db.js — GitHana 的本地数据文件（<dataDir>/data.db，SQLite）。
 *
 * 一张表装全部本地状态：
 *   store(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)
 *
 * value 存 **JSON 文本**。读写频率极低（启动读一次凭据、设置页偶尔写一次），jsonb 的二进制
 * 体积与解析优势用不上，而文本在 SQLiteStudio 里能直接看、能 diff、出问题时能手改。
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
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  } catch {
    db = null;
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
  ).run(String(key), JSON.stringify(value), Date.now());
}

/** 删一条记录（不存在则忽略）。 */
export function deleteRecord(dataDir, key) {
  const db = openDb(dataDir);
  if (!db) return;
  try {
    db.prepare("DELETE FROM store WHERE key = ?").run(String(key));
  } catch {
    /* 删不掉时调用方按「已无本地记录」处理 */
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
