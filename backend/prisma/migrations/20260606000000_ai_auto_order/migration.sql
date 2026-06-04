-- AI auto-order (Shopify) — opt-in tenant toggle + per-conversation idempotency.
-- companies.ai_auto_order_enabled : master switch (default off).
-- conversations.ai_order_created_at : set when the AI auto-creates an order so a
--   second one isn't created for the same chat.
ALTER TABLE `companies` ADD COLUMN `ai_auto_order_enabled` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `conversations` ADD COLUMN `ai_order_created_at` DATETIME(3) NULL;
