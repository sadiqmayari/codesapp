-- Order Idempotency Protection (enterprise hardening #2).
--
-- WHY: `createOrder()` is the single chokepoint for BOTH the manual Create-order
-- modal and the autonomous AI agent. A queue retry, a worker crash mid-create, a
-- duplicated WhatsApp webhook, or a Shopify request that times out AFTER the order
-- was actually placed can each drive a second identical order = a real duplicate
-- charge/fulfilment. The existing per-conversation `ai_last_order_signature` guard
-- only covers the AI path within one conversation. This table is a dedicated,
-- cross-path, cross-conversation fingerprint ledger whose UNIQUE(company_id, hash)
-- constraint is the ATOMIC race guard (two concurrent workers cannot both insert
-- the same fingerprint — the DB rejects the loser).
--
-- Additive + backward compatible: a brand-new table, no change to existing
-- columns, no backfill, zero downtime. Existing tenants are unaffected until an
-- order is created (which then simply reserves a row).
CREATE TABLE `pending_order_hashes` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `company_id`      INT NOT NULL,
  -- Nullable: manual orders from the modal have no conversation context.
  `conversation_id` INT NULL,
  -- SHA-256 (hex) of normalizedPhone | normalizedAddress | normalizedCart | payment.
  `hash`            CHAR(64) NOT NULL,
  -- 'in_flight' (reserved, create in progress) | 'created' | 'failed'.
  `status`          VARCHAR(16) NOT NULL DEFAULT 'in_flight',
  -- Populated on finalize() so a duplicate hit can return the SAME order.
  `order_gid`       VARCHAR(64) NULL,
  `order_name`      VARCHAR(64) NULL,
  `admin_url`       VARCHAR(512) NULL,
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Dedup window boundary. A `created` row is a duplicate only while fresh; a
  -- stale row is reclaimed so a legitimate later reorder is allowed. An
  -- `in_flight`/`failed` row blocks a concurrent/immediate retry while fresh
  -- (ambiguous-Shopify-timeout mitigation) and is reclaimable once stale.
  `expires_at`      DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `pending_order_hashes_company_id_hash_key` (`company_id`, `hash`),
  INDEX `pending_order_hashes_expires_at_idx` (`expires_at`),
  INDEX `pending_order_hashes_company_id_conversation_id_idx` (`company_id`, `conversation_id`)
) DEFAULT CHARACTER SET utf8mb4;
