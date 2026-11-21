-- Leopards statement dates were parsed US-style (11/08/2026 -> 8 Nov instead of
-- 11 Aug) or not at all (11-08-2026 -> NULL). The invoice number carries the
-- statement day ("20260811-3309426"), so re-date every non-rollup Leopards
-- statement from it (noon UTC, so tenant-tz display stays on that day).
UPDATE `courier_invoices`
SET `report_date` = TIMESTAMP(STR_TO_DATE(LEFT(`invoice_number`, 8), '%Y%m%d'), '12:00:00')
WHERE `courier_type` = 'leopards'
  AND `is_rollup` = 0
  AND `invoice_number` REGEXP '^20[0-9]{6}-'
  AND STR_TO_DATE(LEFT(`invoice_number`, 8), '%Y%m%d') IS NOT NULL;
