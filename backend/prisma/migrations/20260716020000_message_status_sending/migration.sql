-- Add a `sending` state to messages.status. Outbound media is now persisted as
-- `sending` and the slow Meta upload+send runs on the send-media queue, flipping
-- the row to `sent`/`failed` when Meta acks — so the HTTP request returns
-- instantly instead of blocking on two Meta round-trips. Additive enum value;
-- existing rows are unaffected.
ALTER TABLE `messages`
  MODIFY COLUMN `status` ENUM('sent','delivered','read','failed','sending') NOT NULL DEFAULT 'sent';
