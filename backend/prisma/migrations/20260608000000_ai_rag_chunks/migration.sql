-- RAG retrieval index: one embedded chunk per product/policy per tenant.
CREATE TABLE `ai_knowledge_chunks` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `company_id`  INT NOT NULL,
  `source_type` VARCHAR(32) NOT NULL,
  `source_id`   VARCHAR(191) NOT NULL,
  `title`       VARCHAR(255) NOT NULL,
  `content`     TEXT NOT NULL,
  `embedding`   LONGBLOB NOT NULL,
  `dim`         INT NOT NULL DEFAULT 0,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ai_knowledge_chunks_company_id_source_type_source_id_key` (`company_id`, `source_type`, `source_id`),
  INDEX `ai_knowledge_chunks_company_id_idx` (`company_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ai_knowledge_chunks`
  ADD CONSTRAINT `ai_knowledge_chunks_company_id_fkey`
  FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
