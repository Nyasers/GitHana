INSERT INTO credential (id, kind, alg, cipher, expires_at, refresh_expires_at, needs_reauth, updated_at)
VALUES (1, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  alg = excluded.alg,
  cipher = excluded.cipher,
  expires_at = excluded.expires_at,
  refresh_expires_at = excluded.refresh_expires_at,
  needs_reauth = excluded.needs_reauth,
  updated_at = excluded.updated_at
