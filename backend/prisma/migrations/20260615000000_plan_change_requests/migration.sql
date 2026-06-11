-- Tenant-initiated plan-change / upgrade requests reviewed by a super-admin.
CREATE TABLE `plan_change_requests` (
  `id`                        INT          NOT NULL AUTO_INCREMENT,
  `company_id`                INT          NOT NULL,
  `requested_subscription_id` INT          NULL,
  `current_subscription_id`   INT          NULL,
  `note`                      TEXT         NULL,
  `status`                    VARCHAR(16)  NOT NULL DEFAULT 'pending',
  `created_by_user_id`        INT          NULL,
  `resolved_at`               DATETIME(3)  NULL,
  `resolution_note`           TEXT         NULL,
  `created_at`                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`                DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `plan_change_requests_company_id_status_idx` (`company_id`, `status`),
  INDEX `plan_change_requests_status_idx` (`status`),
  CONSTRAINT `plan_change_requests_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
