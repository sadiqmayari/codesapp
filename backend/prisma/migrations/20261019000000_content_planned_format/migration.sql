-- Planned format: the expected media type (image/video) chosen at plan time,
-- distinct from media_type (the ACTUAL uploaded file's type). MySQL 8 —
-- one-time phpMyAdmin Import. Additive.
ALTER TABLE content_items
  ADD COLUMN planned_media_type VARCHAR(16) NULL;
