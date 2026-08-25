-- Orders-analytics: bucket delivery tiles by shipment event date, not order date.
-- Adds a failed_at timestamp (set when a parcel first fails) + event-date indexes.

ALTER TABLE `shipments` ADD COLUMN `failed_at` DATETIME(3) NULL;

-- Best-effort backfill for parcels already in a failed state: use updated_at as
-- the approximate fail time (no status-change history exists pre-migration).
UPDATE `shipments` SET `failed_at` = `updated_at` WHERE `status` = 'failed' AND `failed_at` IS NULL;

CREATE INDEX `shipments_company_id_booked_at_idx` ON `shipments` (`company_id`, `booked_at`);
CREATE INDEX `shipments_company_id_delivered_at_idx` ON `shipments` (`company_id`, `delivered_at`);
CREATE INDEX `shipments_company_id_failed_at_idx` ON `shipments` (`company_id`, `failed_at`);
