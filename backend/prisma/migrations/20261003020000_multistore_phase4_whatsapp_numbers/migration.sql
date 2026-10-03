-- Multi-Number — Stage 2 backfill. Creates ONE primary whatsapp_numbers row per
-- company that already has a Cloud API connection, moving the access token OUT of
-- companies.onboarding_status JSON into its own encrypted column (copied verbatim —
-- same EncryptionService key, still decryptable). Idempotent.
--
-- webhook_key is COALESCE(companies.webhook_key, generated) so an already-registered
-- Meta callback keeps routing; the encrypted app-secret + verify-token are copied.
-- Companies with no phone_number_id are skipped (no number to connect).
--
-- COLLATION NOTE: like the Shopify backfill, every string expression is pinned to
-- utf8mb4_unicode_ci so mixed source collations + literals never throw error 1267.

INSERT INTO `whatsapp_numbers`
  (`company_id`, `waba_id`, `phone_number_id`, `display_phone_number`, `label`,
   `access_token_encrypted`, `webhook_key`, `webhook_app_secret_encrypted`,
   `webhook_verify_token`, `onboarding_status`, `is_primary`, `status`,
   `created_at`, `updated_at`)
SELECT
  c.id,
  c.waba_id COLLATE utf8mb4_unicode_ci,
  c.phone_number_id COLLATE utf8mb4_unicode_ci,
  NULL,
  NULL,
  COALESCE(
    JSON_UNQUOTE(JSON_EXTRACT(c.onboarding_status, '$.metaAccessTokenEncrypted')) COLLATE utf8mb4_unicode_ci,
    JSON_UNQUOTE(JSON_EXTRACT(c.onboarding_status, '$.metaAccessToken')) COLLATE utf8mb4_unicode_ci
  ),
  COALESCE(c.webhook_key COLLATE utf8mb4_unicode_ci, CONCAT('wa-', REPLACE(UUID(), '-', '')) COLLATE utf8mb4_unicode_ci),
  c.webhook_app_secret_encrypted COLLATE utf8mb4_unicode_ci,
  c.webhook_verify_token COLLATE utf8mb4_unicode_ci,
  COALESCE(c.onboarding_status, JSON_OBJECT()),
  1,
  'active',
  NOW(3),
  NOW(3)
FROM `companies` c
WHERE c.phone_number_id IS NOT NULL
  AND TRIM(c.phone_number_id COLLATE utf8mb4_unicode_ci) <> ''
  AND NOT EXISTS (SELECT 1 FROM `whatsapp_numbers` w WHERE w.company_id = c.id);

-- Per-message number stamp (nullable; historical rows stay null).
ALTER TABLE `messages` ADD COLUMN `whatsapp_number_id` INTEGER NULL;
CREATE INDEX `messages_whatsapp_number_id_idx` ON `messages`(`whatsapp_number_id`);

-- Point existing conversations at the primary number so replies have a default.
UPDATE `conversations` cv
JOIN `whatsapp_numbers` w ON w.company_id = cv.company_id AND w.is_primary = 1
SET cv.last_whatsapp_number_id = w.id
WHERE cv.last_whatsapp_number_id IS NULL;
