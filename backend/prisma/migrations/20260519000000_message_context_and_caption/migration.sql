-- FE-2d: reply-with-context. Adds a nullable self-referencing column on
-- messages so an outbound/inbound message can quote the message it replies
-- to (Meta context.message_id ↔ our internal message id).
--
-- One-time import (MySQL 8 has NO `ADD COLUMN IF NOT EXISTS`). Run exactly
-- once via phpMyAdmin → Import. Re-running fails on duplicate
-- `fk_messages_context` / duplicate column / duplicate index — if a partial
-- run occurred, comment out the statements that already applied.

ALTER TABLE `messages` ADD COLUMN `context_message_id` INT NULL;

ALTER TABLE `messages`
  ADD CONSTRAINT `fk_messages_context`
  FOREIGN KEY (`context_message_id`) REFERENCES `messages`(`id`)
  ON DELETE SET NULL;

CREATE INDEX `idx_messages_context` ON `messages`(`context_message_id`);
