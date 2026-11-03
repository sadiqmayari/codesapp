-- PR module: influencer videos. One submission (campaign package) can have MANY
-- videos — the public form commits the influencer to 2-3. Replaces the legacy
-- single pr_submissions.post_url. MySQL/MariaDB — NO `IF NOT EXISTS` by design
-- (one-time phpMyAdmin Import). Additive only (new table + backfill).
CREATE TABLE pr_videos (
  id            INT          NOT NULL AUTO_INCREMENT,
  company_id    INT          NOT NULL,
  submission_id INT          NOT NULL,
  influencer_id INT          NULL,
  url           VARCHAR(500) NOT NULL,
  platform      VARCHAR(20)  NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'posted',
  notes         TEXT         NULL,
  posted_at     DATETIME(3)  NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX pr_videos_company_id_idx (company_id),
  INDEX pr_videos_submission_id_idx (submission_id),
  INDEX pr_videos_influencer_id_idx (influencer_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Backfill: carry every existing single post_url into its own video row so no
-- tracked content is lost. status 'posted' (post_url was only ever set when the
-- outcome was marked posted); keep the original posted_at.
INSERT INTO pr_videos
  (company_id, submission_id, influencer_id, url, status, posted_at, created_at, updated_at)
SELECT
  company_id,
  id,
  influencer_id,
  post_url,
  'posted',
  posted_at,
  COALESCE(posted_at, created_at),
  NOW(3)
FROM pr_submissions
WHERE post_url IS NOT NULL AND post_url <> '';
