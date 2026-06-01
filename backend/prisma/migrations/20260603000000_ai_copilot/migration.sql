-- AI Copilot — Phase 1 foundation.
-- One-time phpMyAdmin Import (MySQL 8, no IF NOT EXISTS — re-run fails on dup
-- column/table). Pair with redeploy WITH `npm install` (Prisma client regen for
-- the new fields/models — else 5xx on routes touching them).
-- All additive + defaulted so existing rows/queries are unaffected.

-- 1. Plan gate: AI is opt-in per plan.
ALTER TABLE `subscriptions` ADD COLUMN `ai_enabled` BOOLEAN NOT NULL DEFAULT false;

-- 2. Per-company AI settings/preferences. ai_enabled is the tenant's own
--    toggle (effective access also requires the plan's ai_enabled).
ALTER TABLE `companies` ADD COLUMN `ai_enabled`           BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE `companies` ADD COLUMN `ai_brand_tone`        VARCHAR(2000) NULL;
ALTER TABLE `companies` ADD COLUMN `ai_default_language`  VARCHAR(32)   NULL;
ALTER TABLE `companies` ADD COLUMN `ai_monthly_cap_cents` INT          NULL;

-- 3. Monthly rollup counters (fast cap/quota check + dashboards). Authoritative
--    per-call ledger is ai_usage_log. cost in MICRO-dollars (RAW provider cost).
ALTER TABLE `usage_metering` ADD COLUMN `ai_requests`      INT    NOT NULL DEFAULT 0;
ALTER TABLE `usage_metering` ADD COLUMN `ai_input_tokens`  INT    NOT NULL DEFAULT 0;
ALTER TABLE `usage_metering` ADD COLUMN `ai_output_tokens` INT    NOT NULL DEFAULT 0;
ALTER TABLE `usage_metering` ADD COLUMN `ai_cost_micros`   BIGINT NOT NULL DEFAULT 0;

-- 4. Tenant knowledge base (grounding context, prompt-cached).
CREATE TABLE `ai_knowledge_base` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `company_id` INT          NOT NULL,
  `title`      VARCHAR(200) NOT NULL,
  `content`    TEXT         NOT NULL,
  `enabled`    BOOLEAN      NOT NULL DEFAULT true,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `ai_knowledge_base_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Per-call usage ledger (authoritative for post-paid billing + breakdown).
CREATE TABLE `ai_usage_log` (
  `id`            INT         NOT NULL AUTO_INCREMENT,
  `company_id`    INT         NOT NULL,
  `user_id`       INT         NULL,
  `period`        VARCHAR(7)  NOT NULL,
  `feature`       VARCHAR(32) NOT NULL,
  `model`         VARCHAR(64) NOT NULL,
  `input_tokens`  INT         NOT NULL DEFAULT 0,
  `output_tokens` INT         NOT NULL DEFAULT 0,
  `cost_micros`   BIGINT      NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ai_usage_log_company_id_created_at_idx` (`company_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Platform-wide AI price markup (billed = raw cost x multiplier). Seed.
INSERT INTO `platform_settings` (`key`, `value`, `updated_at`)
VALUES ('ai_price_multiplier', '1.5', CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE `key` = `key`;
