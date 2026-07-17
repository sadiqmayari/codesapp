-- Add a `played` state to messages.status. WhatsApp emits a `played` status
-- callback when the recipient plays a voice note / opens view-once media — a
-- step beyond `read`. Without this enum value the status webhook threw
-- (`Invalid value for argument status`) and the receipt was dropped. Appending
-- an enum value at the END of the list is an in-place, metadata-only change on
-- MariaDB (no table copy) so it's instant even on the large messages table.
-- Additive; existing rows are unaffected.
ALTER TABLE `messages`
  MODIFY COLUMN `status` ENUM('sent','delivered','read','failed','sending','played') NOT NULL DEFAULT 'sent';
