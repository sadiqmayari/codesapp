-- Team-chat delivery receipts: track when each member last received a thread's
-- messages (read already tracked via last_read_at). Enables the 3-state DM ticks
-- (sent / delivered / read). Additive + nullable — no backfill needed.
ALTER TABLE `internal_thread_members`
  ADD COLUMN `last_delivered_at` DATETIME(3) NULL AFTER `last_read_at`;
