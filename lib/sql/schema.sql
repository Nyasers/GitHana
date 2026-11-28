-- GitHana 的本地库：两张表。
--
-- settings   键值：author / account / gpg / gpg-published
-- credential 单行（id = 1）：OAuth 密文（BLOB）与令牌时间
--
-- 启动时跑一次，已存在就跳过。

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  kind               TEXT NOT NULL,
  alg                TEXT NOT NULL,
  cipher             BLOB NOT NULL,
  expires_at         TEXT,
  refresh_expires_at TEXT,
  needs_reauth       INTEGER NOT NULL DEFAULT 0 CHECK (needs_reauth IN (0,1)),
  updated_at         TEXT NOT NULL
);
