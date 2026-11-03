-- Ad Report v2: dual attribution (Meta-native conversions) + per-tenant sync
-- schedule + campaign→advertised-product map. Additive only.

-- Meta-native pixel attribution per campaign/day (from Ads Insights).
ALTER TABLE ad_spend_daily
  ADD COLUMN meta_purchases        INT           NULL,
  ADD COLUMN meta_conversion_value DECIMAL(12,2) NULL;

-- Per-tenant auto-sync cadence for the Meta spend pull.
ALTER TABLE companies
  ADD COLUMN meta_ads_sync_interval_minutes INT NULL;

-- Campaign → advertised product (parsed from the ad's destination URL).
CREATE TABLE ad_campaigns (
  id                INT          NOT NULL AUTO_INCREMENT,
  company_id        INT          NOT NULL,
  campaign_id       VARCHAR(64)  NOT NULL,
  campaign_name     VARCHAR(512) NULL,
  advertised_handle VARCHAR(255) NULL,
  advertised_title  VARCHAR(255) NULL,
  synced_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE INDEX ad_campaigns_company_id_campaign_id_key (company_id, campaign_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
