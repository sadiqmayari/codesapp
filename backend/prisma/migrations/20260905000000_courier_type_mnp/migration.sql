-- Add M&P (Muller & Phipps) to the CourierType enum.
-- MySQL/MariaDB enums are per-column, so every column typed CourierType must be
-- ALTERed to include the new 'mnp' member (appended last to match schema order).
ALTER TABLE `courier_credentials`   MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp') NOT NULL;
ALTER TABLE `courier_city_mappings` MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp') NOT NULL;
ALTER TABLE `courier_invoices`      MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp') NOT NULL;
ALTER TABLE `loadsheet_batches`     MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp') NOT NULL;
ALTER TABLE `shipments`             MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp') NOT NULL;
