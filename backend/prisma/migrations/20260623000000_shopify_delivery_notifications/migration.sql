-- Generalize proactive order notifications into a single delivery-notification
-- config (JSON map of event_key -> {templateId, variableMap, enabled}).
-- Replaces the per-event columns added in 20260621/20260622 (zero tenants had
-- configured them). Events: order_fulfilled, order_cancelled, out_for_delivery,
-- delivered, attempted, failed.
ALTER TABLE `shopify_order_configs`
  DROP COLUMN `fulfillment_template_id`,
  DROP COLUMN `fulfillment_variable_map`,
  DROP COLUMN `cancellation_template_id`,
  DROP COLUMN `cancellation_variable_map`,
  ADD COLUMN `delivery_notifications` JSON NULL;
