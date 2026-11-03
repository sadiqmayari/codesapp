-- Ad Report v3 (blended profit analytics): capture the order financial breakdown
-- (gross/net/discount/tax/shipping) + Shopify product cost (COGS) for the profit
-- waterfall. Additive, nullable. Backfillable; pre-v3 orders show gross=net.
ALTER TABLE shopify_orders
  ADD COLUMN subtotal_price  DECIMAL(12,2) NULL,
  ADD COLUMN total_discounts DECIMAL(12,2) NULL,
  ADD COLUMN total_tax       DECIMAL(12,2) NULL,
  ADD COLUMN total_shipping  DECIMAL(12,2) NULL;

ALTER TABLE inventory_variants
  ADD COLUMN shopify_unit_cost DECIMAL(12,2) NULL;
