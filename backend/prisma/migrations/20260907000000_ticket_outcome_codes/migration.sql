-- Ticket cockpit: structured outcome + reason codes (additive, nullable). Free
-- text `resolution_note` stays; these make "why are returns up?" queryable later.
ALTER TABLE `support_tickets`
  ADD COLUMN `resolution_code` VARCHAR(48) NULL,
  ADD COLUMN `reason_code` VARCHAR(48) NULL;
