-- WhatsApp-style conversation ordering. `updated_at` is bumped by
-- read/label/assign writes (Prisma @updatedAt), so opening a chat used to
-- re-sort it to the top. Order by a dedicated last_message_at instead.
-- One-time import (MySQL 8, no IF NOT EXISTS). Backfill existing rows from
-- updated_at so they keep a sane initial order.

ALTER TABLE `conversations` ADD COLUMN `last_message_at` DATETIME(3) NULL;

UPDATE `conversations` SET `last_message_at` = `updated_at`;

CREATE INDEX `conversations_company_id_last_message_at_idx`
  ON `conversations`(`company_id`, `last_message_at`);
