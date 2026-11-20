/**
 * ONE role vocabulary for the whole backend. Every `@Roles(...)` list and every
 * "is this user privileged?" check should come from here, so adding a role is a
 * one-file change instead of a hunt through string literals.
 *
 * Frontend twin: frontend/src/lib/roles.ts (keep the groups identical).
 */

/** Full workspace control (settings, money, staff). */
export const PRIVILEGED = ['owner', 'admin'] as const;

/** Team module administration: attendance, leave, payroll, commissions, staff. */
export const HR_ADMIN = ['owner', 'admin', 'hr_manager'] as const;

/** Roles that work the WhatsApp inbox + contacts. */
export const INBOX_ROLES = ['owner', 'admin', 'agent'] as const;

/**
 * Roles locked to one module (+ Team + Settings → Profile/Security). They must
 * never reach inbox/contacts/broadcasts/bots/templates through the API.
 */
export const LOCKED_ROLES = [
  'finance',
  'fulfillment',
  'content_manager',
  'pr_manager',
  'creative_executive',
  'social_media_executive',
  'videographer',
  'graphic_designer',
  'member',
  'hr_manager',
] as const;

/** Roles only the OWNER may assign, change, suspend or delete. */
export const OWNER_MANAGED_ROLES = ['owner', 'admin'] as const;

/** Roles an HR manager may NOT assign or manage (privileged + HR peers). */
export const HR_FORBIDDEN_TARGET_ROLES = ['owner', 'admin', 'hr_manager'] as const;

export function isPrivileged(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function isHrAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'hr_manager';
}

export function isLockedRole(role: string | null | undefined): boolean {
  return !!role && (LOCKED_ROLES as readonly string[]).includes(role);
}

/**
 * Can `actorRole` manage (edit role/status, suspend, delete) a member whose
 * current role is `targetRole`, and optionally give them `newRole`?
 * Returns an error message, or null when allowed.
 */
export function teamManageError(
  actorRole: string,
  targetRole: string | null,
  newRole?: string | null,
): string | null {
  if (targetRole === 'owner') return 'The owner cannot be modified';
  if (actorRole === 'owner') return null;
  if (actorRole === 'admin') {
    if (targetRole === 'admin') return 'Only the owner can manage admins';
    if (newRole === 'admin') return 'Only the owner can make someone an admin';
    return null;
  }
  if (actorRole === 'hr_manager') {
    const bad = HR_FORBIDDEN_TARGET_ROLES as readonly string[];
    if (targetRole && bad.includes(targetRole)) {
      return 'HR managers cannot manage admins or other HR managers';
    }
    if (newRole && bad.includes(newRole)) {
      return 'HR managers cannot assign the admin or HR manager role';
    }
    return null;
  }
  return 'Insufficient role';
}
