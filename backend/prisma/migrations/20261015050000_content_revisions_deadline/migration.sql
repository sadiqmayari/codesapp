-- Remove play-count tracking (feature dropped) and add a task deadline.
-- MySQL 8 — one-time phpMyAdmin Import. Destructive: drops content_plays +
-- content_items.play_count (play tracking removed by request).
ALTER TABLE `content_items`
  DROP COLUMN `play_count`,
  ADD COLUMN `deadline` DATETIME(3) NULL;

DROP TABLE `content_plays`;
