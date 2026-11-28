-- Per-order lookups (confirm state, dashboard order flow) scanned the whole table without this.
CREATE INDEX `shopify_order_messages_company_id_shopify_order_gid_idx` ON `shopify_order_messages`(`company_id`, `shopify_order_gid`);
