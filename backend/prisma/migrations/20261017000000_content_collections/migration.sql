-- Content collections: campaigns + folders (both = a named Google Drive folder
-- the tenant files content under). MySQL 8 — NO `IF NOT EXISTS` by design
-- (one-time phpMyAdmin Import). Additive only.
CREATE TABLE content_collections (
  id                 INT          NOT NULL AUTO_INCREMENT,
  company_id         INT          NOT NULL,
  kind               VARCHAR(16)  NOT NULL DEFAULT 'campaign',
  name               VARCHAR(160) NOT NULL,
  color              VARCHAR(16)  NULL,
  description        TEXT         NULL,
  gdrive_folder_id   VARCHAR(128) NULL,
  launch_date        DATETIME(3)  NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_by_user_id INT          NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX content_collections_company_id_kind_idx (company_id, kind)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

ALTER TABLE content_items
  ADD COLUMN collection_id INT NULL,
  ADD INDEX content_items_company_id_collection_id_idx (company_id, collection_id);
