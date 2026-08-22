-- Add a 'fulfillment' role: locked to the Orders module (queue, shipments,
-- loadsheets, receive, order detail). Cannot see any payments/settlements.
-- Additive enum value; existing rows unchanged.
ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment') NOT NULL;
