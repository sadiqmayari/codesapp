-- Per-tenant courier status-sync cadence (drives shipper-advice detection + the
-- general delivery-status poll). Additive, nullable only.
--   courier_sync_interval_minutes : how often the background courier status sync
--     runs for this tenant (minutes). NULL = platform default (240 = 4h).
--   courier_sync_last_at          : last time a sync was enqueued for this tenant
--     (the in-process scheduler gates the next run off this + the interval).
ALTER TABLE `companies`
  ADD COLUMN `courier_sync_interval_minutes` INT NULL,
  ADD COLUMN `courier_sync_last_at` DATETIME(3) NULL;
