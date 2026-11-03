-- Ad attribution: capture UTM params on web orders so the Ad Report can
-- attribute Meta spend to the products a campaign actually sold (utm_campaign =
-- the Meta campaign name). Additive, nullable. Only web orders carry these;
-- WhatsApp/manual orders leave them null.
ALTER TABLE shopify_orders
  ADD COLUMN landing_site TEXT         NULL,
  ADD COLUMN utm_source   VARCHAR(255) NULL,
  ADD COLUMN utm_medium   VARCHAR(255) NULL,
  ADD COLUMN utm_campaign VARCHAR(512) NULL,
  ADD COLUMN utm_content  VARCHAR(512) NULL;

CREATE INDEX shopify_orders_company_id_utm_campaign_idx
  ON shopify_orders (company_id, utm_campaign);
