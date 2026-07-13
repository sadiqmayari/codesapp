-- Click-to-WhatsApp attribution: capture the Meta `referral` object that Meta
-- attaches to the FIRST inbound message when a chat starts from an ad / FB-IG
-- post. Stored first-touch (never overwritten) on the conversation.
--   referral            = full referral payload (JSON): headline, body,
--                         source_type/id/url, media urls, our thumb_path, ctwa_clid
--   referral_source_id  = the ad/post id (indexed, for attribution grouping)
--   referral_at         = when the referred chat started
ALTER TABLE `conversations`
  ADD COLUMN `referral` JSON NULL,
  ADD COLUMN `referral_source_id` VARCHAR(191) NULL,
  ADD COLUMN `referral_at` DATETIME(3) NULL;

CREATE INDEX `conversations_company_id_referral_source_id_idx`
  ON `conversations` (`company_id`, `referral_source_id`);
