-- TCS: 7th courier. Adds `tcs` to every column mapped to the CourierType enum
-- (MySQL enums are per-column). Additive — existing rows untouched.
ALTER TABLE `shipments`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk','tcs') NOT NULL;
ALTER TABLE `courier_credentials`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk','tcs') NOT NULL;
ALTER TABLE `courier_city_mappings`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk','tcs') NOT NULL;
ALTER TABLE `loadsheet_batches`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk','tcs') NOT NULL;
ALTER TABLE `courier_invoices`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual','rapidxpk','tcs') NOT NULL;
