-- Content planning: allow a "planned" item with no media yet (media_type NULL)
-- + an optional target platform. MySQL 8 — one-time phpMyAdmin Import. Additive.
ALTER TABLE `content_items`
  MODIFY `media_type` VARCHAR(16) NULL,
  ADD COLUMN `platform` VARCHAR(32) NULL;
