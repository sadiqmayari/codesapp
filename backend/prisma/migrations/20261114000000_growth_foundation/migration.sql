-- Growth module foundation (renames the Ad Report → Growth).
-- 1) Multi-platform ad accounts / entities / ad-grain daily insights + FX.
-- 2) Attribution touchpoints + per-order growth facts + attribution credits.
-- 3) Copies the existing Meta connection + campaign-grain spend across, then
--    drops the legacy ad tables/columns (ad_spend_daily, ad_campaigns,
--    product_targets, companies.meta_ads_*). Copy runs BEFORE every drop.

CREATE TABLE `ad_accounts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `platform` VARCHAR(16) NOT NULL,
  `external_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NULL,
  `currency` VARCHAR(8) NULL,
  `timezone` VARCHAR(64) NULL,
  `token_encrypted` TEXT NULL,
  `store_id` INT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `sync_interval_min` INT NULL,
  `capi_enabled` BOOLEAN NOT NULL DEFAULT false,
  `capi_dataset_id` VARCHAR(64) NULL,
  `connected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_attempt_at` DATETIME(3) NULL,
  `last_success_at` DATETIME(3) NULL,
  `last_error` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `ad_accounts_company_id_platform_external_id_key`(`company_id`, `platform`, `external_id`),
  INDEX `ad_accounts_company_id_status_idx`(`company_id`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ad_accounts` ADD CONSTRAINT `ad_accounts_company_id_fkey`
  FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `ad_entities` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `account_id` INT NOT NULL,
  `platform` VARCHAR(16) NOT NULL,
  `level` VARCHAR(8) NOT NULL,
  `external_id` VARCHAR(64) NOT NULL,
  `parent_external_id` VARCHAR(64) NULL,
  `campaign_id` VARCHAR(64) NULL,
  `name` VARCHAR(512) NULL,
  `status` VARCHAR(32) NULL,
  `objective` VARCHAR(64) NULL,
  `daily_budget` DECIMAL(14, 2) NULL,
  `creative_thumb_url` TEXT NULL,
  `destination_url` TEXT NULL,
  `advertised_handle` VARCHAR(255) NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ad_entities_account_id_level_external_id_key`(`account_id`, `level`, `external_id`),
  INDEX `ad_entities_company_id_level_idx`(`company_id`, `level`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ad_insights_daily` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `account_id` INT NOT NULL,
  `platform` VARCHAR(16) NOT NULL,
  `date` DATE NOT NULL,
  `campaign_id` VARCHAR(64) NOT NULL,
  `adset_id` VARCHAR(64) NULL,
  `ad_id` VARCHAR(64) NOT NULL,
  `currency` VARCHAR(8) NULL,
  `spend` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `spend_base` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `impressions` INT NOT NULL DEFAULT 0,
  `reach` INT NOT NULL DEFAULT 0,
  `clicks` INT NOT NULL DEFAULT 0,
  `link_clicks` INT NOT NULL DEFAULT 0,
  `video_3s` INT NOT NULL DEFAULT 0,
  `thruplay` INT NOT NULL DEFAULT 0,
  `add_to_cart` INT NOT NULL DEFAULT 0,
  `checkouts` INT NOT NULL DEFAULT 0,
  `purchases` INT NOT NULL DEFAULT 0,
  `purchase_value` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `purchase_value_base` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `messaging_started` INT NOT NULL DEFAULT 0,
  `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ad_insights_daily_account_id_date_ad_id_key`(`account_id`, `date`, `ad_id`),
  INDEX `ad_insights_daily_company_id_date_idx`(`company_id`, `date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `fx_rates_daily` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `base` VARCHAR(8) NOT NULL,
  `quote` VARCHAR(8) NOT NULL,
  `date` DATE NOT NULL,
  `rate` DECIMAL(18, 8) NOT NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'open.er-api.com',
  UNIQUE INDEX `fx_rates_daily_base_quote_date_key`(`base`, `quote`, `date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_touchpoints` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `order_gid` VARCHAR(255) NOT NULL,
  `seq` INT NOT NULL,
  `occurred_at` DATETIME(3) NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `platform` VARCHAR(16) NULL,
  `utm_source` VARCHAR(255) NULL,
  `utm_medium` VARCHAR(255) NULL,
  `utm_campaign` VARCHAR(512) NULL,
  `utm_content` VARCHAR(512) NULL,
  `click_id_type` VARCHAR(16) NULL,
  `ad_ref` VARCHAR(191) NULL,
  `landing_page` TEXT NULL,
  `referrer` TEXT NULL,
  UNIQUE INDEX `order_touchpoints_company_id_order_gid_seq_key`(`company_id`, `order_gid`, `seq`),
  INDEX `order_touchpoints_company_id_order_gid_idx`(`company_id`, `order_gid`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `growth_order_facts` (
  `company_id` INT NOT NULL,
  `order_gid` VARCHAR(255) NOT NULL,
  `store_id` INT NULL,
  `order_date` DATE NOT NULL,
  `order_month` VARCHAR(7) NOT NULL,
  `cohort_month` VARCHAR(7) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `lifecycle` VARCHAR(16) NOT NULL,
  `payment` VARCHAR(8) NOT NULL,
  `gross` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `net` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `discounts` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `cogs` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `units` INT NOT NULL DEFAULT 0,
  `units_no_cost` INT NOT NULL DEFAULT 0,
  `ship_cost` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `ship_estimated` BOOLEAN NOT NULL DEFAULT false,
  `fees` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `has_breakdown` BOOLEAN NOT NULL DEFAULT false,
  `p_deliver` DECIMAL(6, 4) NOT NULL DEFAULT 0,
  `city` VARCHAR(128) NULL,
  `courier` VARCHAR(32) NULL,
  `customer_key` VARCHAR(255) NULL,
  `is_new` BOOLEAN NOT NULL DEFAULT false,
  `ft_channel` VARCHAR(32) NULL,
  `ft_platform` VARCHAR(16) NULL,
  `ft_campaign_id` VARCHAR(64) NULL,
  `lt_channel` VARCHAR(32) NULL,
  `lt_platform` VARCHAR(16) NULL,
  `lt_campaign_id` VARCHAR(64) NULL,
  `touches` INT NOT NULL DEFAULT 0,
  `days_to_convert` INT NULL,
  `version` BIGINT NOT NULL DEFAULT 0,
  `capi_sent_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `growth_order_facts_company_id_order_date_idx`(`company_id`, `order_date`),
  INDEX `growth_order_facts_company_id_updated_at_idx`(`company_id`, `updated_at`),
  PRIMARY KEY (`company_id`, `order_gid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `growth_attribution` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `order_gid` VARCHAR(255) NOT NULL,
  `order_date` DATE NOT NULL,
  `model` VARCHAR(12) NOT NULL,
  `win` INT NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `platform` VARCHAR(16) NULL,
  `campaign_id` VARCHAR(64) NULL,
  `adset_id` VARCHAR(64) NULL,
  `ad_id` VARCHAR(64) NULL,
  `credit` DECIMAL(6, 4) NOT NULL,
  `net` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `expected_net` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `delivered` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `is_new` BOOLEAN NOT NULL DEFAULT false,
  `version` BIGINT NOT NULL DEFAULT 0,
  INDEX `growth_attribution_company_id_model_win_order_date_idx`(`company_id`, `model`, `win`, `order_date`),
  INDEX `growth_attribution_company_id_order_gid_idx`(`company_id`, `order_gid`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Copy the existing Meta connection + spend ────────────────────────────────
INSERT INTO `ad_accounts`
  (`company_id`, `platform`, `external_id`, `currency`, `token_encrypted`, `sync_interval_min`,
   `connected_at`, `last_attempt_at`, `last_success_at`, `status`, `created_at`, `updated_at`)
SELECT `id`, 'meta', `meta_ad_account_id`, `meta_ads_currency`, `meta_ads_token_encrypted`,
       `meta_ads_sync_interval_minutes`, COALESCE(`meta_ads_connected_at`, NOW(3)),
       `meta_ads_sync_last_at`, `meta_ads_sync_last_at`, 'active', NOW(3), NOW(3)
  FROM `companies`
 WHERE `meta_ad_account_id` IS NOT NULL AND `meta_ad_account_id` <> '';

INSERT INTO `ad_entities`
  (`company_id`, `account_id`, `platform`, `level`, `external_id`, `campaign_id`, `name`, `advertised_handle`, `updated_at`)
SELECT d.`company_id`, a.`id`, 'meta', 'campaign', d.`campaign_id`, d.`campaign_id`,
       MAX(d.`campaign_name`), MAX(c.`advertised_handle`), NOW(3)
  FROM `ad_spend_daily` d
  JOIN `ad_accounts` a ON a.`company_id` = d.`company_id` AND a.`platform` = 'meta'
  LEFT JOIN `ad_campaigns` c ON c.`company_id` = d.`company_id` AND c.`campaign_id` = d.`campaign_id`
 GROUP BY d.`company_id`, a.`id`, d.`campaign_id`;

INSERT INTO `ad_insights_daily`
  (`company_id`, `account_id`, `platform`, `date`, `campaign_id`, `ad_id`, `currency`,
   `spend`, `spend_base`, `impressions`, `clicks`, `purchases`, `purchase_value`, `purchase_value_base`, `synced_at`)
SELECT d.`company_id`, a.`id`, 'meta', d.`spend_date`, d.`campaign_id`, CONCAT('c:', d.`campaign_id`), d.`currency`,
       d.`spend`, d.`spend`, COALESCE(d.`impressions`, 0), COALESCE(d.`clicks`, 0),
       COALESCE(d.`meta_purchases`, 0), COALESCE(d.`meta_conversion_value`, 0), COALESCE(d.`meta_conversion_value`, 0), d.`synced_at`
  FROM `ad_spend_daily` d
  JOIN `ad_accounts` a ON a.`company_id` = d.`company_id` AND a.`platform` = 'meta';

-- ── Drop the legacy ad tables / columns ──────────────────────────────────────
DROP TABLE `product_targets`;
DROP TABLE `ad_campaigns`;
DROP TABLE `ad_spend_daily`;

ALTER TABLE `companies`
  DROP COLUMN `meta_ads_token_encrypted`,
  DROP COLUMN `meta_ad_account_id`,
  DROP COLUMN `meta_ads_currency`,
  DROP COLUMN `meta_ads_connected_at`,
  DROP COLUMN `meta_ads_sync_last_at`,
  DROP COLUMN `meta_ads_sync_interval_minutes`;
