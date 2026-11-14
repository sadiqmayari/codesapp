-- Monthly net sales target (Growth → Forecast). Additive.
CREATE TABLE `sales_targets` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `store_id` INT NOT NULL DEFAULT 0,
  `net_sales_target` DECIMAL(14, 2) NOT NULL,
  `orders_target` INT NULL,
  `ad_budget` DECIMAL(14, 2) NULL,
  `updated_by` INT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `sales_targets_company_id_month_store_id_key`(`company_id`, `month`, `store_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
