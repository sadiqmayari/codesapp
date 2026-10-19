-- Add the social_media_executive role (junior creative executive; same enforced
-- Content + PR access). Additive enum value; existing rows unchanged.
-- MySQL 8 — one-time phpMyAdmin Import.
ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment', 'content_manager', 'pr_manager', 'creative_executive', 'social_media_executive', 'videographer', 'graphic_designer') NOT NULL;
