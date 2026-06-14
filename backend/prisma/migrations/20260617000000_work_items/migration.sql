-- Engagement-engine Phase 1 — work items (engagements). ALL ADDITIVE.
--
-- A conversation becomes a container of many concurrently-OPEN work items, each
-- with its own finite-state machine and its own hard-scoped context. This is the
-- structural fix for: context mixing, disputes-mixed-with-sales (a DISPUTE and an
-- ORDER item now coexist), multiple simultaneous orders, and per-item closure.
--
-- Nothing reads/writes these tables yet (state-machine classes + router wire them
-- in later phases behind a feature flag) — so importing this changes no behavior.

-- ── work_items ────────────────────────────────────────────────────────────────
CREATE TABLE `work_items` (
  `id`               INT          NOT NULL AUTO_INCREMENT,
  `company_id`       INT          NOT NULL,
  `conversation_id`  INT          NOT NULL,
  `contact_id`       INT          NOT NULL,
  `type`             VARCHAR(16)  NOT NULL,                 -- SALES|ORDER|TRACKING|DISPUTE|SUPPORT
  `state`            VARCHAR(32)  NOT NULL,                 -- per-type FSM state
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'OPEN',  -- OPEN|SNOOZED|RESOLVED|CANCELLED|EXPIRED
  `priority`         TINYINT      NOT NULL DEFAULT 5,
  `owner`            VARCHAR(8)   NOT NULL DEFAULT 'AI',     -- AI|HUMAN|SYSTEM
  `external_ref`     VARCHAR(64)  NULL,                      -- shopify order name/gid, ticket number
  `assigned_user_id` INT          NULL,
  `expires_at`       DATETIME(3)  NULL,                      -- TRACKING idle / AWAITING_* SLA
  `last_activity_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)  NOT NULL,
  `closed_at`        DATETIME(3)  NULL,
  PRIMARY KEY (`id`),
  INDEX `work_items_company_conversation_status_idx` (`company_id`, `conversation_id`, `status`),
  INDEX `work_items_company_type_status_idx` (`company_id`, `type`, `status`),
  INDEX `work_items_company_status_expires_idx` (`company_id`, `status`, `expires_at`),
  CONSTRAINT `work_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `work_items_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `work_items_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `work_items_assigned_user_id_fkey` FOREIGN KEY (`assigned_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── messages: hard work-item scoping + per-conversation sequence ───────────────
-- work_item_id partitions a message to exactly one engagement (identity-based
-- context isolation, replacing the temporal window heuristic). seq is the
-- per-conversation monotonic order assigned by the serial executor. Both INT and
-- nullable (legacy rows + un-routed messages stay NULL); INT (not BIGINT) avoids
-- the bigint-in-JSON-response serialization break, since messages are API-exposed.
ALTER TABLE `messages`
  ADD COLUMN `work_item_id` INT NULL,
  ADD COLUMN `seq`          INT NULL;
CREATE INDEX `messages_work_item_id_timestamp_idx` ON `messages` (`work_item_id`, `timestamp`);
CREATE INDEX `messages_conversation_id_seq_idx` ON `messages` (`conversation_id`, `seq`);
ALTER TABLE `messages`
  ADD CONSTRAINT `messages_work_item_id_fkey` FOREIGN KEY (`work_item_id`) REFERENCES `work_items` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ── told_ledger (stops the AI restating identical facts) ───────────────────────
CREATE TABLE `told_ledger` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `company_id`   INT          NOT NULL,
  `work_item_id` INT          NOT NULL,
  `fact_kind`    VARCHAR(32)  NOT NULL,   -- order_status|tracking_no|price_quote
  `fact_hash`    VARCHAR(64)  NOT NULL,   -- hash of the exact value communicated
  `told_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `told_ledger_work_item_kind_hash_key` (`work_item_id`, `fact_kind`, `fact_hash`),
  INDEX `told_ledger_company_id_idx` (`company_id`),
  CONSTRAINT `told_ledger_work_item_id_fkey` FOREIGN KEY (`work_item_id`) REFERENCES `work_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
