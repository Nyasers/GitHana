// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/db.js — GitHana 的本地数据文件（<dataDir>/data.db，SQLite）。
 *
 * 三张表，各管一类东西：
 *   credentials(id=1, schema_version, kind, cipher, alg, login, name,
 *               expires_at, refresh_expires_at, client_id, needs_reauth, updated_at)
 *                                            OAuth 凭据（DPAPI 密文），固定一行
 *   commit_settings(id=1, default_via, updated_at)
 *                                            提交通道，固定一行
 *   commit_co_authors(credit)                 共同署名；一套设定，两种通道共用
 *
 * 全部是普通列，没有 JSON 列。共同署名只存一套：本地提交时作者就是用户，用户那项会被
 * 自署规则去掉，于是两种通道自然落到各自的正确组合，不需要按通道存两份。
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
      "CREATE TABLE IF NOT EXISTS credentials (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, " +
        "kind TEXT, cipher TEXT NOT NULL, alg TEXT, " +
        "login TEXT, name TEXT, expires_at TEXT, refresh_expires_at TEXT, client_id TEXT, " +
        "needs_reauth INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS commit_settings (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "default_via TEXT NOT NULL CHECK (default_via IN ('local', 'api')), " +
        "updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS commit_co_authors (" +
        "credit TEXT PRIMARY KEY CHECK (credit IN ('user', 'hanaagent', 'githana-bot')))",
    );
  } catch {
    db = null;
  }
  connections.set(dir, db);
  return db;
}

// ───────────────────────────── 提交署名 ─────────────────────────────

function readCommitRow(db) {
  const row = db.prepare("SELECT default_via FROM commit_settings WHERE id = 1").get();
  if (!row) return null;
  const credits = db
    .prepare("SELECT credit FROM commit_co_authors ORDER BY credit")
    .all()
    .map((r) => String(r.credit));
  return { defaultVia: row.default_via === "api" ? "api" : "local", credits };
}

function writeCommitRow(db, value) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO commit_settings (id, default_via, updated_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET default_via = excluded.default_via, updated_at = excluded.updated_at",
    ).run(value.defaultVia, Date.now());
    db.exec("DELETE FROM commit_co_authors");
    const insert = db.prepare("INSERT OR IGNORE INTO commit_co_authors (credit) VALUES (?)");
    for (const credit of value.credits || []) insert.run(credit);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 读提交署名设置（没有 / 打不开 → null）。 */
export function getCommitSettings(dataDir) {
  const db = openDb(dataDir);
  return db ? readCommitRow(db) : null;
}

/** 写提交署名设置（固定一行 + 署名集合）；写不进去直接抛错。 */
export function setCommitSettings(dataDir, value) {
  const db = openDb(dataDir);
  if (!db) throw new Error("the local data.db could not be opened, so nothing was saved.");
  writeCommitRow(db, value);
}

// ───────────────────────────── credentials ─────────────────────────────

/** 把调用方给的对象收成凭据表的形状；缺 cipher 的记录没有意义，返回 null。 */
function normalizeCredential(record) {
  if (!record || typeof record !== "object") return null;
  const cipher = typeof record.cipher === "string" ? record.cipher : "";
  if (!cipher) return null;
  const meta = record.meta && typeof record.meta === "object" ? record.meta : {};
  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    kind: typeof record.kind === "string" ? record.kind : null,
    cipher,
    alg: typeof record.alg === "string" ? record.alg : null,
    login: meta.login == null ? null : String(meta.login),
    name: meta.name == null ? null : String(meta.name),
    expiresAt: meta.expiresAt == null ? null : String(meta.expiresAt),
    refreshExpiresAt: meta.refreshExpiresAt == null ? null : String(meta.refreshExpiresAt),
    clientId: meta.clientId == null ? null : String(meta.clientId),
    needsReauth: meta.needsReauth === true ? 1 : 0,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function rowToCredential(row) {
  if (!row) return null;
  const meta = {};
  if (row.login) meta.login = String(row.login);
  if (row.name) meta.name = String(row.name);
  if (row.expires_at) meta.expiresAt = String(row.expires_at);
  if (row.refresh_expires_at) meta.refreshExpiresAt = String(row.refresh_expires_at);
  if (row.client_id) meta.clientId = String(row.client_id);
  if (Number(row.needs_reauth) === 1) meta.needsReauth = true;
  return {
    schemaVersion: Number(row.schema_version) || 1,
    kind: row.kind ? String(row.kind) : null,
    cipher: String(row.cipher),
    alg: row.alg ? String(row.alg) : null,
    meta: Object.keys(meta).length ? meta : null,
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
    "INSERT INTO credentials (id, schema_version, kind, cipher, alg, login, name, expires_at, " +
      "refresh_expires_at, client_id, needs_reauth, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, kind = excluded.kind, " +
      "cipher = excluded.cipher, alg = excluded.alg, login = excluded.login, name = excluded.name, " +
      "expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at, " +
      "client_id = excluded.client_id, needs_reauth = excluded.needs_reauth, updated_at = excluded.updated_at",
  ).run(
    record.schemaVersion,
    record.kind,
    record.cipher,
    record.alg,
    record.login,
    record.name,
    record.expiresAt,
    record.refreshExpiresAt,
    record.clientId,
    record.needsReauth,
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
