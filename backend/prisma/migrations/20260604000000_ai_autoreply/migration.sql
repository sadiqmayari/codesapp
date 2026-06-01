-- AI Copilot — Phase 2 (fully-automated auto-responder) + provider toggle.
-- One-time phpMyAdmin Import (MySQL 8, no IF NOT EXISTS — re-run fails on dup
-- column). Pair with redeploy WITH `npm install` (Prisma client regen + new
-- `openai` dep — else 5xx). Additive + defaulted.

-- Per-company auto-responder toggle (opt-in; confidence-gated handoff).
ALTER TABLE `companies` ADD COLUMN `ai_autoreply_enabled` BOOLEAN NOT NULL DEFAULT false;

-- Platform-wide active AI provider ('anthropic' | 'openai'). Seed anthropic.
INSERT INTO `platform_settings` (`key`, `value`, `updated_at`)
VALUES ('ai_provider', 'anthropic', CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE `key` = `key`;
