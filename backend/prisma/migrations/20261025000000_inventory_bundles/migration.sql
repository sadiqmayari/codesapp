-- Native Shopify bundle support on inventory variants. A bundle variant has no
-- own stock (Shopify derives it from components); we flag it + cache its
-- components so the board can show a read-only "buildable" count and never push
-- a bundle qty. MySQL 8 — NO `IF NOT EXISTS` by design (one-time phpMyAdmin
-- Import). Additive only.
ALTER TABLE `inventory_variants`
  ADD COLUMN `is_bundle`         TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `bundle_components` JSON       NULL;
