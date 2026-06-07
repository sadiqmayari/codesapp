-- WhatsApp-style reactions: a customer's emoji reaction is shown as a badge on
-- the reacted message's bubble (not a separate message). Holds the latest emoji
-- the customer placed on THIS message; NULL = none / removed.
ALTER TABLE `messages`
  ADD COLUMN `reaction` VARCHAR(64) NULL;
