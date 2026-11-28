-- Publish / schedule posts to Facebook Pages + Instagram (own Meta app).
CREATE TABLE `social_posts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `content_item_id` INT NULL,
  `caption` TEXT NOT NULL,
  `media` JSON NOT NULL,
  `targets` JSON NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'draft',
  `scheduled_at` DATETIME(3) NULL,
  `published_at` DATETIME(3) NULL,
  `results` JSON NULL,
  `last_error` VARCHAR(500) NULL,
  `created_by_user_id` INT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `social_posts_company_id_status_scheduled_at_idx`(`company_id`, `status`, `scheduled_at`),
  INDEX `social_posts_company_id_content_item_id_idx`(`company_id`, `content_item_id`),
  PRIMARY KEY (`id`)
);
