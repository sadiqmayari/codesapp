'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy, Check, Plus, UserX, Trash2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import type {
  OnboardingStatusView,
  TeamMember,
  TeamRole,
  ShopifyIntegration,
} from '@/lib/crm-types';

type Tab = 'whatsapp' | 'team' | 'shopify' | 'security' | 'profile';

export default function SettingsPage() {
  const { user } = useAuth();
  const canManageTeam = user?.role === 'owner' || user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('whatsapp');
  const tabs: Array<[Tab, string]> = [
    ['whatsapp', 'WhatsApp'],
    ...(canManageTeam ? ([['team', 'Team']] as Array<[Tab, string]>) : []),
    ['shopify', 'Shopify'],
    ['security', 'Security'],
    ['profile', 'Profile'],
  ];
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Settings</h1>
      <div className="flex gap-2 mb-5 border-b border-gray-200 flex-wrap">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'px-4 py-2 text-sm -mb-px border-b-2',
              tab === k
                ? 'border-green-600 text-green-700 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'whatsapp' && <WhatsAppTab />}
      {tab === 'team' && canManageTeam && (
        <TeamTab actorRole={user?.role as TeamRole} />
      )}
      {tab === 'shopify' && <ShopifyTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'profile' && <ProfileTab />}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm text-gray-800 break-all">
          {value || '—'}
        </code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="p-2 text-gray-500 hover:text-gray-800"
          title="Copy"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

function WhatsAppTab() {
  const toast = useToast();
  const { user } = useAuth();
  const [st, setSt] = useState<OnboardingStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSt(
        await apiFetch<OnboardingStatusView>('/onboarding/status', {
          noOnboardingRedirect: true,
        }),
      );
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load status',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const doReset = async () => {
    setResetting(true);
    try {
      await apiFetch('/onboarding/reset', { method: 'POST' });
      toast.success('WhatsApp connection reset');
      setConfirmReset(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Reset failed');
    } finally {
      setResetting(false);
    }
  };

  if (loading)
    return (
      <div className="p-10 flex justify-center">
        <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  if (!st) return null;

  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="space-y-5">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">Connection status</p>
            <p
              className={cn(
                'text-lg font-semibold mt-1',
                st.completed ? 'text-green-600' : 'text-yellow-600',
              )}
            >
              {st.completed
                ? 'Connected'
                : `Onboarding incomplete (step ${st.currentStep}/5)`}
            </p>
          </div>
          <Link
            href="/onboarding"
            className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg"
          >
            {st.completed ? 'Edit setup' : 'Continue setup'}
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
          <Field label="Meta App ID" value={st.metaAppId || '—'} />
          <Field
            label="Access token"
            value={st.metaAccessToken ? 'Set' : 'Not set'}
          />
          <Field label="WABA ID" value={st.wabaId || '—'} />
          <Field label="Phone number ID" value={st.phoneNumberId || '—'} />
          <Field
            label="App secret"
            value={st.webhookSecretSet ? 'Set' : 'Not set'}
          />
          <Field
            label="Test message"
            value={st.testMessageSentAt ? 'Sent' : 'Not sent'}
          />
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">
          Webhook configuration (for your Meta app)
        </p>
        <CopyField
          label="Callback URL"
          value={`${origin}/webhooks/meta/${st.webhookKey}`}
        />
        <CopyField label="Verify token" value={st.webhookVerifyToken} />
      </div>

      {user?.role === 'owner' && (
        <div className="bg-white border border-red-200 rounded-xl p-5">
          <p className="text-sm font-semibold text-red-600 mb-1">
            Danger zone
          </p>
          <p className="text-sm text-gray-500 mb-3">
            Resetting clears the Meta connection (token, WABA, phone). Your
            contacts and messages are kept. You will need to re-run
            onboarding.
          </p>
          <button
            onClick={() => setConfirmReset(true)}
            className="text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg"
          >
            Reset WhatsApp connection
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Reset WhatsApp connection?"
        message="This clears the Meta token, WABA and phone number. Contacts and messages are preserved. You must re-run onboarding to send again."
        danger
        confirmLabel="Reset"
        busy={resetting}
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}

function SecurityTab() {
  const toast = useToast();
  const [setup, setSetup] = useState<{
    secret: string;
    qrCode: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<string[] | null>(null);

  const begin = async () => {
    setBusy(true);
    try {
      setSetup(
        await apiFetch<{ secret: string; qrCode: string }>(
          '/auth/2fa/setup',
          { method: 'POST' },
        ),
      );
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : '2FA setup failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await apiFetch<{
        verified: boolean;
        backupCodes?: string[];
      }>('/auth/2fa/verify', { method: 'POST', body: { code: code.trim() } });
      if (res.verified) {
        toast.success('Two-factor authentication enabled');
        setBackup(res.backupCodes ?? null);
        setSetup(null);
        setCode('');
      } else {
        toast.error('Invalid code');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Verify failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4 max-w-md">
      <div>
        <p className="font-semibold text-gray-800">
          Two-factor authentication
        </p>
        <p className="text-sm text-gray-500 mt-1">
          Add a TOTP authenticator app (Google Authenticator, Authy) for an
          extra layer of security.
        </p>
      </div>

      {backup && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-sm font-medium text-green-700 mb-2">
            Backup codes — store these safely:
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs text-gray-700">
            {backup.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </div>
        </div>
      )}

      {!setup ? (
        <button
          onClick={begin}
          disabled={busy}
          className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Set up 2FA'}
        </button>
      ) : (
        <div className="space-y-3">
          {setup.qrCode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={setup.qrCode}
              alt="2FA QR code"
              className="w-44 h-44 border border-gray-200 rounded"
            />
          )}
          <CopyField label="Manual key" value={setup.secret} />
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Enter the 6-digit code
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={verify}
            disabled={busy}
            className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify & enable'}
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileTab() {
  const { user } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [nw2, setNw2] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const saveName = async () => {
    if (name.trim().length < 2) {
      toast.error('Name must be at least 2 characters');
      return;
    }
    setSavingName(true);
    try {
      await apiFetch('/auth/profile', {
        method: 'PATCH',
        body: { name: name.trim() },
      });
      toast.success('Profile updated (refresh to see it everywhere)');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setSavingName(false);
    }
  };

  const changePw = async () => {
    if (nw.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    if (nw !== nw2) {
      toast.error('New passwords do not match');
      return;
    }
    setSavingPw(true);
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: cur, newPassword: nw },
      });
      toast.success('Password changed');
      setCur('');
      setNw('');
      setNw2('');
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Password change failed',
      );
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="space-y-5 max-w-md">
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <p className="font-semibold text-gray-800">Profile</p>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <Field label="Email" value={user?.email || '—'} />
        <Field label="Role" value={user?.role || '—'} />
        <button
          onClick={saveName}
          disabled={savingName}
          className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {savingName ? 'Saving…' : 'Save profile'}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <p className="font-semibold text-gray-800">Change password</p>
        <input
          type="password"
          value={cur}
          onChange={(e) => setCur(e.target.value)}
          placeholder="Current password"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="password"
          value={nw}
          onChange={(e) => setNw(e.target.value)}
          placeholder="New password (min 8)"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="password"
          value={nw2}
          onChange={(e) => setNw2(e.target.value)}
          placeholder="Confirm new password"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={changePw}
          disabled={savingPw || !cur || !nw}
          className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {savingPw ? 'Updating…' : 'Change password'}
        </button>
      </div>
    </div>
  );
}

function TeamTab({ actorRole }: { actorRole: TeamRole }) {
  const toast = useToast();
  const { user } = useAuth();
  const [rows, setRows] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: 'agent' as 'admin' | 'agent',
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<TeamMember | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

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
      await apiFetch(`/team/${suspendTarget.id}`, { method: 'DELETE' });
      toast.success('Member suspended');
      setSuspendTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Suspend failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg"
        >
          <Plus size={16} /> Add member
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </td>
                </tr>
              ) : (
                rows.map((m) => {
                  const isSelf = m.id === user?.id;
                  const isOwner = m.role === 'owner';
                  const locked = isSelf || isOwner;
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-gray-100"
                    >
                      <td className="px-4 py-3 font-medium text-gray-800">
                        {m.name}
                        {isSelf && (
                          <span className="text-xs text-gray-400"> (you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{m.email}</td>
                      <td className="px-4 py-3">
                        {locked ? (
                          <span className="capitalize">{m.role}</span>
                        ) : (
                          <select
                            value={m.role}
                            disabled={busyId === m.id}
                            onChange={(e) =>
                              patch(m, { role: e.target.value })
                            }
                            className="border border-gray-300 rounded px-2 py-1 text-xs"
                          >
                            <option value="agent">agent</option>
                            {actorRole === 'owner' && (
                              <option value="admin">admin</option>
                            )}
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'text-xs px-2 py-0.5 rounded-full capitalize',
                            m.status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : m.status === 'pending'
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-gray-100 text-gray-500',
                          )}
                        >
                          {m.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!locked && (
                          <div className="flex justify-end gap-1">
                            {m.status === 'suspended' ? (
                              <button
                                title="Reactivate"
                                disabled={busyId === m.id}
                                onClick={() =>
                                  patch(m, { status: 'active' })
                                }
                                className="p-1.5 text-green-600 hover:bg-gray-100 rounded"
                              >
                                <UserX size={15} />
                              </button>
                            ) : (
                              <button
                                title="Suspend"
                                disabled={busyId === m.id}
                                onClick={() => setSuspendTarget(m)}
                                className="p-1.5 text-red-500 hover:bg-gray-100 rounded"
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
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
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
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
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Email"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={form.password}
            onChange={(e) =>
              setForm({ ...form, password: e.target.value })
            }
            placeholder="Temporary password (min 8)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={form.role}
            onChange={(e) =>
              setForm({
                ...form,
                role: e.target.value as 'admin' | 'agent',
              })
            }
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="agent">Agent</option>
            {actorRole === 'owner' && <option value="admin">Admin</option>}
          </select>
          <p className="text-xs text-gray-400">
            Share the temporary password with the member; they can change it
            under Settings → Profile.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!suspendTarget}
        title="Suspend member?"
        message={`${suspendTarget?.name} will lose access until reactivated. Their data is kept.`}
        danger
        confirmLabel="Suspend"
        busy={busyId === suspendTarget?.id}
        onConfirm={suspend}
        onCancel={() => setSuspendTarget(null)}
      />
    </div>
  );
}

const SHOPIFY_EVENTS = [
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
];

function ShopifyTab() {
  const toast = useToast();
  const [integration, setIntegration] = useState<ShopifyIntegration | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDisc, setConfirmDisc] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setIntegration(
        await apiFetch<ShopifyIntegration | null>('/settings/shopify'),
      );
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load Shopify',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    const sub = shop.trim().replace(/\.myshopify\.com$/i, '');
    if (!sub) {
      toast.error('Enter your Shopify store subdomain');
      return;
    }
    setBusy(true);
    try {
      const { url } = await apiFetch<{ url: string }>(
        '/settings/shopify/connect',
      );
      window.location.assign(url.replace('{shop}', sub));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Connect failed');
      setBusy(false);
    }
  };

  const toggleEvent = async (ev: string) => {
    if (!integration) return;
    const next = integration.active_events.includes(ev)
      ? integration.active_events.filter((x) => x !== ev)
      : [...integration.active_events, ev];
    if (next.length === 0) {
      toast.error('Keep at least one event');
      return;
    }
    setBusy(true);
    try {
      const updated = await apiFetch<ShopifyIntegration>(
        '/settings/shopify/events',
        { method: 'PATCH', body: { events: next } },
      );
      setIntegration(updated);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await apiFetch('/settings/shopify', { method: 'DELETE' });
      toast.success('Shopify disconnected');
      setConfirmDisc(false);
      setIntegration(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <div className="p-10 flex justify-center">
        <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  if (!integration) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 max-w-md space-y-4">
        <div>
          <p className="font-semibold text-gray-800">Connect Shopify</p>
          <p className="text-sm text-gray-500 mt-1">
            Link your Shopify store to trigger WhatsApp messages on order
            events.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            placeholder="your-store"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <span className="text-sm text-gray-500">.myshopify.com</span>
        </div>
        <button
          onClick={connect}
          disabled={busy}
          className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : 'Connect store'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-md">
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">Connected store</p>
            <p className="font-semibold text-gray-900">
              {integration.shop_domain}
            </p>
          </div>
          <span
            className={cn(
              'text-xs px-2 py-0.5 rounded-full capitalize',
              integration.status === 'active'
                ? 'bg-green-100 text-green-700'
                : integration.status === 'error'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-gray-100 text-gray-500',
            )}
          >
            {integration.status}
          </span>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <p className="font-semibold text-gray-800 mb-3">Order events</p>
        <div className="space-y-2">
          {SHOPIFY_EVENTS.map((ev) => (
            <label
              key={ev}
              className="flex items-center gap-2 text-sm text-gray-700"
            >
              <input
                type="checkbox"
                disabled={busy}
                checked={integration.active_events.includes(ev)}
                onChange={() => toggleEvent(ev)}
              />
              {ev}
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white border border-red-200 rounded-xl p-5">
        <button
          onClick={() => setConfirmDisc(true)}
          className="text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg"
        >
          Disconnect Shopify
        </button>
      </div>

      <ConfirmDialog
        open={confirmDisc}
        title="Disconnect Shopify?"
        message="Order events will stop triggering WhatsApp messages. You can reconnect anytime."
        danger
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisc(false)}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-0.5 capitalize break-all">
        {value}
      </p>
    </div>
  );
}
