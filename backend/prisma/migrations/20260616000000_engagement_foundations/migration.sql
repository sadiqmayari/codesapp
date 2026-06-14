-- Engagement-engine redesign — Phase 0 foundations. ALL ADDITIVE, safe one-time
-- import. No existing column/table is altered destructively; existing jobs with a
-- NULL serial_key behave exactly as before.
--
-- 1) jobs: per-conversation serialization (serial_key) + enqueue dedup (dedup_key)
--    + priority. The job-queue claim query single-flights rows that share a
--    serial_key while leaving NULL-keyed jobs fully parallel (legacy behavior).
-- 2) events: append-only event log = audit + idempotency + recovery foundation.
-- 3) outbox: reliable external side-effects (WhatsApp/Shopify) with idempotency.

-- ── jobs: serialization / dedup / priority ────────────────────────────────────
ALTER TABLE `jobs`
  ADD COLUMN `serial_key` VARCHAR(64)  NULL,
  ADD COLUMN `dedup_key`  VARCHAR(128) NULL,
  ADD COLUMN `priority`   TINYINT      NOT NULL DEFAULT 5;

-- Claim-query support: scan pending rows by (queue, status, priority, run_at) and
-- the processing-serial check needs (serial_key, status).
CREATE INDEX `jobs_queue_status_priority_run_at_idx`
  ON `jobs` (`queue_name`, `status`, `priority`, `run_at`);
CREATE INDEX `jobs_serial_key_status_idx`
  ON `jobs` (`serial_key`, `status`);
-- Enqueue dedup: a non-null dedup_key may be enqueued at most once while live.
-- (MySQL permits multiple NULLs in a UNIQUE index, so NULL-keyed jobs are free.)
CREATE UNIQUE INDEX `jobs_dedup_key_key` ON `jobs` (`dedup_key`);

-- ── events (append-only log) ──────────────────────────────────────────────────
CREATE TABLE `events` (
  `id`              BIGINT       NOT NULL AUTO_INCREMENT,
  `company_id`      INT          NOT NULL,
  `aggregate_type`  VARCHAR(24)  NOT NULL,
  `aggregate_id`    BIGINT       NOT NULL,
  `seq`             INT          NOT NULL,
  `type`            VARCHAR(48)  NOT NULL,
  `actor_type`      VARCHAR(16)  NOT NULL,
  `actor_id`        VARCHAR(64)  NULL,
  `payload`         JSON         NULL,
  `idempotency_key` VARCHAR(128) NULL,
  `created_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `events_aggregate_seq_key` (`aggregate_type`, `aggregate_id`, `seq`),
  UNIQUE INDEX `events_company_idempotency_key` (`company_id`, `idempotency_key`),
  INDEX `events_company_aggregate_idx` (`company_id`, `aggregate_type`, `aggregate_id`, `seq`),
  INDEX `events_company_type_idx` (`company_id`, `type`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── outbox (reliable external side-effects) ───────────────────────────────────
CREATE TABLE `outbox` (
  `id`              BIGINT       NOT NULL AUTO_INCREMENT,
  `company_id`      INT          NOT NULL,
  `kind`            VARCHAR(24)  NOT NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `payload`         JSON         NOT NULL,
  `state`           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  `attempts`        INT          NOT NULL DEFAULT 0,
  `provider_ref`    VARCHAR(128) NULL,
  `last_error`      TEXT         NULL,
  `created_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sent_at`         DATETIME(3)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `outbox_idempotency_key_key` (`idempotency_key`),
  INDEX `outbox_state_created_at_idx` (`state`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
