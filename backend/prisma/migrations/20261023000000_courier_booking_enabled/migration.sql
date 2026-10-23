-- Activate/deactivate a courier without removing its credentials.
-- `booking_enabled` governs whether a courier is OFFERED for NEW bookings; it is
-- separate from `is_active` (credentials present & usable), so a deactivated
-- courier still receives webhooks and status-syncs its existing orders.
-- MySQL/MariaDB — one-time phpMyAdmin Import. Additive; existing rows default to
-- enabled.
ALTER TABLE courier_credentials
  ADD COLUMN booking_enabled TINYINT(1) NOT NULL DEFAULT 1;
