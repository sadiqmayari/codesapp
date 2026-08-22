-- Add a view-only 'finance' role: sees the Courier Payments + gateway settlement
-- statements (view + download) only. Additive enum value; existing rows unchanged.
ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'owner', 'admin', 'agent', 'finance') NOT NULL;
