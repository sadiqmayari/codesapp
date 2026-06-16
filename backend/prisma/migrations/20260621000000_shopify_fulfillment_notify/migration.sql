-- Part 3: proactive Shopify -> WhatsApp notifications (orders/fulfilled).
-- Reuses the existing template-send path; a generic approved template is bound
-- to the fulfillment event. Null template = feature dark for the tenant.
ALTER TABLE `shopify_order_configs`
  ADD COLUMN `fulfillment_template_id` INT NULL,
  ADD COLUMN `fulfillment_variable_map` JSON NULL;
