-- Feature Governance Framework: per-tenant force-on/off overrides, per-company
-- engagement-engine mode, and the proactive-notifications plan gate + tenant toggle.
-- All additive + default-off, so live tenants are unaffected until explicitly enabled.

ALTER TABLE `subscriptions`
  ADD COLUMN `proactive_notifications` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `companies`
  ADD COLUMN `feature_overrides` JSON NULL,
  ADD COLUMN `engagement_mode` VARCHAR(16) NULL,
  ADD COLUMN `proactive_notifications_enabled` BOOLEAN NOT NULL DEFAULT false;
