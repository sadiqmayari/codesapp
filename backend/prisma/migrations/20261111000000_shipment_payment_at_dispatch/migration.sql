-- Dispatch-list payment snapshot. The dispatch/invoicing list classifies each
-- order's payment (Pending / Online / Gateway) from the LIVE order mirror, so a
-- reprint AFTER courier settlement flipped COD parcels: settlement marks them
-- paid (total_outstanding -> 0, financial_status -> paid) and the live classifier
-- then returned "Online" for an order that dispatched as "Pending". This column
-- freezes the classification at dispatch time (stamped when a parcel is pinned to
-- a loadsheet batch) so the dispatch list is an immutable record. Additive +
-- nullable; auto-applies on container start (redeploy regenerates the Prisma
-- client). Legacy rows stay NULL -> the service falls back to the live classifier.
ALTER TABLE `shipments`
  ADD COLUMN `payment_at_dispatch` VARCHAR(16) NULL;
