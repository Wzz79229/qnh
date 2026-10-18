CREATE TABLE IF NOT EXISTS mobile_sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mobile_session_expiry ON mobile_sessions(expires_at);
CREATE TABLE IF NOT EXISTS mobile_auth_rate (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_batches (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sku TEXT NOT NULL,
  payload TEXT NOT NULL,
  image_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS mobile_batch_recent ON mobile_batches(tenant_id,created_at DESC,id DESC);
