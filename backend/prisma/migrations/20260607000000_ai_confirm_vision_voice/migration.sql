-- June-2026 AI batch: confirm-before-create, workspace-wide auto-order, vision + voice.

ALTER TABLE `conversations`
  ADD COLUMN `ai_pending_order` JSON NULL,
  ADD COLUMN `ai_pending_order_at` DATETIME(3) NULL;

ALTER TABLE `companies`
  ADD COLUMN `ai_auto_order_all_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `ai_vision_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `ai_voice_enabled` TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE `messages`
  ADD COLUMN `transcription` TEXT NULL;
