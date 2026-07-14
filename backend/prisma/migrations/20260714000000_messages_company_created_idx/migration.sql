-- Analytics range queries filter messages by (company_id, created_at). Without
-- this composite index every dashboard/analytics query full-scanned the
-- tenant's messages, which made picking a wider period slow. Added ONLINE so it
-- doesn't lock the table on a large messages table.
ALTER TABLE `messages`
  ADD INDEX `messages_company_id_created_at_idx` (`company_id`, `created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
