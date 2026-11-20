/**
 * Frontend twin of backend/src/common/auth/roles.ts — keep the groups and the
 * team-management rule identical. UI gating only; the server enforces.
 */
export const PRIVILEGED = ['owner', 'admin'] as const;
export const HR_ADMIN = ['owner', 'admin', 'hr_manager'] as const;
export const INBOX_ROLES = ['owner', 'admin', 'agent'] as const;

export function isPrivileged(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function isHrAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'hr_manager';
}

/** Can `actorRole` give someone `newRole`? */
export function canAssignRole(actorRole: string | null | undefined, newRole: string): boolean {
  if (actorRole === 'owner') return newRole !== 'owner';
  if (actorRole === 'admin') return newRole !== 'admin' && newRole !== 'owner';
  if (actorRole === 'hr_manager') return !['owner', 'admin', 'hr_manager'].includes(newRole);
  return false;
}

/** Can `actorRole` edit / suspend / delete a member whose role is `targetRole`? */
export function canManageMember(actorRole: string | null | undefined, targetRole: string): boolean {
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'admin';
  if (actorRole === 'hr_manager') return !['admin', 'hr_manager'].includes(targetRole);
  return false;
}
