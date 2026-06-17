-- Part 3 (cont.): proactive orders/cancelled -> WhatsApp notification.
-- Same feature gate as the shipped notification; reuses the template-send path.
ALTER TABLE `shopify_order_configs`
  ADD COLUMN `cancellation_template_id` INT NULL,
  ADD COLUMN `cancellation_variable_map` JSON NULL;
