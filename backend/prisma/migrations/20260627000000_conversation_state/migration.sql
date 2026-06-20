-- Conversation State Machine (enterprise hardening #1).
--
-- WHY: the deterministic conversation state (see ConversationStateMachine) needs a
-- durable home, one row per conversation. The backend is the only writer; the LLM
-- may read it as context but never mutates it. Ships in SHADOW mode (recorded +
-- validated alongside the existing ai_* flags, changing nothing) so the transition
-- table is proven against real traffic before becoming authoritative.
--
-- Additive + backward compatible: a new table, no changes to existing columns, no
-- backfill. Recording is flag-gated (default OFF).
CREATE TABLE `conversation_states` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `company_id`      INT NOT NULL,
  `conversation_id` INT NOT NULL,
  `current_state`   VARCHAR(32) NOT NULL,
  -- The intent this conversation is locked to (advisory; from the router).
  `locked_intent`   VARCHAR(24) NULL,
  -- Fields gathered so far for an in-progress order (name/phone/address/…).
  `collected_fields` JSON NULL,
  `active_order_id` VARCHAR(64) NULL,
  `active_ticket_id` INT NULL,
  `expires_at`      DATETIME(3) NULL,
  `last_updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  -- One state row per conversation.
  UNIQUE INDEX `conversation_states_conversation_id_key` (`conversation_id`),
  INDEX `conversation_states_company_id_current_state_idx` (`company_id`, `current_state`)
) DEFAULT CHARACTER SET utf8mb4;
