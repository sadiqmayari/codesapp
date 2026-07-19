-- Agent-competition (gamification) tables.
--
-- Prod's `prisma migrate deploy` is blocked (P3009 — a stuck failed migration),
-- so — exactly like ai_knowledge_chunks and pending_order_hashes.order_total —
-- these are created with raw DDL applied directly on prod MariaDB and accessed
-- via $queryRawUnsafe/$executeRawUnsafe. They are intentionally NOT in the
-- Prisma schema (keeps the code immune to a stale/unmigrated Prisma client).
--
-- Apply ONCE on prod BEFORE deploying the new code, e.g.:
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < gamification-tables.sql
--
-- All idempotent (IF NOT EXISTS) — safe to re-run.

CREATE TABLE IF NOT EXISTS gamification_settings (
  company_id  BIGINT      NOT NULL PRIMARY KEY,
  config      JSON        NULL,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_contests (
  id                  BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id          BIGINT       NOT NULL,
  name                VARCHAR(160) NOT NULL,
  description         VARCHAR(500) NULL,
  metric              VARCHAR(24)  NOT NULL,
  target_value        DECIMAL(14,2) NULL,
  prize               VARCHAR(300) NULL,
  starts_at           DATETIME     NOT NULL,
  ends_at             DATETIME     NOT NULL,
  status              VARCHAR(16)  NOT NULL DEFAULT 'scheduled',
  created_by_user_id  BIGINT       NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_contests_company_end (company_id, ends_at)
);

CREATE TABLE IF NOT EXISTS agent_targets (
  id                  BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id          BIGINT       NOT NULL,
  user_id             BIGINT       NOT NULL,
  metric              VARCHAR(24)  NOT NULL,
  target_value        DECIMAL(14,2) NOT NULL,
  period_type         VARCHAR(12)  NOT NULL,
  active              TINYINT      NOT NULL DEFAULT 1,
  created_by_user_id  BIGINT       NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_target (company_id, user_id, metric, period_type)
);
