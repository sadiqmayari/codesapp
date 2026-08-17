-- RTO receive: a human-confirmed "the parcel is physically back in our hands"
-- signal, distinct from any courier status. Set by the barcode-scan receive flow
-- and the existing manual / bulk "Mark received" actions (all now funnel through
-- ShipmentService.confirmReceived). `received_by_user_id` records who confirmed it.
ALTER TABLE `shipments`
  ADD COLUMN `received_at` DATETIME(3) NULL,
  ADD COLUMN `received_by_user_id` INT NULL;
