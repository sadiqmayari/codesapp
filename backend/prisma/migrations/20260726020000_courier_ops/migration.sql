-- Courier ops batch: attempt/fail reasons, per-parcel label link, shipper advice.
ALTER TABLE `shipments`
  ADD COLUMN `last_status_reason` VARCHAR(255) NULL AFTER `last_courier_status_raw`,
  ADD COLUMN `courier_slip_link` VARCHAR(500) NULL AFTER `last_status_reason`,
  ADD COLUMN `shipper_advice_status` VARCHAR(24) NULL AFTER `courier_slip_link`,
  ADD COLUMN `shipper_advice_remarks` VARCHAR(500) NULL AFTER `shipper_advice_status`,
  ADD COLUMN `shipper_advice_at` DATETIME(3) NULL AFTER `shipper_advice_remarks`;
