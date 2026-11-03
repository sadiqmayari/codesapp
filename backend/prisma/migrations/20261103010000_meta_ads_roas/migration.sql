-- Meta Ads → product ROAS report. Additive only (new columns + two new tables).
-- MySQL/MariaDB, no `IF NOT EXISTS` by design (one-time phpMyAdmin Import on prod;
-- pair with a redeploy WITH `npm install` so the Prisma client regenerates).

-- Company: Meta Ads connection. meta_ads_token_encrypted is an OPTIONAL override
-- (NULL = reuse the onboarding/primary WhatsApp token). meta_ad_account_id (numeric)
-- is what marks Ads as "connected".
ALTER TABLE companies
  ADD COLUMN meta_ads_token_encrypted TEXT        NULL,
  ADD COLUMN meta_ad_account_id       VARCHAR(64) NULL,
  ADD COLUMN meta_ads_currency        VARCHAR(8)  NULL,
  ADD COLUMN meta_ads_connected_at    DATETIME(3) NULL,
  ADD COLUMN meta_ads_sync_last_at    DATETIME(3) NULL;

-- Daily Meta spend, stored per CAMPAIGN per DAY (campaign→product match is done
-- at report time, so remapping needs no re-sync).
CREATE TABLE ad_spend_daily (
  id            INT           NOT NULL AUTO_INCREMENT,
  company_id    INT           NOT NULL,
  spend_date    DATE          NOT NULL,
  campaign_id   VARCHAR(64)   NOT NULL,
  campaign_name VARCHAR(512)  NOT NULL,
  spend         DECIMAL(12,2) NOT NULL,
  impressions   INT           NULL,
  clicks        INT           NULL,
  currency      VARCHAR(8)    NULL,
  synced_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE INDEX ad_spend_daily_company_id_spend_date_campaign_id_key (company_id, spend_date, campaign_id),
  INDEX ad_spend_daily_company_id_spend_date_idx (company_id, spend_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Per-product monthly target (value + units). product_key = the Shopify
-- line-item title (there is no product_id in line_items). Keyed by "YYYY-MM".
CREATE TABLE product_targets (
  id           INT           NOT NULL AUTO_INCREMENT,
  company_id   INT           NOT NULL,
  product_key  VARCHAR(255)  NOT NULL,
  period_month VARCHAR(7)    NOT NULL,
  target_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  target_units INT           NOT NULL DEFAULT 0,
  updated_at   DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX product_targets_company_id_product_key_period_month_key (company_id, product_key, period_month),
  INDEX product_targets_company_id_period_month_idx (company_id, period_month)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
