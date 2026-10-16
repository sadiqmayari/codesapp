-- Creative team roles: creative_executive (manages Content+PR, assigns tasks)
-- and the two uploaders videographer + graphic_designer. Additive enum values;
-- existing rows unchanged. (content_manager/pr_manager kept for safety.)
ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment', 'content_manager', 'pr_manager', 'creative_executive', 'videographer', 'graphic_designer') NOT NULL;
