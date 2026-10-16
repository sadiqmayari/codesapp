-- PR: campaign slugs (for pr.codentra.pk/<tenant>/<slug>) + influencer CRM.
-- MySQL 8 — one-time phpMyAdmin Import. Additive.

-- Campaign slug (unique per company). Backfill existing rows with campaign-<id>
-- (the exec can rename later; new campaigns slugify from the name).
ALTER TABLE `pr_campaigns`
  ADD COLUMN `slug` VARCHAR(80) NULL;
UPDATE `pr_campaigns` SET `slug` = CONCAT('campaign-', `id`) WHERE `slug` IS NULL;
CREATE UNIQUE INDEX `pr_campaigns_company_slug_key` ON `pr_campaigns` (`company_id`, `slug`);

-- Influencer CRM profiles.
CREATE TABLE pr_influencers (
  id              INT          NOT NULL AUTO_INCREMENT,
  company_id      INT          NOT NULL,
  dedup_key       VARCHAR(190) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  phone           VARCHAR(40)  NULL,
  email           VARCHAR(255) NULL,
  city            VARCHAR(120) NULL,
  address         TEXT         NULL,
  instagram       VARCHAR(160) NULL,
  tiktok          VARCHAR(160) NULL,
  other_social    VARCHAR(255) NULL,
  follower_count  INT          NULL,
  niche           VARCHAR(120) NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  notes           TEXT         NULL,
  tags            JSON         NULL,
  packages_count  INT          NOT NULL DEFAULT 0,
  first_seen_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_package_at DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX pr_influencers_company_dedup_key (company_id, dedup_key),
  INDEX pr_influencers_company_status_idx (company_id, status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Link submissions to profiles + post-outcome tracking.
ALTER TABLE `pr_submissions`
  ADD COLUMN `influencer_id` INT         NULL,
  ADD COLUMN `outcome`       VARCHAR(16) NULL,
  ADD COLUMN `post_url`      VARCHAR(500) NULL,
  ADD COLUMN `posted_at`     DATETIME(3) NULL,
  ADD INDEX `pr_submissions_influencer_idx` (`influencer_id`);
