-- Ticket creation cockpit: priority set at birth (feeds the SLA/most-overdue sort).
ALTER TABLE `support_tickets` ADD COLUMN `priority` VARCHAR(16) NULL;
