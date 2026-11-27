// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/db.js — GitHana 的本地数据文件（<dataDir>/data.db，SQLite）。
 *
 * 两张表，各管一类东西：
 *   settings(key, value, updated_at)         提交署名等偏好，一项一行（value 是 JSON）
 *   credentials(id=1, schema_version, kind, cipher, alg, meta, updated_at)
 *                                            OAuth 凭据（DPAPI 密文），固定一行
 *
 * 凭据单独成表是为了能一眼看清它有什么：kind / alg / 密文分开存，CHECK (id = 1) 保证只有
 * 一份，读的时候不用先 JSON.parse 才知道是不是 OAuth。偏好是松散的键值，加一项不需要改表。
 *
 * 不进库的东西：gitconfig、gpg.key.json、gpg.key.pub.asc —— git 与 gpg shim 按路径直读，
 * 必须是文件；临时产物（.runtime-tmp、verify 之类）也不进。
 *
 * 打开时做一次迁移：同目录下的旧 JSON（credential.json / prefs.json）和 v1 的 store 表
 * 会被搬进新表；旧文件改名为 *.migrated，旧表改名为 store_legacy，都不删，留着可回滚。
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
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS credentials (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, " +
        "kind TEXT, cipher TEXT NOT NULL, alg TEXT, meta TEXT, updated_at INTEGER NOT NULL)",
    );
  } catch {
    db = null;
  }
  connections.set(dir, db);
  if (db) migrateLegacy(dir, db);
  return db;
}

/** 旧数据搬家：先搬旧 JSON 文件，再搬 v1 的 store 表。都只做一次，失败就留原样下次再试。 */
function migrateLegacy(dir, db) {
  importLegacyFiles(dir, db);
  importLegacyStore(dir, db);
}

function importLegacyFiles(dir, db) {
  const files = [
    { file: "credential.json", kind: "credential" },
    { file: "prefs.json", kind: "prefs" },
  ];
  for (const item of files) {
    const from = path.join(dir, item.file);
    if (!fs.existsSync(from)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(from, "utf8"));
      if (item.kind === "credential") {
        if (!readCredentialRow(db)) writeCredentialRow(db, normalizeCredential(parsed));
      } else {
        const commit = parsed && typeof parsed.commit === "object" && parsed.commit ? parsed.commit : null;
        if (commit && !readSettingRow(db, "commit")) writeSettingRow(db, "commit", commit);
      }
      fs.renameSync(from, from + ".migrated");
    } catch {
      /* 导入失败：文件保持原样，下次再试 */
    }
  }
}

function importLegacyStore(dir, db) {
  let rows;
  try {
    rows = db.prepare("SELECT scope, key, value, updated_at FROM store").all();
  } catch {
    return; // 没有旧表
  }
  try {
    for (const row of rows) {
      const value = JSON.parse(String(row.value));
      if (!value || typeof value !== "object") continue;
      if (row.scope === "secret" && row.key === "credential") {
        if (!readCredentialRow(db)) writeCredentialRow(db, normalizeCredential(value));
      } else if (row.scope === "settings") {
        if (!readSettingRow(db, String(row.key))) writeSettingRow(db, String(row.key), value);
      }
    }
    db.exec("ALTER TABLE store RENAME TO store_legacy");
  } catch {
    /* 搬不动就留着旧表，不影响新表读写 */
  }
}

// ───────────────────────────── settings ─────────────────────────────

function readSettingRow(db, key) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return null;
    const value = JSON.parse(String(row.value));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function writeSettingRow(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), Date.now());
}

/** 读一项偏好（不存在 / 打不开 → null）。 */
export function getSetting(dataDir, key) {
  const db = openDb(dataDir);
  return db ? readSettingRow(db, key) : null;
}

/** 写一项偏好（覆盖）；写不进去直接抛错。 */
export function setSetting(dataDir, key, value) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so nothing was saved.");
  writeSettingRow(db, key, value);
}

// ───────────────────────────── credentials ─────────────────────────────

/** 把调用方给的对象收成凭据表的形状；缺 cipher 的记录没有意义，返回 null。 */
function normalizeCredential(record) {
  if (!record || typeof record !== "object") return null;
  const cipher = typeof record.cipher === "string" ? record.cipher : "";
  if (!cipher) return null;
  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    kind: typeof record.kind === "string" ? record.kind : null,
    cipher,
    alg: typeof record.alg === "string" ? record.alg : null,
    meta: record.meta && typeof record.meta === "object" ? record.meta : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function rowToCredential(row) {
  if (!row) return null;
  let meta = null;
  try {
    meta = row.meta ? JSON.parse(String(row.meta)) : null;
  } catch {
    meta = null;
  }
  return {
    schemaVersion: Number(row.schema_version) || 1,
    kind: row.kind ? String(row.kind) : null,
    cipher: String(row.cipher),
    alg: row.alg ? String(row.alg) : null,
    meta: meta && typeof meta === "object" ? meta : null,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function readCredentialRow(db) {
  try {
    return rowToCredential(db.prepare("SELECT * FROM credentials WHERE id = 1").get());
  } catch {
    return null;
  }
}

function writeCredentialRow(db, record) {
  db.prepare(
    "INSERT INTO credentials (id, schema_version, kind, cipher, alg, meta, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, kind = excluded.kind, " +
      "cipher = excluded.cipher, alg = excluded.alg, meta = excluded.meta, updated_at = excluded.updated_at",
  ).run(
    record.schemaVersion,
    record.kind,
    record.cipher,
    record.alg,
    record.meta ? JSON.stringify(record.meta) : null,
    Date.now(),
  );
}

/** 读凭据记录（没有 / 打不开 → null）。 */
export function getCredential(dataDir) {
  const db = openDb(dataDir);
  return db ? readCredentialRow(db) : null;
}

/** 写凭据记录（固定一行）。写不进去直接抛错：凭据不能悄悄丢。 */
export function setCredential(dataDir, record) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so the credential was not saved.");
  const normalized = normalizeCredential(record);
  if (!normalized) throw new Error("the credential record has no ciphertext.");
  writeCredentialRow(db, normalized);
}

/** 删凭据记录（不存在则忽略）。 */
export function deleteCredential(dataDir) {
  const db = openDb(dataDir);
  if (!db) return;
  try {
    db.prepare("DELETE FROM credentials WHERE id = 1").run();
  } catch {
    /* 删不掉时调用方按「已无本地凭据」处理 */
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
