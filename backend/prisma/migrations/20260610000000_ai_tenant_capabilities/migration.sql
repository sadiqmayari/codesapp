-- AI cost control → tenant self-service.
-- ai_autonomous_tier: tenant-selectable model tier ('fast'|'smart'); NULL = platform default.
-- ai_premium_locked: super-admin per-tenant kill-switch (forces baseline when true).
-- (ai_vision_enabled / ai_voice_enabled / ai_monthly_cap_cents already exist.)
ALTER TABLE `companies`
  ADD COLUMN `ai_autonomous_tier` VARCHAR(16) NULL,
  ADD COLUMN `ai_premium_locked`  TINYINT(1) NOT NULL DEFAULT 0;
