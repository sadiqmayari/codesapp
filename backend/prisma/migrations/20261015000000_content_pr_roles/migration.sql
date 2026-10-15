-- Add two module-locked roles: 'content_manager' (Content module) and
-- 'pr_manager' (PR module). Additive enum values; existing rows unchanged.
ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment', 'content_manager', 'pr_manager') NOT NULL;
