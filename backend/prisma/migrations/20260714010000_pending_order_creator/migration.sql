-- Record which agent created an order (via the Create-order modal). The
-- orders/create webhook reads this back by order_gid to stamp the confirmation
-- message's user_id, so analytics "orders per agent" credits the real creator
-- instead of whoever the chat happens to be assigned to. Null = AI-auto or
-- storefront-direct order (no human creator).
ALTER TABLE `pending_order_hashes`
  ADD COLUMN `created_by_user_id` INT NULL;
