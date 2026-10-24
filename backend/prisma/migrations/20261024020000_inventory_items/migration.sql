-- Inventory module tables: product/variant mirror + stock movement ledger.
-- MySQL 8 — NO `IF NOT EXISTS` by design (one-time phpMyAdmin Import).
-- Additive only.

CREATE TABLE inventory_products (
  id                  INT           NOT NULL AUTO_INCREMENT,
  company_id          INT           NOT NULL,
  shopify_store_id    INT           NOT NULL,
  shopify_product_gid VARCHAR(120)  NOT NULL,
  title               VARCHAR(400)  NOT NULL,
  handle              VARCHAR(255)  NULL,
  product_type        VARCHAR(160)  NULL,
  vendor              VARCHAR(160)  NULL,
  image_url           VARCHAR(1000) NULL,
  status              VARCHAR(16)   NULL,
  synced_at           DATETIME(3)   NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX inventory_products_company_store_gid_key (company_id, shopify_store_id, shopify_product_gid),
  INDEX inventory_products_company_store_idx (company_id, shopify_store_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE inventory_variants (
  id                         INT            NOT NULL AUTO_INCREMENT,
  company_id                 INT            NOT NULL,
  shopify_store_id           INT            NOT NULL,
  product_id                 INT            NOT NULL,
  shopify_variant_gid        VARCHAR(120)   NOT NULL,
  shopify_inventory_item_gid VARCHAR(120)   NULL,
  shopify_inventory_item_id  BIGINT         NULL,
  sku                        VARCHAR(160)   NULL,
  barcode                    VARCHAR(160)   NULL,
  variant_title              VARCHAR(255)   NULL,
  price                      DECIMAL(12, 2) NULL,
  shopify_qty                INT            NOT NULL DEFAULT 0,
  local_qty                  INT            NOT NULL DEFAULT 0,
  last_pushed_qty            INT            NULL,
  last_pushed_at             DATETIME(3)    NULL,
  qty_synced_at              DATETIME(3)    NULL,
  item_code                  VARCHAR(80)    NULL,
  alias                      VARCHAR(120)   NULL,
  reorder_level              INT            NOT NULL DEFAULT 0,
  cost_price                 DECIMAL(12, 2) NULL,
  shelf_location             VARCHAR(120)   NULL,
  category                   VARCHAR(120)   NULL,
  notes                      TEXT           NULL,
  created_at                 DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX inventory_variants_company_store_gid_key (company_id, shopify_store_id, shopify_variant_gid),
  INDEX inventory_variants_company_item_code_idx (company_id, item_code),
  INDEX inventory_variants_company_sku_idx (company_id, sku),
  INDEX inventory_variants_company_inv_item_idx (company_id, shopify_inventory_item_id),
  INDEX inventory_variants_product_idx (product_id),
  CONSTRAINT inventory_variants_product_fk FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE inventory_movements (
  id               INT         NOT NULL AUTO_INCREMENT,
  company_id       INT         NOT NULL,
  shopify_store_id INT         NULL,
  variant_id       INT         NOT NULL,
  delta            INT         NOT NULL,
  qty_after        INT         NOT NULL,
  reason           VARCHAR(24) NOT NULL,
  ref              VARCHAR(120) NULL,
  actor_user_id    INT         NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX inventory_movements_company_variant_idx (company_id, variant_id),
  INDEX inventory_movements_company_reason_ref_idx (company_id, reason, ref),
  CONSTRAINT inventory_movements_variant_fk FOREIGN KEY (variant_id) REFERENCES inventory_variants (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
