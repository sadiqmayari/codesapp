-- Per-cart agent disposition for the Cart Recovery worklist. Separate from the
-- recovery-pipeline `status` (pending|recovered|converted|expired|superseded)
-- so the two never collide: a cart stays `pending` but an agent can mark it
-- contacted / not_interested / no_response to drive the New / Contacted /
-- Not-interested lanes. Reversible (set back to NULL). Matches the existing
-- raw-column pattern on this table (value/assignee cols live outside schema.prisma).
ALTER TABLE `shopify_abandoned_checkouts`
  ADD COLUMN `agent_outcome` VARCHAR(16) NULL,
  ADD COLUMN `outcome_at` DATETIME NULL,
  ADD COLUMN `outcome_by_user_id` INT NULL;

CREATE INDEX `abandoned_company_outcome_idx`
  ON `shopify_abandoned_checkouts` (`company_id`, `agent_outcome`);
