-- Public per-order tracking page.
-- companies.public_slug: URL-safe tenant handle for the branded tracking page path.
-- shopify_orders.public_token: per-order secret gating the public page.

ALTER TABLE `companies` ADD COLUMN `public_slug` VARCHAR(80) NULL;
CREATE UNIQUE INDEX `companies_public_slug_key` ON `companies`(`public_slug`);

ALTER TABLE `shopify_orders` ADD COLUMN `public_token` VARCHAR(40) NULL;

-- Backfill public_slug from a slugified company_name, de-duped with a numeric
-- suffix. Companies whose slug would collide keep NULL for now (a tenant can
-- set one in Settings); the app never depends on every tenant having a slug.
UPDATE `companies` c
JOIN (
  SELECT
    id,
    base_slug,
    ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM (
    SELECT
      id,
      NULLIF(
        TRIM(BOTH '-' FROM
          REGEXP_REPLACE(
            REGEXP_REPLACE(LOWER(company_name), '[^a-z0-9]+', '-'),
            '-+', '-'
          )
        ),
        ''
      ) AS base_slug
    FROM `companies`
  ) s
  WHERE base_slug IS NOT NULL
) g ON c.id = g.id
SET c.public_slug = IF(g.rn = 1, g.base_slug, CONCAT(g.base_slug, '-', g.rn))
WHERE c.public_slug IS NULL
  AND CHAR_LENGTH(IF(g.rn = 1, g.base_slug, CONCAT(g.base_slug, '-', g.rn))) <= 80;
