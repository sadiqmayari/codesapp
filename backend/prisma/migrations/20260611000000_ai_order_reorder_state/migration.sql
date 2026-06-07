-- AI order accuracy batch (RAG-centric, order-safe).
-- ai_last_order_signature: sorted items+qty of the LAST AI-created order in this
--   conversation. Paired with ai_order_created_at (last-order time) for a
--   reorder-safe duplicate guard (block only same-signature within a short window;
--   allow a genuine reorder). Replaces the old permanent one-order-per-convo lock.
-- ai_awaiting_payment_at: set when the AI sent prepaid bank details and is waiting
--   for the payment slip (Rule 4: never auto-create a prepaid order).
ALTER TABLE `conversations`
  ADD COLUMN `ai_last_order_signature` VARCHAR(255) NULL,
  ADD COLUMN `ai_awaiting_payment_at`  DATETIME(3) NULL;
