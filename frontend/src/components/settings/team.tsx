'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, UserX, UserCheck, ArrowRightLeft, UserMinus } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { SearchInput } from '@/components/ui/search-input';
import { FilterSelect } from '@/components/ui/filter-bar';
import { NoResults } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { SettingsPage } from './shared';

const rowBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ink hover:bg-sunken disabled:opacity-50';
const AVATAR_COLORS = ['#16a34a', '#2563eb', '#9333ea', '#d97706', '#0891b2', '#db2777', '#4f46e5', '#65a30d'];
function avatarColor(id: number): string {
  return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length];
}
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}
import type { TeamMember, TeamRole, AssignableRole } from '@/lib/crm-types';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '@/lib/crm-types';
import { canAssignRole, canManageMember } from '@/lib/roles';

export function TeamSection({ actorRole }: { actorRole: TeamRole }) {
  const toast = useToast();
  const { user } = useAuth();
  const [rows, setRows] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  // Name / email search + role filter over the whole team list.
  const [memberQuery, setMemberQuery] = useState('');
  const [memberRole, setMemberRole] = useState('');
  const shownMembers = rows.filter((m) => {
    if (memberRole && m.role !== memberRole) return false;
    const q = memberQuery.trim().toLowerCase();
    return !q || `${m.name} ${m.email}`.toLowerCase().includes(q);
  });
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: 'agent' as AssignableRole,
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<TeamMember | null>(null);
  // '' = release the chats to the unassigned pool; otherwise a target user id.
  const [suspendReassignTo, setSuspendReassignTo] = useState('');
  const [reassignTarget, setReassignTarget] = useState<TeamMember | null>(null);
  const [reassignTo, setReassignTo] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TeamMember | null>(null);
  // '' = release the chats to the unassigned pool; otherwise a target user id.
  const [deleteReassignTo, setDeleteReassignTo] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  // Active members who can receive another agent's chats (excludes a given one).
  const reassignCandidates = (exceptId?: number) =>
    rows.filter((m) => m.status === 'active' && m.id !== exceptId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await apiFetch<TeamMember[]>('/team'));
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load team',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (form.name.trim().length < 2 || !form.email.trim()) {
      toast.error('Name and email are required');
      return;
    }
    if (form.password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/team', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
          password: form.password,
        },
      });
      toast.success('Team member added');
      setShowCreate(false);
      setForm({ name: '', email: '', role: 'agent', password: '' });
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const patch = async (m: TeamMember, body: Record<string, string>) => {
    setBusyId(m.id);
    try {
      await apiFetch(`/team/${m.id}`, { method: 'PATCH', body });
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const suspend = async () => {
    if (!suspendTarget) return;
    setBusyId(suspendTarget.id);
    try {
      const res = await apiFetch<{ reassignedChats?: number }>(
        `/team/${suspendTarget.id}`,
        {
          method: 'DELETE',
          body: {
            reassignToUserId: suspendReassignTo ? Number(suspendReassignTo) : null,
          },
        },
      );
      const n = res?.reassignedChats ?? 0;
      const where = suspendReassignTo ? 'reassigned' : 'returned to the pool';
      toast.success(
        n > 0
          ? `Member suspended · ${n} chat${n === 1 ? '' : 's'} ${where}`
          : 'Member suspended',
      );
      setSuspendTarget(null);
      setSuspendReassignTo('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Suspend failed');
    } finally {
      setBusyId(null);
    }
  };

  const reassignChats = async () => {
    if (!reassignTarget) return;
    setBusyId(reassignTarget.id);
    try {
      const res = await apiFetch<{ count: number }>(
        `/team/${reassignTarget.id}/reassign-chats`,
        { method: 'POST', body: { toUserId: reassignTo ? Number(reassignTo) : null } },
      );
      const n = res?.count ?? 0;
      const where = reassignTo ? 'reassigned' : 'returned to the pool';
      toast.success(
        n > 0 ? `${n} chat${n === 1 ? '' : 's'} ${where}` : 'No chats to move',
      );
      setReassignTarget(null);
      setReassignTo('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Reassign failed');
    } finally {
      setBusyId(null);
    }
  };

  const removeMember = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const res = await apiFetch<{ reassignedChats?: number }>(
        `/team/${deleteTarget.id}/permanent`,
        {
          method: 'DELETE',
          body: {
            reassignToUserId: deleteReassignTo ? Number(deleteReassignTo) : null,
          },
        },
      );
      const n = res?.reassignedChats ?? 0;
      const where = deleteReassignTo ? 'reassigned' : 'returned to the pool';
      toast.success(
        n > 0
          ? `Member deleted · ${n} chat${n === 1 ? '' : 's'} ${where}`
          : 'Member deleted',
      );
      setDeleteTarget(null);
      setDeleteReassignTo('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = rows.filter((m) => m.status === 'active').length;
  const suspendedCount = rows.filter((m) => m.status === 'suspended').length;
  return (
    <SettingsPage
      title="Team"
      description={
        loading
          ? 'Everyone with access to this workspace.'
          : `${activeCount} active${suspendedCount ? ` · ${suspendedCount} suspended` : ''}. Suspending someone hands their chats to the pool or a teammate.`
      }
      actions={
        <Button onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Add member
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={memberQuery}
          onChange={setMemberQuery}
          placeholder="Search name or email"
          className="w-full sm:w-64"
        />
        <FilterSelect
          label="Role"
          value={memberRole}
          options={[
            { value: '', label: 'Any' },
            ...Array.from(new Set(rows.map((m) => m.role))).map((r) => ({
              value: r,
              label: ROLE_LABELS[r as TeamRole] ?? r,
            })),
          ]}
          onChange={setMemberRole}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-bold text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3">Member</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="p-0">
                    <SkeletonRows rows={5} avatar />
                  </td>
                </tr>
              ) : shownMembers.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <NoResults
                      compact
                      query={memberQuery}
                      noun="members"
                      onClear={() => {
                        setMemberQuery('');
                        setMemberRole('');
                      }}
                    />
                  </td>
                </tr>
              ) : (
                shownMembers.map((m) => {
                  const isSelf = m.id === user?.id;
                  const isOwner = m.role === 'owner';
                  const locked = isSelf || isOwner || !canManageMember(actorRole, m.role);
                  return (
                    <tr key={m.id} className="border-t border-line first:border-t-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-extrabold text-white"
                            style={{ background: avatarColor(m.id) }}
                          >
                            {initials(m.name)}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-ink">
                              {m.name}
                              {isSelf && <span className="font-normal text-muted"> (you)</span>}
                            </div>
                            <div className="truncate text-xs text-muted">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {locked ? (
                          <span className="font-medium text-ink">{ROLE_LABELS[m.role] ?? m.role}</span>
                        ) : (
                          <select
                            value={m.role}
                            disabled={busyId === m.id}
                            onChange={(e) =>
                              patch(m, { role: e.target.value })
                            }
                            aria-label={`Role for ${m.name}`}
                            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-medium text-ink"
                          >
                            {/* The member's current role may be one not in the
                                assignable list (e.g. content_manager) — show it. */}
                            {!ASSIGNABLE_ROLES.includes(m.role as AssignableRole) && (
                              <option value={m.role}>
                                {ROLE_LABELS[m.role] ?? m.role}
                              </option>
                            )}
                            {ASSIGNABLE_ROLES.filter(
                              (r) => canAssignRole(actorRole, r),
                            ).map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r] ?? r}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={m.status === 'active' ? 'success' : m.status === 'pending' ? 'warn' : 'neutral'}
                          className="capitalize"
                        >
                          {m.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!locked && (
                          <div className="flex justify-end gap-1">
                            <button
                              title="Reassign this member's chats"
                              disabled={busyId === m.id}
                              onClick={() => {
                                setReassignTarget(m);
                                setReassignTo('');
                              }}
                              className={rowBtn}
                            >
                              <ArrowRightLeft size={14} /> <span className="hidden lg:inline">Reassign chats</span>
                            </button>
                            {m.status === 'suspended' ? (
                              <button
                                title="Reactivate"
                                disabled={busyId === m.id}
                                onClick={() =>
                                  patch(m, { status: 'active' })
                                }
                                className={cn(rowBtn, 'text-brand-700 dark:text-brand-300')}
                              >
                                <UserCheck size={14} /> <span className="hidden lg:inline">Reactivate</span>
                              </button>
                            ) : (
                              <button
                                title="Suspend"
                                disabled={busyId === m.id}
                                onClick={() => {
                                  setSuspendTarget(m);
                                  setSuspendReassignTo('');
                                }}
                                className={rowBtn}
                              >
                                <UserX size={14} /> <span className="hidden lg:inline">Suspend</span>
                              </button>
                            )}
                            <button
                              title="Delete permanently"
                              disabled={busyId === m.id}
                              onClick={() => {
                                setDeleteTarget(m);
                                setDeleteReassignTo('');
                              }}
                              className={cn(rowBtn, 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20')}
                              aria-label={`Delete ${m.name} permanently`}
                            >
                              <UserMinus size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add team member"
        footer={
          <>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-sm rounded-lg border border-line bg-surface text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Full name"
            className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
          />
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Email"
            className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={form.password}
            onChange={(e) =>
              setForm({ ...form, password: e.target.value })
            }
            placeholder="Temporary password (min 8)"
            className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={form.role}
            onChange={(e) =>
              setForm({ ...form, role: e.target.value as AssignableRole })
            }
            className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
          >
            {ASSIGNABLE_ROLES.filter(
              (r) => canAssignRole(actorRole, r),
            ).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted">
            Share the temporary password with the member; they can change it
            under Settings → Profile.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!suspendTarget}
        onClose={() => setSuspendTarget(null)}
        title="Suspend member?"
        footer={
          <>
            <button
              onClick={() => setSuspendTarget(null)}
              className="px-4 py-2 text-sm rounded-lg border border-line bg-surface text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={suspend}
              disabled={busyId === suspendTarget?.id}
              className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
            >
              {busyId === suspendTarget?.id ? 'Suspending…' : 'Suspend'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {suspendTarget?.name} will lose access immediately until reactivated.
            Their data is kept.
          </p>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Move their open chats to
            </label>
            <select
              value={suspendReassignTo}
              onChange={(e) => setSuspendReassignTo(e.target.value)}
              className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Return to the pool (unassigned)</option>
              {reassignCandidates(suspendTarget?.id).map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.name} · {m.role}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">
              Chats assigned to a suspended member stay hidden from other agents
              until moved, so we reassign them now.
            </p>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete member permanently?"
        footer={
          <>
            <button
              onClick={() => setDeleteTarget(null)}
              className="px-4 py-2 text-sm rounded-lg border border-line bg-surface text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={removeMember}
              disabled={busyId === deleteTarget?.id}
              className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
            >
              {busyId === deleteTarget?.id ? 'Deleting…' : 'Delete permanently'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            <strong>{deleteTarget?.name}</strong> will be removed for good. This
            cannot be undone — their login is deleted and their past messages,
            calls and activity stay in your history but are no longer attributed
            to them. To keep the option of bringing them back, suspend instead.
          </p>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Move their open chats to
            </label>
            <select
              value={deleteReassignTo}
              onChange={(e) => setDeleteReassignTo(e.target.value)}
              className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Return to the pool (unassigned)</option>
              {reassignCandidates(deleteTarget?.id).map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.name} · {m.role}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!reassignTarget}
        onClose={() => setReassignTarget(null)}
        title={`Reassign ${reassignTarget?.name ?? ''}'s chats`}
        footer={
          <>
            <button
              onClick={() => setReassignTarget(null)}
              className="px-4 py-2 text-sm rounded-lg border border-line bg-surface text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={reassignChats}
              disabled={busyId === reassignTarget?.id}
              className="px-4 py-2 text-sm rounded-lg bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
            >
              {busyId === reassignTarget?.id ? 'Moving…' : 'Reassign'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Move every conversation currently assigned to {reassignTarget?.name}.
          </p>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Reassign to
            </label>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              className="w-full border border-line bg-surface rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Return to the pool (unassigned)</option>
              {reassignCandidates(reassignTarget?.id).map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.name} · {m.role}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>
    </SettingsPage>
  );
}
