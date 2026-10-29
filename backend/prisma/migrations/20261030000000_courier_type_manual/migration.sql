-- Add a `manual` value to the CourierType enum so an order can be fulfilled
-- without booking a courier (Shopify-style manual fulfilment). Additive — every
-- existing row's `courier_type` value is unchanged. `manual` is never routed
-- through a courier adapter and is excluded from the bookable-courier lists.
-- Every table whose column maps to CourierType is altered so the Prisma client
-- stays in step with the DB enum definition.
ALTER TABLE `shipments`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual') NOT NULL;
ALTER TABLE `courier_credentials`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual') NOT NULL;
ALTER TABLE `courier_city_mappings`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual') NOT NULL;
ALTER TABLE `loadsheet_batches`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual') NOT NULL;
ALTER TABLE `courier_invoices`
  MODIFY `courier_type` ENUM('trax','leopards','postex','rocket','mnp','manual') NOT NULL;
