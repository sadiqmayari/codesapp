-- Per-agent attribution on outbound messages.
--
-- Before this column, the analytics agent leaderboard was forced to
-- approximate sender attribution via `conversations.assigned_user_id`, which
-- credits the CURRENT assignee for messages historically sent by anyone else
-- on that conversation (other agents, broadcasts, bot-fired sends). With this
-- column we record who actually composed the outbound message, NULL for
-- inbound / broadcast / bot / system sends.
--
-- One-time phpMyAdmin Import. Additive: column nullable, no backfill required.
-- Redeploy WITH `npm install` so the Prisma client regenerates for the new
-- column (else writes that include `user_id` will fail with an unknown-column
-- error at the client layer).

ALTER TABLE messages
  ADD COLUMN user_id INT NULL AFTER context_message_id,
  ADD INDEX messages_user_id_idx (user_id),
  ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE;
