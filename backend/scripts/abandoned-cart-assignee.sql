-- Assign abandoned carts to agents.
--
-- Additive column on shopify_abandoned_checkouts. Raw DDL (prod migrate deploy
-- blocked, P3009) + raw read/write — NOT in schema.prisma. Apply ONCE on prod
-- before deploy. Idempotent.

ALTER TABLE `shopify_abandoned_checkouts`
  ADD COLUMN IF NOT EXISTS `assigned_user_id` BIGINT NULL;

CREATE INDEX IF NOT EXISTS `shopify_abandoned_assignee_idx`
  ON `shopify_abandoned_checkouts` (`company_id`, `assigned_user_id`);
