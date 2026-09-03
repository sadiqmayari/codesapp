-- Remove the engagement engine (work-item routing / FSM / told-ledger) and the
-- never-wired transactional outbox.
--
-- The engine was built, flag-enabled for one tenant, and last routed a message
-- on 2026-08-17; it has been dormant since (its host path, AI auto-reply, is
-- off). The outbox never had a caller and holds zero rows. Both are deleted in
-- full rather than left as dead schema.
--
-- Data removed: work_items (~281), told_ledger (~8), messages.work_item_id /
-- messages.seq (~616 tagged), companies.engagement_mode, and the engagement
-- event rows (~144k, overwhelmingly repeated handoff SLA-breach noise from the
-- sweep re-escalating the same stale items every 5 minutes).
--
-- `events` itself is KEPT — it still powers the AI audit timeline
-- ("why this reply?") and order idempotency.

-- 1. Purge engagement-authored events (keeps conversation.handoff, order.*,
--    tool.failed, image.routed — the rows the audit UI and metrics read).
DELETE FROM `events`
WHERE `aggregate_type` = 'WORK_ITEM'
   OR `type` LIKE 'work_item.%'
   OR `type` = 'state.transition'
   OR `type` LIKE 'handoff.sla%'
   OR `type` = 'response.confidence';

-- 2. Message tagging columns. The FK must go FIRST: MariaDB refuses to drop an
--    index that a foreign key depends on, so dropping the index before the
--    constraint fails with errno 150.
ALTER TABLE `messages` DROP FOREIGN KEY `messages_work_item_id_fkey`;
DROP INDEX `messages_work_item_id_timestamp_idx` ON `messages`;
DROP INDEX `messages_conversation_id_seq_idx` ON `messages`;
ALTER TABLE `messages` DROP COLUMN `work_item_id`;
ALTER TABLE `messages` DROP COLUMN `seq`;

-- 3. Per-tenant engagement mode.
ALTER TABLE `companies` DROP COLUMN `engagement_mode`;

-- 4. Engine tables.
DROP TABLE IF EXISTS `told_ledger`;
DROP TABLE IF EXISTS `work_items`;

-- 5. Never-wired transactional outbox (0 rows in production).
DROP TABLE IF EXISTS `outbox`;

-- 6. Platform settings that drove the rollout.
DELETE FROM `platform_settings`
WHERE `key` IN ('engagement_engine_company_ids', 'engagement_engine_mode');
