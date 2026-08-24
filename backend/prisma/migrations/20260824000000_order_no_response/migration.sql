-- Agent "no response" marker on an order (called an Awaiting / No-WhatsApp
-- customer, no answer). Parallels manual_confirmed_at; drives the queue
-- 'no_response' badge + the "❌ NO RESPONSE" Shopify order tag. Additive.
ALTER TABLE `shopify_orders` ADD COLUMN `no_response_at` DATETIME(3) NULL;
