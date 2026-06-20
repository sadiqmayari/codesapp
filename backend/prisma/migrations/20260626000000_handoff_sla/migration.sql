-- Handoff SLA Management (enterprise hardening #10).
--
-- WHY: every AI→human handoff (compliance, fraud, frustration, kill-switch, image
-- routing, dispute, escalation) needs an owner + a deadline so nothing sits
-- unattended. The engagement engine's work-item SLA only covers engagement-mode
-- work items; most handoffs have none. This dedicated table records EVERY handoff
-- with a deterministic priority + SLA due time so a sweep can alert on breaches.
--
-- Additive + backward compatible: a new table, no changes to existing columns,
-- no backfill. Recording is flag-gated (default OFF) so existing tenants are
-- unaffected until opted in.
CREATE TABLE `handoffs` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `company_id`       INT NOT NULL,
  `conversation_id`  INT NOT NULL,
  -- The raw handoff reason string (audit) + the derived SLA category/priority.
  `reason`           VARCHAR(255) NOT NULL,
  `reason_category`  VARCHAR(32) NOT NULL,
  `priority`         VARCHAR(16) NOT NULL,
  `assigned_user_id` INT NULL,
  `sla_due_at`       DATETIME(3) NOT NULL,
  `handoff_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Set when a human picked it up (assigned / moved off 'pending').
  `resolved_at`      DATETIME(3) NULL,
  -- Set once the sweep has alerted on an SLA breach (prevents repeat alerts).
  `escalated_at`     DATETIME(3) NULL,
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `handoffs_company_id_conversation_id_idx` (`company_id`, `conversation_id`),
  -- The sweep scans for unresolved, un-escalated, past-due rows.
  INDEX `handoffs_sweep_idx` (`resolved_at`, `escalated_at`, `sla_due_at`)
) DEFAULT CHARACTER SET utf8mb4;
