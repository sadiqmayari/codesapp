-- PR module tables. MySQL 8 — NO `IF NOT EXISTS` by design (one-time
-- phpMyAdmin Import). Additive only (new tables, no change to existing tables).
CREATE TABLE pr_campaigns (
  id           INT          NOT NULL AUTO_INCREMENT,
  company_id   INT          NOT NULL,
  name         VARCHAR(160) NOT NULL,
  intro        TEXT         NULL,
  public_token VARCHAR(40)  NOT NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX pr_campaigns_public_token_key (public_token),
  INDEX pr_campaigns_company_id_idx (company_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE pr_submissions (
  id                 INT          NOT NULL AUTO_INCREMENT,
  company_id         INT          NOT NULL,
  campaign_id        INT          NOT NULL,
  influencer_name    VARCHAR(160) NOT NULL,
  phone              VARCHAR(40)  NULL,
  email              VARCHAR(255) NULL,
  city               VARCHAR(120) NULL,
  address            TEXT         NULL,
  instagram          VARCHAR(160) NULL,
  tiktok             VARCHAR(160) NULL,
  follower_count     INT          NULL,
  product_wishlist   TEXT         NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'new',
  decided_by_user_id INT          NULL,
  decided_at         DATETIME(3)  NULL,
  shopify_order_gid  VARCHAR(64)  NULL,
  order_name         VARCHAR(64)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX pr_submissions_company_status_idx (company_id, status),
  INDEX pr_submissions_campaign_idx (campaign_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
