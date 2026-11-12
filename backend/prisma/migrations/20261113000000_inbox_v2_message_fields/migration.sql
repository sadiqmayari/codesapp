-- Inbox-v2: agent reactions + persisted failure reasons (additive, nullable).
ALTER TABLE `messages`
  ADD COLUMN `agent_reaction` VARCHAR(64) NULL,
  ADD COLUMN `error_reason` VARCHAR(500) NULL;
