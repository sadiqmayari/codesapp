-- Shell-Polish-A: company branding logo.
-- MySQL 8 — NO `IF NOT EXISTS` on ADD COLUMN. One-time phpMyAdmin Import only.
-- Re-running on a DB that already has the column fails with "Duplicate column name".
ALTER TABLE companies ADD COLUMN logo_url VARCHAR(500) NULL;
