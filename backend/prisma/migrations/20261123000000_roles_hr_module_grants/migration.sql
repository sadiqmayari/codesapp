-- Roles audit + HR manager + super-admin module grants (Nov-2026).
-- Real Prisma migration (auto-applies on container start). Additive only.

-- 1) New `hr_manager` role (additive enum value). Keep the full list in order.
ALTER TABLE `users`
  MODIFY `role` ENUM(
    'super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment',
    'content_manager', 'pr_manager', 'creative_executive',
    'social_media_executive', 'videographer', 'graphic_designer', 'member',
    'hr_manager'
  ) NOT NULL;

-- 2) Session version: bumped on password change / suspend / role change.
ALTER TABLE `users`
  ADD COLUMN `token_version` INT NOT NULL DEFAULT 0;

-- 3) Grandfather the new super-admin module grants. Stored in the existing
--    super-admin authority JSON `companies.feature_overrides` ('on' = granted).
--    A tenant already using a module keeps it; everyone else starts off.
UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.growth', 'on', '$.growth_publish', 'on')
  WHERE EXISTS (SELECT 1 FROM `ad_accounts` a WHERE a.`company_id` = c.`id`)
     OR EXISTS (SELECT 1 FROM `growth_order_facts` f WHERE f.`company_id` = c.`id`);

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.attendance', 'on', '$.payroll', 'on')
  WHERE EXISTS (SELECT 1 FROM `attendance_records` r WHERE r.`company_id` = c.`id`);

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.commissions', 'on')
  WHERE EXISTS (SELECT 1 FROM `commission_plans` p WHERE p.`company_id` = c.`id`);

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.pack', 'on')
  WHERE EXISTS (SELECT 1 FROM `shipments` s WHERE s.`company_id` = c.`id` AND s.`packed_at` IS NOT NULL)
     OR EXISTS (SELECT 1 FROM `users` u WHERE u.`company_id` = c.`id` AND u.`role` = 'member');

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.calls', 'on')
  WHERE EXISTS (SELECT 1 FROM `call_logs` l WHERE l.`company_id` = c.`id`);

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.leaderboard', 'on')
  WHERE EXISTS (SELECT 1 FROM `users` u WHERE u.`company_id` = c.`id` AND u.`role` = 'agent');

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.couriers', 'on')
  WHERE EXISTS (SELECT 1 FROM `courier_credentials` k WHERE k.`company_id` = c.`id`)
     OR EXISTS (SELECT 1 FROM `shipments` s WHERE s.`company_id` = c.`id`);

UPDATE `companies` c SET c.`feature_overrides` = JSON_SET(COALESCE(c.`feature_overrides`, JSON_OBJECT()), '$.tickets', 'on')
  WHERE EXISTS (SELECT 1 FROM `support_tickets` t WHERE t.`company_id` = c.`id`);
