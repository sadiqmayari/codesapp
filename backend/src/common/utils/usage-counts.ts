import { PrismaService } from '../../prisma/prisma.service';

/**
 * Single source of truth for a tenant's CURRENT usage of the *cumulative*,
 * capped dimensions (contacts + templates + users).
 *
 * WHY THIS EXISTS — the bug it fixes:
 *   `usage_metering.contacts_stored` / `templates_used` are PER-MONTH counters
 *   (the row is keyed by `period = YYYY-MM` and starts at 0 every calendar
 *   month). They only ever counted "added this period". Contacts and templates
 *   are cumulative/STORED resources — the plan cap (e.g. 5,000 contacts) limits
 *   the *total stored*, not monthly additions. Reading the monthly counter for
 *   "current usage" made a tenant with 2,399 contacts show "8" on the 1st of a
 *   new month, broke PlanGuard enforcement, and reset every limit warning.
 *
 * The fix: derive current usage of these dimensions from LIVE counts of what is
 * actually stored. `messages_sent` / `webhook_calls` / `conversations_opened`
 * remain legitimate per-month consumption metrics and keep using the
 * usage_metering counters.
 *
 * Basis (kept IDENTICAL across every consumer — PlanGuard, the 80% / 90 / 99 /
 * 100% limit warnings, the tenant billing + analytics displays, the super-admin
 * Usage page, the client-profile limit bars, and the CSV-import cap):
 *  - contacts  = non-deleted contacts (all statuses, incl. blocked/archived —
 *                they still occupy a stored row)
 *  - templates = non-deleted templates (all statuses)
 *  - users     = active users
 */
export interface StoredUsage {
  contacts: number;
  templates: number;
  users: number;
}

export async function getStoredUsage(
  prisma: PrismaService,
  companyId: number,
): Promise<StoredUsage> {
  const [contacts, templates, users] = await Promise.all([
    prisma.contact.count({
      where: { company_id: companyId, deleted_at: null },
    }),
    prisma.template.count({
      where: { company_id: companyId, deleted_at: null },
    }),
    prisma.user.count({
      where: { company_id: companyId, status: 'active' },
    }),
  ]);
  return { contacts, templates, users };
}
