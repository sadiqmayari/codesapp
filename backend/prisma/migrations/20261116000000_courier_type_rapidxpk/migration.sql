-- RapidXpk: 6th courier. Adds `rapidxpk` to every column that maps to the
-- CourierType enum (MySQL enums are per-column) and a nullable change-cursor on
-- courier_credentials for couriers that expose a "changes since" pull
-- (RapidXpk GET /v1/orders?updated_since&after_id). Additive — existing rows
-- are untouched.
ALTER TABLE `shipments`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk') NOT NULL;
ALTER TABLE `courier_credentials`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk') NOT NULL;
ALTER TABLE `courier_city_mappings`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk') NOT NULL;
ALTER TABLE `loadsheet_batches`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk') NOT NULL;
ALTER TABLE `courier_invoices`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk') NOT NULL;

ALTER TABLE `courier_credentials`
  ADD COLUMN `sync_cursor` JSON NULL;
