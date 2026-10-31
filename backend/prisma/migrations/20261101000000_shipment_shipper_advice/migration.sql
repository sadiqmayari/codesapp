-- Shipper-advice auto-detection + dedicated board tab.
-- Additive, nullable columns only — every existing shipment row is untouched.
--   shipper_advice_required_at  : set when the COURIER is detected to be awaiting
--     shipper advice on an attempted parcel (explicit courier status, or an
--     attempt aged >24h with no advice sent). Drives the "Shipper advice" tab.
--   shipper_advice_required_raw : the raw courier status text that triggered it.
--   attempted_at                : stamped on the first transition into 'attempted'
--     (mirrors failed_at/delivered_at) so the aged-attempt fallback can measure
--     elapsed time without relying on updated_at.
-- The parcel stays status='attempted' under the hood — these are display/triage
-- fields, so payments / analytics / re-poll behaviour is unchanged.
ALTER TABLE `shipments`
  ADD COLUMN `shipper_advice_required_at` DATETIME(3) NULL,
  ADD COLUMN `shipper_advice_required_raw` VARCHAR(128) NULL,
  ADD COLUMN `attempted_at` DATETIME(3) NULL;

-- Powers the "Shipper advice" tab filter + lane count.
CREATE INDEX `shipments_company_id_shipper_advice_required_at_idx`
  ON `shipments` (`company_id`, `shipper_advice_required_at`);
