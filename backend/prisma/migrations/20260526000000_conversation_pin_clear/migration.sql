-- Shell-Polish-B: conversation pin + "clear chat" soft marker.
-- MySQL 8 — NO `IF NOT EXISTS` on ADD COLUMN / CREATE INDEX.
-- One-time phpMyAdmin Import only. Re-running on a DB that already has
-- these fails with "Duplicate column name" / "Duplicate key name".
-- Both columns are additive + nullable (no backfill, no row deletes).
ALTER TABLE conversations ADD COLUMN pinned_at DATETIME(3) NULL;
ALTER TABLE conversations ADD COLUMN cleared_before DATETIME(3) NULL;
CREATE INDEX conversations_company_id_pinned_at_idx
  ON conversations (company_id, pinned_at DESC);
