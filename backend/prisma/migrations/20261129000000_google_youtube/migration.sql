-- Google Ads + YouTube for Growth. Additive only.
ALTER TABLE `ad_entities` ADD COLUMN `youtube_video_id` VARCHAR(16) NULL;

CREATE TABLE `youtube_channels` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `channel_id` VARCHAR(32) NOT NULL,
  `title` VARCHAR(255) NULL,
  `handle` VARCHAR(128) NULL,
  `thumb_url` TEXT NULL,
  `uploads_playlist_id` VARCHAR(64) NULL,
  `token_encrypted` TEXT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `subscribers` INT NOT NULL DEFAULT 0,
  `views` BIGINT NOT NULL DEFAULT 0,
  `videos` INT NOT NULL DEFAULT 0,
  `last_attempt_at` DATETIME(3) NULL,
  `last_success_at` DATETIME(3) NULL,
  `last_error` VARCHAR(500) NULL,
  `connected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `youtube_channels_company_id_channel_id_key`(`company_id`, `channel_id`),
  INDEX `youtube_channels_company_id_status_idx`(`company_id`, `status`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `youtube_channel_daily` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `channel_id` INT NOT NULL,
  `date` DATE NOT NULL,
  `views` INT NOT NULL DEFAULT 0,
  `watch_minutes` INT NOT NULL DEFAULT 0,
  `subs_gained` INT NOT NULL DEFAULT 0,
  `subs_lost` INT NOT NULL DEFAULT 0,
  `likes` INT NOT NULL DEFAULT 0,
  `comments` INT NOT NULL DEFAULT 0,
  `shares` INT NOT NULL DEFAULT 0,
  UNIQUE INDEX `youtube_channel_daily_channel_id_date_key`(`channel_id`, `date`),
  INDEX `youtube_channel_daily_company_id_date_idx`(`company_id`, `date`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `youtube_videos` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `channel_id` INT NOT NULL,
  `video_id` VARCHAR(16) NOT NULL,
  `title` VARCHAR(255) NULL,
  `thumb_url` TEXT NULL,
  `published_at` DATETIME(3) NULL,
  `duration_s` INT NULL,
  `privacy` VARCHAR(16) NULL,
  `views` BIGINT NOT NULL DEFAULT 0,
  `likes` INT NOT NULL DEFAULT 0,
  `comments` INT NOT NULL DEFAULT 0,
  `used_in_ads` BOOLEAN NOT NULL DEFAULT false,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `youtube_videos_company_id_video_id_key`(`company_id`, `video_id`),
  INDEX `youtube_videos_channel_id_idx`(`channel_id`),
  PRIMARY KEY (`id`)
);
