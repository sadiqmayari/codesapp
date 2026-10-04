-- Multi-Store: optional per-tenant lock that forces ALL chat-created orders
-- (manual + AI) into one store. NULL = agents choose per order (default).
ALTER TABLE `companies` ADD COLUMN `order_fixed_store_id` INTEGER NULL;
