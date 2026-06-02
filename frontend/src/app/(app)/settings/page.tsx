'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Copy,
  Check,
  Plus,
  UserX,
  Trash2,
  Upload,
  Play,
} from 'lucide-react';
import { apiFetch, ApiError, postMultipart } from '@/lib/api';
import {
  aiGetSettings,
  aiUpdateSettings,
  aiGetUsage,
  aiListKnowledge,
  aiCreateKnowledge,
  aiUpdateKnowledge,
  aiDeleteKnowledge,
  type AiSettings,
  type AiUsage,
  type AiKnowledgeEntry,
} from '@/lib/ai';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { cn, mediaUrl } from '@/lib/utils';
import {
  NOTIFICATION_TONES,
  getSelectedTone,
  setSelectedTone,
  playTone,
} from '@/lib/notification-sound';
import type {
  OnboardingStatusView,
  TeamMember,
  TeamRole,
  ShopifyOrderConfig,
  ShopifyOrderConfigResponse,
  Template,
} from '@/lib/crm-types';

type Tab = 'whatsapp' | 'team' | 'shopify' | 'ai' | 'security' | 'profile';

export default function SettingsPage() {
  const { user } = useAuth();
  const canManageTeam = user?.role === 'owner' || user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('whatsapp');
  const tabs: Array<[Tab, string]> = [
    ['whatsapp', 'WhatsApp'],
    ...(canManageTeam ? ([['team', 'Team']] as Array<[Tab, string]>) : []),
    ...(canManageTeam ? ([['shopify', 'Shopify']] as Array<[Tab, string]>) : []),
    ['ai', 'AI'],
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
      {tab === 'shopify' && canManageTeam && <ShopifyTab />}
      {tab === 'ai' && <AiTab canManage={canManageTeam} />}
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

const LOGO_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
];
const LOGO_MAX = 2 * 1024 * 1024;

function CompanyBrandingCard() {
  const { user, setCompanyLogo } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const company = user?.company ?? null;
  const logo = company?.logo_url ?? null;

  const pick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!LOGO_MIMES.includes(file.type)) {
      toast.error('Use a JPEG, PNG, WebP or SVG image');
      return;
    }
    if (file.size > LOGO_MAX) {
      toast.error('Logo must be 2MB or smaller');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await postMultipart<{ logo_url: string }>(
        '/settings/company/logo',
        fd,
      );
      setCompanyLogo(res.logo_url);
      toast.success('Logo updated');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.userMessage : 'Upload failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiFetch('/settings/company/logo', { method: 'DELETE' });
      setCompanyLogo(null);
      setConfirmRemove(false);
      toast.success('Logo removed');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.userMessage : 'Remove failed',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div>
        <p className="font-semibold text-gray-800">Company branding</p>
        <p className="text-sm text-gray-500 mt-1">
          Shown in the top bar for everyone on your team.
        </p>
      </div>
      <div className="flex items-center gap-4">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl(logo) ?? ''}
            alt={company?.name ?? 'Logo'}
            className="w-16 h-16 rounded-lg object-contain bg-gray-50 border border-gray-200"
          />
        ) : (
          <span className="w-16 h-16 rounded-lg bg-gray-100 text-gray-500 flex items-center justify-center text-xl font-semibold">
            {company?.name?.[0]?.toUpperCase() ?? '?'}
          </span>
        )}
        <div className="flex flex-col gap-2">
          <button
            onClick={pick}
            disabled={busy}
            className="flex items-center gap-2 text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
          >
            <Upload size={15} />
            {busy ? 'Working…' : logo ? 'Replace logo' : 'Upload logo'}
          </button>
          {logo && (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
              className="flex items-center gap-2 text-sm text-red-600 hover:bg-red-50 px-4 py-2 rounded-lg disabled:opacity-50"
            >
              <Trash2 size={15} />
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-400">
        JPEG, PNG, WebP or SVG · max 2MB.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/svg+xml"
        className="hidden"
        onChange={onFile}
      />
      <ConfirmDialog
        open={confirmRemove}
        title="Remove company logo?"
        message="The top bar will fall back to your company initials."
        danger
        confirmLabel="Remove"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}

function NotificationsCard() {
  const [selected, setSelected] = useState('chime');

  useEffect(() => {
    setSelected(getSelectedTone().id);
  }, []);

  const choose = (id: string) => {
    setSelected(id);
    setSelectedTone(id);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div>
        <p className="font-semibold text-gray-800">Notification sound</p>
        <p className="text-sm text-gray-500 mt-1">
          Played when a new WhatsApp message arrives.
        </p>
      </div>
      <div className="space-y-2">
        {NOTIFICATION_TONES.map((t) => (
          <label
            key={t.id}
            className={cn(
              'flex items-center gap-3 border rounded-lg px-3 py-2.5 cursor-pointer',
              selected === t.id
                ? 'border-green-500 bg-green-50'
                : 'border-gray-200 hover:bg-gray-50',
            )}
          >
            <input
              type="radio"
              name="tone"
              checked={selected === t.id}
              onChange={() => choose(t.id)}
            />
            <span className="flex-1 text-sm text-gray-800">{t.label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                playTone(t.src);
              }}
              className="flex items-center gap-1 text-xs text-green-600 hover:underline"
            >
              <Play size={13} /> Play preview
            </button>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">
        These settings are per-device and per-browser.
      </p>
    </div>
  );
}

function ProfileTab() {
  const { user } = useAuth();
  const toast = useToast();
  const canBrand = user?.role === 'owner' || user?.role === 'admin';
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
      {canBrand && <CompanyBrandingCard />}
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

      <NotificationsCard />
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

function templateBody(t: Template): string {
  const body = t.content?.components?.find(
    (c) => (c.type || '').toString().toLowerCase() === 'body',
  );
  return body?.text ?? '';
}

function extractSlots(text: string): string[] {
  const found = new Set<string>();
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.add(m[1]);
  return Array.from(found).sort((a, b) => Number(a) - Number(b));
}

function ShopifyOrderConfigCard() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<Array<{ key: string; label: string }>>(
    [],
  );
  const [templates, setTemplates] = useState<Template[]>([]);
  const [apiVersions, setApiVersions] = useState<string[]>([]);
  const [webhookKey, setWebhookKey] = useState('');
  const [secretSet, setSecretSet] = useState(false);
  const [adminSet, setAdminSet] = useState(false);
  const [secret, setSecret] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [savingCred, setSavingCred] = useState(false);
  const [savingTpl, setSavingTpl] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  const [cfg, setCfg] = useState<ShopifyOrderConfig>({
    enabled: false,
    templateId: null,
    languageCode: null,
    variableMap: {},
    confirmTag: 'confirmed',
    cancelTag: 'cancelled',
    pendingTag: 'confirmation pending',
    decisionWindowMinutes: 2,
    shopDomain: '',
    apiVersion: '',
  });

  const applyResp = useCallback((res: ShopifyOrderConfigResponse) => {
    setCfg(res.config);
    setFields(res.fields);
    setApiVersions(res.apiVersions);
    setWebhookKey(res.webhookKey);
    setSecretSet(res.webhookSecretSet);
    setAdminSet(res.adminTokenSet);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, tpls] = await Promise.all([
        apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/order-config'),
        apiFetch<Template[]>('/templates', { params: { status: 'approved' } }),
      ]);
      applyResp(res);
      setTemplates(tpls);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load Shopify config',
      );
    } finally {
      setLoading(false);
    }
  }, [toast, applyResp]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = templates.find((t) => t.id === cfg.templateId) ?? null;
  const slots = selected ? extractSlots(templateBody(selected)) : [];

  const saveCredentials = async () => {
    setSavingCred(true);
    try {
      const res = await apiFetch<ShopifyOrderConfigResponse>(
        '/settings/shopify/credentials',
        {
          method: 'PATCH',
          body: {
            ...(secret.trim() ? { webhookSecret: secret.trim() } : {}),
            ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}),
            shopDomain: cfg.shopDomain.trim(),
            apiVersion: cfg.apiVersion,
          },
        },
      );
      applyResp(res);
      setSecret('');
      setAdminToken('');
      toast.success('Credentials saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSavingCred(false);
    }
  };

  const saveTemplate = async () => {
    if (cfg.enabled && !cfg.templateId) {
      toast.error('Pick an approved template to enable');
      return;
    }
    setSavingTpl(true);
    try {
      const res = await apiFetch<ShopifyOrderConfigResponse>(
        '/settings/shopify/template',
        {
          method: 'PATCH',
          body: {
            enabled: cfg.enabled,
            templateId: cfg.templateId,
            variableMap: cfg.variableMap,
          },
        },
      );
      applyResp(res);
      toast.success('Template saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSavingTpl(false);
    }
  };

  const saveTags = async () => {
    if (!cfg.confirmTag.trim() || !cfg.cancelTag.trim()) {
      toast.error('Confirm and Cancel tag names are required');
      return;
    }
    setSavingTags(true);
    try {
      const res = await apiFetch<ShopifyOrderConfigResponse>(
        '/settings/shopify/tags',
        {
          method: 'PATCH',
          body: {
            confirmTag: cfg.confirmTag.trim(),
            cancelTag: cfg.cancelTag.trim(),
            pendingTag: cfg.pendingTag.trim(),
            decisionWindowMinutes: cfg.decisionWindowMinutes,
          },
        },
      );
      applyResp(res);
      toast.success('Tags saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSavingTags(false);
    }
  };

  if (loading)
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 flex justify-center">
        <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  const card = 'bg-white border border-gray-200 rounded-xl p-5 space-y-4';
  const saveBtn =
    'text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg disabled:opacity-50';

  return (
    <div className="space-y-5">
      {/* Block 1 — Credentials */}
      <div className={card}>
        <p className="font-semibold text-gray-800">1 · Shopify credentials</p>
        <CopyField
          label="Your Shopify webhook URL (orders/create)"
          value={webhookKey ? `${origin}/webhooks/shopify/${webhookKey}` : '—'}
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Webhook signing secret{' '}
              <span className="text-gray-400">
                ({secretSet ? 'set — blank = keep' : 'not set'})
              </span>
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={secretSet ? '••••••••' : 'paste secret'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Admin API access token{' '}
              <span className="text-gray-400">
                ({adminSet ? 'set — blank = keep' : 'not set'})
              </span>
            </label>
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder={adminSet ? '••••••••' : 'shpat_…'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Store domain
            </label>
            <input
              value={cfg.shopDomain}
              onChange={(e) => setCfg({ ...cfg, shopDomain: e.target.value })}
              placeholder="your-store.myshopify.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Shopify API version
            </label>
            <select
              value={cfg.apiVersion}
              onChange={(e) => setCfg({ ...cfg, apiVersion: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {apiVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-[11px] text-gray-400">
          Secrets are encrypted and never shown again. Phone numbers from
          Shopify are auto-normalized to international format.
        </p>
        <button
          type="button"
          onClick={saveCredentials}
          disabled={savingCred}
          className={saveBtn}
        >
          {savingCred ? 'Saving…' : 'Save credentials'}
        </button>
      </div>

      {/* Block 2 — Template */}
      <div className={card}>
        <div className="flex items-center justify-between">
          <p className="font-semibold text-gray-800">
            2 · Order-confirmation template
          </p>
          <label className="flex items-center gap-2 text-sm text-gray-700 shrink-0">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Approved template
          </label>
          <select
            value={cfg.templateId ?? ''}
            onChange={(e) =>
              setCfg({
                ...cfg,
                templateId: e.target.value ? Number(e.target.value) : null,
                variableMap: {},
              })
            }
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Select a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templates.length === 0 && (
            <p className="text-xs text-gray-400 mt-1">
              No approved templates yet — create one with Confirm/Cancel
              buttons under Templates.
            </p>
          )}
        </div>
        {selected && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap">
            {templateBody(selected) || '(no body text)'}
          </div>
        )}
        {slots.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Map each template variable to a Shopify order field
            </p>
            {slots.map((s) => (
              <div key={s} className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-12">{`{{${s}}}`}</span>
                <select
                  value={cfg.variableMap[s] ?? ''}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      variableMap: {
                        ...cfg.variableMap,
                        [s]: e.target.value,
                      },
                    })
                  }
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">— choose field —</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={saveTemplate}
          disabled={savingTpl}
          className={saveBtn}
        >
          {savingTpl ? 'Saving…' : 'Save template'}
        </button>
      </div>

      {/* Block 3 — Tags */}
      <div className={card}>
        <p className="font-semibold text-gray-800">3 · Order tags</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Confirm → order tag
            </label>
            <input
              value={cfg.confirmTag}
              onChange={(e) => setCfg({ ...cfg, confirmTag: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Cancel → order tag
            </label>
            <input
              value={cfg.cancelTag}
              onChange={(e) => setCfg({ ...cfg, cancelTag: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              No-answer → pending tag
            </label>
            <input
              value={cfg.pendingTag}
              onChange={(e) => setCfg({ ...cfg, pendingTag: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Decision window (minutes)
            </label>
            <input
              type="number"
              min={1}
              value={cfg.decisionWindowMinutes}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  decisionWindowMinutes: Number(e.target.value) || 1,
                })
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        <p className="text-[11px] text-gray-400">
          Only these three tags are ever changed — your other Shopify tags
          are never touched. Confirm/Cancel is reversible.
        </p>
        <button
          type="button"
          onClick={saveTags}
          disabled={savingTags}
          className={saveBtn}
        >
          {savingTags ? 'Saving…' : 'Save tags'}
        </button>
      </div>
    </div>
  );
}

function ShopifyTab() {
  return (
    <div className="max-w-2xl">
      <p className="text-sm text-gray-500 mb-4">
        Connect your own Shopify custom app. Each block saves independently —
        add the <code className="text-xs">orders/create</code> webhook to the
        URL in block 1.
      </p>
      <ShopifyOrderConfigCard />
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

// ── AI Copilot tab ───────────────────────────────────────────────────────
// Agents (canManage=false) see ONLY the knowledge-base editor — the AI settings
// (enable, auto-reply, brand voice, spend cap, usage) are owner/admin-only.
function AiTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // editable mirrors
  const [enabled, setEnabled] = useState(true);
  const [autoReply, setAutoReply] = useState(false);
  const [tone, setTone] = useState('');
  const [lang, setLang] = useState('');
  const [capDollars, setCapDollars] = useState('');

  const load = useCallback(async () => {
    // Agents don't load workspace AI settings — they only manage the KB.
    if (!canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [s, u] = await Promise.all([
        aiGetSettings(),
        aiGetUsage().catch(() => null),
      ]);
      setSettings(s);
      setEnabled(s.aiEnabled);
      setAutoReply(s.autoReplyEnabled);
      setTone(s.brandTone ?? '');
      setLang(s.defaultLanguage ?? '');
      setCapDollars(
        s.monthlyCapCents != null ? (s.monthlyCapCents / 100).toString() : '',
      );
      setUsage(u);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load AI settings');
    } finally {
      setLoading(false);
    }
  }, [toast, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const capTrim = capDollars.trim();
      const monthlyCapCents =
        capTrim === '' ? null : Math.round(parseFloat(capTrim) * 100);
      if (monthlyCapCents != null && (isNaN(monthlyCapCents) || monthlyCapCents < 0)) {
        toast.error('Enter a valid monthly cap.');
        setSaving(false);
        return;
      }
      const updated = await aiUpdateSettings({
        aiEnabled: enabled,
        autoReplyEnabled: autoReply,
        brandTone: tone.trim() ? tone.trim() : null,
        defaultLanguage: lang.trim() ? lang.trim() : null,
        monthlyCapCents,
      });
      setSettings(updated);
      toast.success('AI settings saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Agent view: knowledge base only (no workspace settings / usage / plan gate).
  if (!canManage) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="bg-violet-50 border border-violet-100 rounded-lg p-4 text-sm text-violet-800">
          Add knowledge the AI uses to answer customers — shipping &amp; return
          policy, pricing, FAQs, product details. The more you add, the more
          accurate its replies and suggestions.
        </div>
        <AiKnowledgeEditor />
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (settings && !settings.planAiEnabled) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        AI Copilot is not included in your current plan. Contact your account
        manager to enable it.
      </div>
    );
  }

  const billed = usage ? (usage.billedCents / 100).toFixed(2) : '0.00';
  const cap = usage && usage.capCents > 0 ? (usage.capCents / 100).toFixed(2) : null;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Usage card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          This month&apos;s AI usage
        </h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-violet-600">
              {usage?.requests ?? 0}
            </p>
            <p className="text-xs text-gray-500">requests</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">${billed}</p>
            <p className="text-xs text-gray-500">
              billed{cap ? ` / $${cap} cap` : ''}
            </p>
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">
              {((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toLocaleString()}
            </p>
            <p className="text-xs text-gray-500">tokens</p>
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
          />
          <span className="text-sm text-gray-800">
            Enable AI Copilot for this workspace
          </span>
        </label>

        <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={autoReply}
              onChange={(e) => setAutoReply(e.target.checked)}
              disabled={!enabled}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
            />
            <span className="text-sm text-gray-800">
              <span className="font-medium">Auto-reply to customers</span> — let
              the AI answer inbound messages automatically (within the 24-hour
              window) when no keyword bot handles them and no agent is assigned.
              <span className="block text-xs text-gray-500 mt-1">
                Confidence-gated: the AI hands off to a human (marks the chat{' '}
                <em>pending</em> + <em>needs-human</em>) whenever it&apos;s
                unsure or the request is sensitive. Nothing is sent outside the
                24-hour window.
              </span>
            </span>
          </label>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Brand voice / tone
          </label>
          <textarea
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Friendly and concise. Use simple words. Always thank the customer."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <p className="text-xs text-gray-400 mt-1">
            Shapes how the assistant writes suggested replies and rewrites.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Default reply language
            </label>
            <input
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              placeholder="e.g. English, Urdu, Roman Urdu"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Monthly spend cap (USD, blank = platform default)
            </label>
            <input
              value={capDollars}
              onChange={(e) => setCapDollars(e.target.value)}
              inputMode="decimal"
              placeholder="0 = unlimited"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <AiKnowledgeEditor />
    </div>
  );
}

function AiKnowledgeEditor() {
  const toast = useToast();
  const [rows, setRows] = useState<AiKnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AiKnowledgeEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiKnowledgeEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await aiListKnowledge());
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setShowForm(true);
  };
  const openEdit = (e: AiKnowledgeEntry) => {
    setEditing(e);
    setTitle(e.title);
    setContent(e.content);
    setShowForm(true);
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are required.');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await aiUpdateKnowledge(editing.id, { title, content });
      } else {
        await aiCreateKnowledge({ title, content });
      }
      setShowForm(false);
      await load();
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (e: AiKnowledgeEntry) => {
    try {
      await aiUpdateKnowledge(e.id, { enabled: !e.enabled });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.userMessage : 'Failed');
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await aiDeleteKnowledge(deleteTarget.id);
      setDeleteTarget(null);
      await load();
      toast.success('Deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Knowledge base</h3>
          <p className="text-xs text-gray-400">
            FAQs, policies and product info the assistant uses to answer
            accurately.
          </p>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No entries yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((e) => (
            <li key={e.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {e.title}
                </p>
                <p className="text-xs text-gray-400 truncate">{e.content}</p>
              </div>
              <button
                onClick={() => toggle(e)}
                className={cn(
                  'text-xs px-2 py-1 rounded-full',
                  e.enabled
                    ? 'bg-green-50 text-green-700'
                    : 'bg-gray-100 text-gray-500',
                )}
              >
                {e.enabled ? 'On' : 'Off'}
              </button>
              <button
                onClick={() => openEdit(e)}
                className="p-1.5 text-gray-500 hover:text-gray-800"
                title="Edit"
              >
                <Plus size={14} className="rotate-45" />
              </button>
              <button
                onClick={() => setDeleteTarget(e)}
                className="p-1.5 text-gray-500 hover:text-red-600"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? 'Edit entry' : 'New entry'}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="e.g. Return policy"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              maxLength={20000}
              placeholder="Write the facts the assistant should know…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete entry"
        message={`Delete "${deleteTarget?.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
