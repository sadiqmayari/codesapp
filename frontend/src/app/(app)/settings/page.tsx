'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Copy,
  Check,
  Plus,
  UserX,
  Trash2,
  Upload,
  Play,
  RefreshCw,
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
import {
  getGameConfig,
  updateGameConfig,
  type GameConfig,
} from '@/lib/gamification';
import {
  COURIER_TYPES,
  COURIER_LABELS,
  COURIER_CREDENTIAL_FIELDS,
  getCourierSettings,
  setCourierCredentials,
  deleteCourierCredentials,
  getTraxPickupAddresses,
  getMnpLocations,
  seedMnpCities,
  getCityCoverage,
  bulkSetDefaultCourier,
  clearDefaultCourier,
  type CourierType,
  type CourierStatusRow,
  type CourierField,
  type CityCoverageRow,
} from '@/lib/couriers';
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

type Tab =
  | 'whatsapp'
  | 'team'
  | 'shopify'
  | 'courier'
  | 'ai'
  | 'competition'
  | 'security'
  | 'profile';

export default function SettingsPage() {
  const { user } = useAuth();
  const canManageTeam = user?.role === 'owner' || user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('whatsapp');
  const tabs: Array<[Tab, string]> = [
    ['whatsapp', 'WhatsApp'],
    ...(canManageTeam ? ([['team', 'Team']] as Array<[Tab, string]>) : []),
    ...(canManageTeam ? ([['shopify', 'Shopify']] as Array<[Tab, string]>) : []),
    ...(canManageTeam ? ([['courier', 'Courier']] as Array<[Tab, string]>) : []),
    ['ai', 'AI'],
    ...(canManageTeam
      ? ([['competition', 'Competition']] as Array<[Tab, string]>)
      : []),
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
      {tab === 'courier' && canManageTeam && <CourierTab />}
      {tab === 'ai' && <AiTab canManage={canManageTeam} />}
      {tab === 'competition' && canManageTeam && <CompetitionTab />}
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

// Full IANA timezone list (modern browsers), with a curated set floated to the
// top for quick access. Falls back to the curated set on older browsers.
const COMMON_TZS = [
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];
function allTimezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;
    if (!supported) return COMMON_TZS;
    const all = supported('timeZone');
    const rest = all.filter((t) => !COMMON_TZS.includes(t));
    return [...COMMON_TZS, ...rest];
  } catch {
    return COMMON_TZS;
  }
}

function CompanyTimezoneCard() {
  const { user, setCompanyTimezone } = useAuth();
  const toast = useToast();
  const current = user?.company?.timezone ?? '';
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => allTimezones(), []);

  // Live "now" in the picked zone so the owner can confirm it's the right clock.
  const nowInZone = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: value || browserTz,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date());
    } catch {
      return '';
    }
  }, [value, browserTz]);

  const save = async () => {
    setBusy(true);
    try {
      const tz = value || null;
      await apiFetch('/auth/company/timezone', {
        method: 'PATCH',
        body: { timezone: tz },
      });
      setCompanyTimezone(tz);
      toast.success('Timezone updated');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div>
        <p className="font-semibold text-gray-800">Timezone</p>
        <p className="text-sm text-gray-500 mt-1">
          All dates, times and date-range reports (dashboard, analytics, orders)
          use this clock for everyone on your team. Leave as “Browser default”
          to follow each viewer’s device.
        </p>
      </div>
      <div>
        <label className="block text-sm text-gray-600 mb-1">Company timezone</label>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">Browser default ({browserTz})</option>
          {zones.map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        {nowInZone && (
          <p className="text-xs text-gray-500 mt-1.5">
            Now in this timezone: <span className="font-medium">{nowInZone}</span>
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy || value === current}
        className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save timezone'}
      </button>
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

function PublicTrackingCard() {
  const toast = useToast();
  const [current, setCurrent] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<{ public_slug: string | null }>('/settings/company/public-slug')
      .then((r) => {
        if (!alive) return;
        setCurrent(r.public_slug);
        setValue(r.public_slug ?? '');
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const clean = value.trim().toLowerCase();
  const valid = clean === '' || /^[a-z0-9-]{2,80}$/.test(clean);

  const save = async () => {
    if (!valid) {
      toast.error('Use 2–80 lowercase letters, numbers or hyphens');
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch<{ public_slug: string | null }>(
        '/settings/company/public-slug',
        { method: 'PATCH', body: { slug: clean || null } },
      );
      setCurrent(r.public_slug);
      setValue(r.public_slug ?? '');
      toast.success(r.public_slug ? 'Tracking handle saved' : 'Tracking handle cleared');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const previewBase =
    typeof window !== 'undefined' ? `${window.location.origin}/track` : '/track';

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div>
        <p className="font-semibold text-gray-800">Order tracking page</p>
        <p className="text-sm text-gray-500 mt-1">
          Your public handle for branded per-order tracking links. Map a template
          variable to <span className="font-mono text-gray-600">Order tracking page URL</span>{' '}
          in Shopify settings to send it to customers.
        </p>
      </div>
      <div>
        <label className="block text-sm text-gray-600 mb-1">Handle</label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400 shrink-0 hidden sm:inline">
            {previewBase}/
          </span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="your-store"
            disabled={loading || busy}
            className={cn(
              'flex-1 border rounded-lg px-3 py-2 text-sm',
              valid ? 'border-gray-300' : 'border-red-400',
            )}
          />
        </div>
        {clean && (
          <p className="text-[11px] text-gray-400 mt-1 break-all">
            Links look like {previewBase}/{clean}/&lt;order-id&gt;
          </p>
        )}
      </div>
      <button
        onClick={save}
        disabled={loading || busy || clean === (current ?? '')}
        className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save handle'}
      </button>
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
      {canBrand && <CompanyTimezoneCard />}
      {canBrand && <PublicTrackingCard />}
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
    role: 'agent' as 'admin' | 'agent' | 'finance' | 'fulfillment',
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
                            <option value="finance">finance</option>
                            <option value="fulfillment">fulfillment</option>
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
                role: e.target.value as 'admin' | 'agent' | 'finance' | 'fulfillment',
              })
            }
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="agent">Agent</option>
            <option value="finance">Finance (view-only payments)</option>
            <option value="fulfillment">Fulfillment (orders only, no payments)</option>
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
  const [savingAbandoned, setSavingAbandoned] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [savingProactive, setSavingProactive] = useState(false);
  const [proactivePlan, setProactivePlan] = useState(false);
  const [proactiveEnabled, setProactiveEnabled] = useState(false);
  const [deliveryEvents, setDeliveryEvents] = useState<
    Array<{ key: string; label: string; source: string }>
  >([]);
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
    deliveryNotifications: {},
    abandonedCartDelayMinutes: 180,
  });

  const applyResp = useCallback((res: ShopifyOrderConfigResponse) => {
    setCfg(res.config);
    setFields(res.fields);
    setApiVersions(res.apiVersions);
    setWebhookKey(res.webhookKey);
    setSecretSet(res.webhookSecretSet);
    setAdminSet(res.adminTokenSet);
    setProactivePlan(res.proactivePlan);
    setProactiveEnabled(res.proactiveEnabled);
    setDeliveryEvents(res.deliveryEvents);
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
  // Block 2b — the manual abandoned-cart message (independent selection).
  const abandonedTpl =
    templates.find(
      (t) => t.id === cfg.abandonedManualTemplate?.templateId,
    ) ?? null;
  const abandonedSlots = abandonedTpl
    ? extractSlots(templateBody(abandonedTpl))
    : [];
  // Helper to read/patch a single delivery event's config.
  const evtCfg = (key: string) =>
    cfg.deliveryNotifications[key] ?? {
      templateId: null,
      variableMap: {},
      enabled: false,
    };
  const patchEvt = (
    key: string,
    patch: Partial<{
      templateId: number | null;
      variableMap: Record<string, string>;
      enabled: boolean;
    }>,
  ) =>
    setCfg({
      ...cfg,
      deliveryNotifications: {
        ...cfg.deliveryNotifications,
        [key]: { ...evtCfg(key), ...patch },
      },
    });

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

  /**
   * Block 5 — the manual abandoned-cart template. Its OWN endpoint, exactly
   * like the confirmation template; the timed auto-send stays under block 4.
   */
  const saveAbandonedTemplate = async () => {
    setSavingAbandoned(true);
    try {
      const res = await apiFetch<ShopifyOrderConfigResponse>(
        '/settings/shopify/abandoned-template',
        {
          method: 'PATCH',
          body: {
            templateId: cfg.abandonedManualTemplate?.templateId ?? null,
            variableMap: cfg.abandonedManualTemplate?.variableMap ?? {},
          },
        },
      );
      applyResp(res);
      toast.success('Abandoned-cart message saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSavingAbandoned(false);
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

  const saveProactive = async () => {
    const anyReady = deliveryEvents.some((e) => {
      const c = cfg.deliveryNotifications[e.key];
      return c?.enabled && c?.templateId;
    });
    if (proactiveEnabled && !anyReady) {
      toast.error('Enable at least one event with an approved template');
      return;
    }
    setSavingProactive(true);
    try {
      const res = await apiFetch<ShopifyOrderConfigResponse>(
        '/settings/shopify/proactive',
        {
          method: 'PATCH',
          body: {
            enabled: proactiveEnabled,
            notifications: cfg.deliveryNotifications,
            abandonedCartDelayMinutes: cfg.abandonedCartDelayMinutes,
            abandonedCartSteps: cfg.abandonedCartSteps ?? [],
          },
        },
      );
      applyResp(res);
      toast.success('Notifications saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSavingProactive(false);
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

      {/*
        Block 2b — Abandoned-cart message. A COMPLETELY separate block (own
        template, own variable mapping, own Save + endpoint), mirroring the
        confirmation template above. Powers the per-row "Send message" button on
        Orders → Abandoned Checkouts. The TIMED auto-send is unrelated and stays
        under block 4 · Delivery notifications.
      */}
      <div className={card}>
        <p className="font-semibold text-gray-800">
          2b · Abandoned-cart message
        </p>
        <p className="text-[11px] text-gray-500">
          Sent by the <b>Send message</b> button on Orders → Abandoned Checkouts.
          Works on its own — the automatic timed recovery is configured
          separately under <b>4 · Delivery notifications</b>.
        </p>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Approved template
          </label>
          <select
            value={cfg.abandonedManualTemplate?.templateId ?? ''}
            onChange={(e) =>
              setCfg({
                ...cfg,
                abandonedManualTemplate: e.target.value
                  ? { templateId: Number(e.target.value), variableMap: {} }
                  : null,
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
              No approved templates yet — create one under Templates.
            </p>
          )}
        </div>
        {abandonedTpl && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap">
            {templateBody(abandonedTpl) || '(no body text)'}
          </div>
        )}
        {abandonedSlots.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Map each template variable to a Shopify field
            </p>
            {abandonedSlots.map((s) => (
              <div key={s} className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-12">{`{{${s}}}`}</span>
                <select
                  value={cfg.abandonedManualTemplate?.variableMap?.[s] ?? ''}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      abandonedManualTemplate: {
                        templateId:
                          cfg.abandonedManualTemplate?.templateId ?? null,
                        variableMap: {
                          ...(cfg.abandonedManualTemplate?.variableMap ?? {}),
                          [s]: e.target.value,
                        },
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
          onClick={saveAbandonedTemplate}
          disabled={savingAbandoned}
          className={saveBtn}
        >
          {savingAbandoned ? 'Saving…' : 'Save abandoned-cart message'}
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

      {/* Block 4 — Delivery notifications (per-event) */}
      <div className={card}>
        <div className="flex items-center justify-between">
          <p className="font-semibold text-gray-800">4 · Delivery notifications</p>
          {!proactivePlan && (
            <span className="text-[11px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">
              Not in your plan
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          Auto-send an approved WhatsApp template as an order moves through
          delivery. Turn on the events you want and pick a template for each;
          templates send even outside the 24-hour window.
        </p>
        {!proactivePlan ? (
          <p className="text-[12px] text-gray-400">
            Contact your administrator to enable delivery notifications on your
            plan.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={proactiveEnabled}
                onChange={(e) => setProactiveEnabled(e.target.checked)}
              />
              Enable delivery notifications
            </label>
            {templates.length === 0 && (
              <p className="text-[11px] text-amber-600">
                No approved templates yet — create one first.
              </p>
            )}

            <div
              className={`space-y-2 ${
                proactiveEnabled ? '' : 'opacity-50 pointer-events-none'
              }`}
            >
              {deliveryEvents.map((ev) => {
                const ec = evtCfg(ev.key);
                const sel =
                  templates.find((t) => t.id === ec.templateId) ?? null;
                const slots = sel ? extractSlots(templateBody(sel)) : [];
                return (
                  <div
                    key={ev.key}
                    className="border border-gray-200 rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={ec.enabled}
                          onChange={(e) =>
                            patchEvt(ev.key, { enabled: e.target.checked })
                          }
                        />
                        <span className="font-medium">{ev.label}</span>
                      </label>
                      <span className="text-[10px] text-gray-400 font-mono">
                        {ev.source}
                      </span>
                    </div>
                    {ec.enabled && (
                      <div className="pl-6 space-y-2">
                        {ev.key === 'abandoned_cart' && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              Wait
                            </span>
                            <input
                              type="number"
                              min={1}
                              value={Math.round(
                                cfg.abandonedCartDelayMinutes / 60,
                              )}
                              onChange={(e) =>
                                setCfg({
                                  ...cfg,
                                  abandonedCartDelayMinutes:
                                    (Number(e.target.value) || 1) * 60,
                                })
                              }
                              className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-sm"
                            />
                            <span className="text-xs text-gray-500">
                              hour(s) after the cart is abandoned, then send if no
                              order
                            </span>
                          </div>
                        )}
                        {ev.key === 'abandoned_cart' && (
                          <div className="border border-gray-200 rounded-lg p-2 space-y-2 bg-gray-50/60">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-gray-600">
                                Recovery sequence (optional)
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setCfg({
                                    ...cfg,
                                    abandonedCartSteps: [
                                      ...(cfg.abandonedCartSteps ?? []),
                                      { delayMinutes: 60, templateId: 0, variableMap: {} },
                                    ],
                                  })
                                }
                                className="text-xs text-green-700 hover:underline"
                              >
                                + Add step
                              </button>
                            </div>
                            {(cfg.abandonedCartSteps ?? []).length === 0 ? (
                              <p className="text-[11px] text-gray-400">
                                No sequence — the single template below sends once
                                after the wait above. Add steps to send multiple
                                nudges (e.g. 1h, 24h, 72h).
                              </p>
                            ) : (
                              (cfg.abandonedCartSteps ?? []).map((st, idx) => {
                                const stTpl =
                                  templates.find((t) => t.id === st.templateId) ??
                                  null;
                                const stSlots = stTpl
                                  ? extractSlots(templateBody(stTpl))
                                  : [];
                                const patchStep = (
                                  patch: Partial<(typeof st)>,
                                ) => {
                                  const steps = [...(cfg.abandonedCartSteps ?? [])];
                                  steps[idx] = { ...steps[idx], ...patch };
                                  setCfg({ ...cfg, abandonedCartSteps: steps });
                                };
                                return (
                                  <div
                                    key={idx}
                                    className="border border-gray-200 bg-white rounded-lg p-2 space-y-1"
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] text-gray-500 w-12">
                                        Step {idx + 1}
                                      </span>
                                      <input
                                        type="number"
                                        min={1}
                                        value={Math.max(
                                          1,
                                          Math.round(st.delayMinutes / 60),
                                        )}
                                        onChange={(e) =>
                                          patchStep({
                                            delayMinutes:
                                              (Number(e.target.value) || 1) * 60,
                                          })
                                        }
                                        className="w-16 border border-gray-300 rounded px-2 py-1 text-sm"
                                      />
                                      <span className="text-[11px] text-gray-500">
                                        h after abandon
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setCfg({
                                            ...cfg,
                                            abandonedCartSteps: (
                                              cfg.abandonedCartSteps ?? []
                                            ).filter((_, i) => i !== idx),
                                          })
                                        }
                                        className="ml-auto text-gray-400 hover:text-red-600"
                                        aria-label="Remove step"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                    <select
                                      value={st.templateId || ''}
                                      onChange={(e) =>
                                        patchStep({
                                          templateId: e.target.value
                                            ? Number(e.target.value)
                                            : 0,
                                          variableMap: {},
                                        })
                                      }
                                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                    >
                                      <option value="">Select a template…</option>
                                      {templates.map((t) => (
                                        <option key={t.id} value={t.id}>
                                          {t.name}
                                        </option>
                                      ))}
                                    </select>
                                    {stSlots.map((s) => (
                                      <div
                                        key={s}
                                        className="flex items-center gap-2"
                                      >
                                        <span className="text-[11px] font-mono text-gray-500 w-8">
                                          {`{{${s}}}`}
                                        </span>
                                        <select
                                          value={st.variableMap[s] ?? ''}
                                          onChange={(e) =>
                                            patchStep({
                                              variableMap: {
                                                ...st.variableMap,
                                                [s]: e.target.value,
                                              },
                                            })
                                          }
                                          className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
                                        >
                                          <option value="">Select a field…</option>
                                          {fields.map((f) => (
                                            <option key={f.key} value={f.key}>
                                              {f.label}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })
                            )}
                            {(cfg.abandonedCartSteps ?? []).length > 0 && (
                              <p className="text-[11px] text-amber-600">
                                A sequence REPLACES the single template below.
                              </p>
                            )}
                          </div>
                        )}
                        <select
                          value={ec.templateId ?? ''}
                          onChange={(e) =>
                            patchEvt(ev.key, {
                              templateId: e.target.value
                                ? Number(e.target.value)
                                : null,
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
                        {sel && (
                          <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 text-gray-600 whitespace-pre-wrap">
                            {templateBody(sel) || '(no body text)'}
                          </div>
                        )}
                        {slots.map((s) => (
                          <div key={s} className="flex items-center gap-2">
                            <span className="text-xs font-mono text-gray-500 w-10">
                              {`{{${s}}}`}
                            </span>
                            <select
                              value={ec.variableMap[s] ?? ''}
                              onChange={(e) =>
                                patchEvt(ev.key, {
                                  variableMap: {
                                    ...ec.variableMap,
                                    [s]: e.target.value,
                                  },
                                })
                              }
                              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                              <option value="">Select a field…</option>
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
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400">
              Shipped & Cancelled come from order events. Out-for-delivery,
              Delivered, Attempted and Failed depend on your carrier reporting
              tracking status to Shopify. Abandoned-cart recovery only fires for
              checkouts that captured a phone number.
            </p>
            <button
              type="button"
              onClick={saveProactive}
              disabled={savingProactive}
              className={saveBtn}
            >
              {savingProactive ? 'Saving…' : 'Save notifications'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ShopifyTab() {
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500">
        Connect your own Shopify custom app. Each block saves independently —
        add the <code className="text-xs">orders/create</code> webhook to the
        URL in block 1.
      </p>
      <ShopifyOrderConfigCard />
      <CheckoutWebhooksCard />
      <CancelledOrdersCard />
    </div>
  );
}

function CourierTab() {
  const toast = useToast();
  const [rows, setRows] = useState<CourierStatusRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getCourierSettings());
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-gray-500">
        Connect your courier accounts to book shipments, generate loadsheets,
        and receive delivery-status updates directly in the app. Credentials are
        encrypted and never shown again after saving.
      </p>
      <div className="max-w-2xl space-y-4">
        {rows === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          COURIER_TYPES.map((courierType) => (
            <CourierCredentialCard
              key={courierType}
              courierType={courierType}
              row={rows.find((r) => r.courierType === courierType)}
              onSaved={load}
              toastError={(m: string) => toast.error(m)}
              toastSuccess={(m: string) => toast.success(m)}
            />
          ))
        )}
      </div>
      <CityCoverageManager />
    </div>
  );
}

/**
 * City → courier mapping. Shows the tenant's own order cities with a chip per
 * courier (dimmed = doesn't serve, ring = the current default). Click a chip to
 * make that courier the city's default; or multi-select cities and assign a
 * courier in bulk. Busiest cities first.
 */
function CityCoverageManager() {
  const toast = useToast();
  const [rows, setRows] = useState<CityCoverageRow[] | null>(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await getCityCoverage());
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = (rows ?? []).filter((r) => {
    if (onlyUnmapped && r.defaultCourier) return false;
    if (q && !r.city.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const toggle = (cityName: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cityName)) next.delete(cityName);
      else next.add(cityName);
      return next;
    });

  const allShownSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.cityName));
  const toggleAllShown = () =>
    setSelected((prev) => {
      if (filtered.every((r) => prev.has(r.cityName))) return new Set();
      return new Set(filtered.map((r) => r.cityName));
    });

  // Single-city chip click = set that courier default for one city.
  const setOne = async (cityName: string, courierType: CourierType) => {
    setBusy(true);
    try {
      const res = await bulkSetDefaultCourier(courierType, [cityName]);
      if (res.set) {
        toast.success(`${COURIER_LABELS[courierType]} set as default`);
        await load();
      } else {
        toast.error(`${COURIER_LABELS[courierType]} doesn't serve this city`);
      }
    } catch {
      toast.error('Failed to set courier');
    } finally {
      setBusy(false);
    }
  };

  const bulkSet = async (courierType: CourierType) => {
    const cities = Array.from(selected);
    if (!cities.length) return;
    setBusy(true);
    try {
      const res = await bulkSetDefaultCourier(courierType, cities);
      toast.success(
        `${COURIER_LABELS[courierType]} set for ${res.set} cit${res.set === 1 ? 'y' : 'ies'}` +
          (res.skipped.length ? ` · ${res.skipped.length} skipped (not served)` : ''),
      );
      setSelected(new Set());
      await load();
    } catch {
      toast.error('Bulk assign failed');
    } finally {
      setBusy(false);
    }
  };

  const bulkClear = async () => {
    const cities = Array.from(selected);
    if (!cities.length) return;
    setBusy(true);
    try {
      const res = await clearDefaultCourier(cities);
      toast.success(`Cleared default on ${res.cleared} cit${res.cleared === 1 ? 'y' : 'ies'}`);
      setSelected(new Set());
      await load();
    } catch {
      toast.error('Clear failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">City → courier mapping</h3>
        <span className="text-xs text-gray-400">
          {rows ? `${rows.length} cities` : ''}
        </span>
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Pick which courier handles each city. Click a courier chip to set it as
        that city&apos;s default, or select several cities and assign one courier
        in bulk. A dimmed chip means that courier doesn&apos;t serve the city.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search city…"
          className="w-48 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={onlyUnmapped}
            onChange={(e) => setOnlyUnmapped(e.target.checked)}
          />
          Only unmapped
        </label>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <span className="text-sm text-green-800">
            {selected.size} cit{selected.size === 1 ? 'y' : 'ies'} — set default:
          </span>
          {COURIER_TYPES.map((c) => (
            <button
              key={c}
              onClick={() => bulkSet(c)}
              disabled={busy}
              className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {COURIER_LABELS[c]}
            </button>
          ))}
          <button
            onClick={bulkClear}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-gray-500 hover:underline"
          >
            Deselect
          </button>
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">
          {rows.length === 0
            ? 'No order cities yet — import Shopify orders first.'
            : 'No cities match.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-100">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={toggleAllShown}
                    className="cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2 font-medium">City</th>
                <th className="px-3 py-2 font-medium text-right">Orders</th>
                <th className="px-3 py-2 font-medium">Couriers (click to set default)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.slice(0, 300).map((r) => (
                <tr key={r.cityName} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.cityName)}
                      onChange={() => toggle(r.cityName)}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                    {r.city}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-500">{r.orders}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.couriers.map((c) => (
                        <button
                          key={c.courierType}
                          onClick={() => c.serves && setOne(r.cityName, c.courierType)}
                          disabled={!c.serves || busy}
                          title={
                            !c.serves
                              ? `${COURIER_LABELS[c.courierType]} doesn't serve ${r.city}`
                              : c.isDefault
                                ? 'Current default'
                                : `Set ${COURIER_LABELS[c.courierType]} as default`
                          }
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs border transition',
                            !c.serves
                              ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                              : c.isDefault
                                ? 'border-green-600 bg-green-600 text-white'
                                : 'border-gray-200 bg-white text-gray-600 hover:border-green-400',
                            !c.active && c.serves && 'opacity-70',
                          )}
                        >
                          {COURIER_LABELS[c.courierType]}
                          {!c.active && c.serves ? ' •' : ''}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 300 && (
            <p className="px-3 py-2 text-xs text-gray-400">
              Showing first 300 — refine with search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CourierCredentialCard({
  courierType,
  row,
  onSaved,
  toastError,
  toastSuccess,
}: {
  courierType: CourierType;
  row?: CourierStatusRow;
  onSaved: () => void;
  toastError: (m: string) => void;
  toastSuccess: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Runtime-loaded <select> options per field key (Trax pickup addresses,
  // M&P locations). null = loading; an entry in dynErr = failed.
  const [dynOpts, setDynOpts] = useState<
    Record<string, Array<{ id: string; label: string }> | null>
  >({});
  const [dynErr, setDynErr] = useState<Record<string, string>>({});
  const [seeding, setSeeding] = useState(false);
  const fields = COURIER_CREDENTIAL_FIELDS[courierType];
  const configured = !!row?.configured;

  // Open the editor pre-filled with saved non-secret values (secrets stay blank
  // and show a "saved" placeholder). For Trax, load pickup addresses so the
  // field is a dropdown rather than a raw id.
  const openEditor = () => {
    setValues({ ...(row?.savedValues ?? {}) });
    setOpen(true);
    if (configured) {
      for (const f of fields) {
        if (!f.dynamic) continue;
        const loader =
          f.dynamic === 'traxPickupAddresses'
            ? getTraxPickupAddresses
            : f.dynamic === 'mnpLocations'
              ? getMnpLocations
              : null;
        if (!loader) continue;
        const key = f.key;
        setDynOpts((m) => ({ ...m, [key]: null }));
        setDynErr((m) => {
          const n = { ...m };
          delete n[key];
          return n;
        });
        loader()
          .then((list) => setDynOpts((m) => ({ ...m, [key]: list })))
          .catch(() =>
            setDynErr((m) => ({ ...m, [key]: 'Could not load options.' })),
          );
      }
    }
  };

  const secretPlaceholder = (f: CourierField) =>
    row?.secretSet?.[f.key] ? '•••••• (saved — leave blank to keep)' : '';

  const save = async () => {
    // Non-secret fields always go up (they're pre-filled and editable in place);
    // secrets go up only when the user typed a new value. The backend merges.
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key] ?? '';
      if (f.type === 'secret') {
        if (v.trim()) payload[f.key] = v.trim();
      } else {
        payload[f.key] = v;
      }
    }

    // Required: secrets on first configuration; every non-optional, non-toggle
    // field must have a value.
    const missing = fields.filter((f) => {
      if (f.optional || f.type === 'toggle') return false;
      if (f.type === 'secret') return !configured && !payload[f.key]?.trim();
      // API-loaded dropdowns (Trax pickup address, M&P location) can't populate
      // until the credentials are saved, so don't require them on the FIRST save
      // — save the creds, reopen, then pick the value.
      if (f.dynamic) return configured && !payload[f.key]?.trim();
      return !payload[f.key]?.trim();
    });
    if (missing.length) {
      toastError(`Fill in: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }

    setBusy(true);
    try {
      await setCourierCredentials(courierType, payload);
      toastSuccess(`${COURIER_LABELS[courierType]} credentials saved`);
      setValues({});
      setOpen(false);
      onSaved();
    } catch (e) {
      toastError(
        e instanceof ApiError ? e.userMessage : 'Failed to save credentials',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteCourierCredentials(courierType);
      toastSuccess(`${COURIER_LABELS[courierType]} disconnected`);
      onSaved();
    } catch (e) {
      toastError(e instanceof ApiError ? e.userMessage : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  };

  // M&P has no static city list — fetch it once via the M&P API and seed it into
  // CodesApp (like the other couriers' seeded cities). One-time / re-runnable.
  const seedCities = async () => {
    setSeeding(true);
    try {
      const { seeded } = await seedMnpCities();
      toastSuccess(`Seeded ${seeded.toLocaleString()} M&P cities`);
    } catch (e) {
      toastError(e instanceof ApiError ? e.userMessage : 'Failed to fetch M&P cities');
    } finally {
      setSeeding(false);
    }
  };

  const webhookUrl =
    row?.webhookUrl && typeof window !== 'undefined'
      ? `${window.location.origin}${row.webhookUrl}`
      : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800">
          {COURIER_LABELS[courierType]}
        </h3>
        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full',
            row?.configured
              ? 'bg-green-50 text-green-700'
              : 'bg-gray-100 text-gray-500',
          )}
        >
          {row?.configured ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {webhookUrl && (
        <div className="mt-3">
          <CopyField label="Tracking webhook URL" value={webhookUrl} />
          <p className="text-[11px] text-gray-500 mt-1">
            Give this URL to {COURIER_LABELS[courierType]} so delivery status
            updates flow in automatically.
          </p>
        </div>
      )}

      {open ? (
        <div className="space-y-3 mt-3">
          {fields.map((f) => {
            const set = (val: string) =>
              setValues((v) => ({ ...v, [f.key]: val }));
            const val = values[f.key] ?? '';
            return (
              <div key={f.key}>
                <label className="block text-xs text-gray-500 mb-1">
                  {f.label}
                </label>

                {f.type === 'toggle' ? (
                  <button
                    type="button"
                    onClick={() => set(val === '1' ? '0' : '1')}
                    className={cn(
                      'relative inline-flex h-6 w-11 items-center rounded-full transition',
                      val === '1' ? 'bg-green-600' : 'bg-gray-300',
                    )}
                    aria-pressed={val === '1'}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white transition',
                        val === '1' ? 'translate-x-6' : 'translate-x-1',
                      )}
                    />
                  </button>
                ) : f.type === 'select' && f.dynamic ? (
                  (() => {
                    const opts = dynOpts[f.key];
                    const err = dynErr[f.key];
                    return (
                      <>
                        <select
                          value={val}
                          disabled={!opts}
                          onChange={(e) => set(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                        >
                          <option value="">
                            {opts
                              ? '— Select —'
                              : err
                                ? '— Unavailable —'
                                : configured
                                  ? 'Loading…'
                                  : 'Save the credentials first, then reopen'}
                          </option>
                          {/* Keep the saved id selectable before the list loads. */}
                          {!opts && val && (
                            <option value={val}>{`Saved (id ${val})`}</option>
                          )}
                          {opts?.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        {err && (
                          <p className="text-[11px] text-red-600 mt-1">{err}</p>
                        )}
                      </>
                    );
                  })()
                ) : f.type === 'select' ? (
                  <select
                    value={val}
                    onChange={(e) => set(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">— Select —</option>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === 'secret' ? 'password' : 'text'}
                    autoComplete="new-password"
                    placeholder={
                      f.type === 'secret' ? secretPlaceholder(f) : undefined
                    }
                    value={val}
                    onChange={(e) => set(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                )}

                {f.hint && (
                  <p className="text-[11px] text-gray-400 mt-1">{f.hint}</p>
                )}
              </div>
            );
          })}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save credentials'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValues({});
              }}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={openEditor}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            {row?.configured ? 'Edit credentials' : 'Add credentials'}
          </button>
          {courierType === 'mnp' && row?.configured && (
            <button
              type="button"
              onClick={seedCities}
              disabled={seeding}
              title="Fetch M&P's city list via API and store it in CodesApp (one-time; re-run to refresh)."
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {seeding ? 'Fetching cities…' : 'Fetch & seed cities'}
            </button>
          )}
          {row?.configured && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// One-click registration of the abandoned-cart (checkout) webhooks on the
// tenant's Shopify store via the Admin API — so carts flow in without hand-
// editing Shopify. Reads current status on mount.
function CheckoutWebhooksCard() {
  const toast = useToast();
  const [status, setStatus] = useState<{
    url: string;
    create: boolean;
    update: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<{ url: string; create: boolean; update: boolean }>(
        '/settings/shopify/checkout-webhook-status',
      );
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const register = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{
        url: string;
        results: Array<{ topic: string; ok: boolean; message: string }>;
        secretHint: string;
      }>('/settings/shopify/register-checkout-webhooks', { method: 'POST' });
      const ok = res.results.every((r) => r.ok);
      if (ok) toast.success('Checkout webhooks registered');
      else
        toast.error(
          res.results
            .filter((r) => !r.ok)
            .map((r) => `${r.topic}: ${r.message}`)
            .join(' · ') || 'Some webhooks failed',
        );
      await load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to register webhooks',
      );
    } finally {
      setBusy(false);
    }
  };

  const both = !!status && status.create && status.update;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-800 mb-1">
        Abandoned-cart webhooks
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Subscribes <code>checkouts/create</code> + <code>checkouts/update</code>{' '}
        on your store so abandoned carts appear in Orders → Abandoned Checkouts.
      </p>
      {loading ? (
        <p className="text-sm text-gray-400">Checking…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-4 text-sm">
            <WebhookDot label="checkouts/create" on={!!status?.create} />
            <WebhookDot label="checkouts/update" on={!!status?.update} />
          </div>
          {status?.url && (
            <code className="block bg-gray-50 border border-gray-200 rounded px-2 py-1 text-[11px] break-all text-gray-600">
              {status.url}
            </code>
          )}
          <button
            type="button"
            onClick={register}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {busy
              ? 'Registering…'
              : both
                ? 'Re-register webhooks'
                : 'Register checkout webhooks'}
          </button>
          <p className="text-[11px] text-amber-600">
            Note: set your Shopify webhook signing secret (block 1 above) to your
            custom app’s <b>API secret key</b> so these auto-registered webhooks
            verify.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Reconciles cancelled/voided state for orders created BEFORE cancellation
 * accounting shipped. Ongoing cancellations are handled automatically by the
 * orders/cancelled webhook — this is the one-time (re-runnable) catch-up.
 */
function CancelledOrdersCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      await apiFetch<{ started: boolean }>('/shopify/sync-cancellations', {
        method: 'POST',
      });
      toast.success(
        'Reconciliation started — cancelled orders will drop out of your totals shortly.',
      );
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to start reconciliation',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-800 mb-1">
        Cancelled &amp; voided orders
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Orders cancelled or voided on Shopify are automatically removed from
        order counts and revenue (the record stays in Orders, badged
        “Cancelled”). Run this once to apply it to orders placed before this
        feature shipped.
      </p>
      <button
        type="button"
        onClick={sync}
        disabled={busy}
        className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Reconcile cancelled orders'}
      </button>
    </div>
  );
}

function WebhookDot({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'h-2.5 w-2.5 rounded-full',
          on ? 'bg-green-500' : 'bg-gray-300',
        )}
      />
      <code className="text-xs text-gray-600">{label}</code>
    </span>
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
  const [autoOrder, setAutoOrder] = useState(false);
  const [autoOrderAll, setAutoOrderAll] = useState(false);
  const [tone, setTone] = useState('');
  const [lang, setLang] = useState('');
  const [capDollars, setCapDollars] = useState('');
  // 'default' = follow platform default; 'fast' = Standard; 'smart' = High-accuracy.
  const [tier, setTier] = useState<'default' | 'fast' | 'smart'>('default');
  const [vision, setVision] = useState(false);
  const [voice, setVoice] = useState(false);

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
      setAutoOrder(s.autoOrderEnabled);
      setAutoOrderAll(s.autoOrderAllEnabled);
      setTone(s.brandTone ?? '');
      setLang(s.defaultLanguage ?? '');
      setCapDollars(
        s.monthlyCapCents != null ? (s.monthlyCapCents / 100).toString() : '',
      );
      setTier(s.aiTier ?? 'default');
      setVision(s.visionEnabled);
      setVoice(s.voiceEnabled);
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
        autoOrderEnabled: autoOrder,
        autoOrderAllEnabled: autoOrderAll,
        brandTone: tone.trim() ? tone.trim() : null,
        defaultLanguage: lang.trim() ? lang.trim() : null,
        monthlyCapCents,
        aiTier: tier === 'default' ? null : tier,
        visionEnabled: vision,
        voiceEnabled: voice,
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

          <label className="mt-3 flex items-start gap-3 border-t border-violet-100 pt-3">
            <input
              type="checkbox"
              checked={autoOrderAll}
              onChange={(e) => setAutoOrderAll(e.target.checked)}
              disabled={!enabled || !autoReply}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
            />
            <span className="text-sm text-gray-800">
              <span className="font-medium">
                Auto-create orders for every auto-replied chat
              </span>{' '}
              — when on, EVERY chat the AI auto-replies to (above) can also place
              a Shopify order on customer request, not just chats you put in
              auto-pilot.
              <span className="block text-xs text-gray-500 mt-1">
                Requires &ldquo;Auto-reply to customers&rdquo; on, the
                &ldquo;Auto-create Shopify orders&rdquo; master toggle below on,
                and a connected Shopify store. The order is still only created
                after the customer confirms a summary (see below).
              </span>
            </span>
          </label>
        </div>

        <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={autoOrder}
              onChange={(e) => setAutoOrder(e.target.checked)}
              disabled={!enabled}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
            />
            <span className="text-sm text-gray-800">
              <span className="font-medium">Auto-create Shopify orders</span> —
              the master switch that lets the AI place Shopify orders. On a chat
              in <em>auto-pilot</em> (the ✨ menu) — or any auto-replied chat if
              the option above is on — once it has a complete order the AI sends
              the customer a summary and places the order only after they reply
              to confirm.
              <span className="block text-xs text-gray-500 mt-1">
                Requires a connected Shopify store. Safe by design: it always
                asks the customer to confirm a summary before creating; if a
                detail is missing it asks for it (or hands off) instead of
                creating a wrong order; and it creates at most one auto-order per
                conversation. Created orders are tagged <em>AI auto-order</em>.
              </span>
            </span>
          </label>
        </div>

        {/* AI quality + multimodal (tenant-selectable; super-admin can lock) */}
        {settings?.premiumLocked && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Premium AI (High-accuracy quality, reading photos and voice notes) is
            currently <span className="font-medium">restricted</span> for your
            account. Contact support to lift this.
          </div>
        )}

        <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-3 space-y-3">
          <div>
            <p className="text-sm font-medium text-gray-800">AI quality</p>
            <p className="text-xs text-gray-500">
              Governs the automated auto-reply &amp; order handling. You pay for
              what the AI uses — estimates below are billed amounts.
            </p>
          </div>

          {(
            [
              {
                value: 'fast' as const,
                title: 'Standard',
                note: 'Best value — great for everyday replies and orders.',
                cost: `≈ $${settings?.estimates.standardPer1kRepliesUsd.toFixed(2) ?? '0.00'} per 1,000 AI replies`,
              },
              {
                value: 'smart' as const,
                title: 'High-accuracy',
                note: 'Sharper on complex multi-product orders, tricky addresses & mixed-language (Roman Urdu) chats.',
                cost: `≈ $${settings?.estimates.highAccuracyPer1kRepliesUsd.toFixed(2) ?? '0.00'} per 1,000 AI replies`,
              },
              {
                value: 'default' as const,
                title: 'Follow recommended default',
                note: 'Use whatever the platform sets as the default quality.',
                cost: '',
              },
            ]
          ).map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 rounded-lg border p-2.5 cursor-pointer ${
                tier === opt.value
                  ? 'border-violet-300 bg-white'
                  : 'border-transparent hover:bg-white/60'
              } ${settings?.premiumLocked ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <input
                type="radio"
                name="ai-tier"
                checked={tier === opt.value}
                onChange={() => setTier(opt.value)}
                disabled={!enabled || settings?.premiumLocked}
                className="mt-0.5 h-4 w-4 border-gray-300 text-violet-600 focus:ring-violet-500"
              />
              <span className="text-sm text-gray-800">
                <span className="font-medium">{opt.title}</span>
                {opt.cost && (
                  <span className="ml-2 text-xs font-medium text-violet-700">
                    {opt.cost}
                  </span>
                )}
                <span className="block text-xs text-gray-500 mt-0.5">
                  {opt.note}
                </span>
              </span>
            </label>
          ))}

          <div className="border-t border-violet-100 pt-3 space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={vision}
                onChange={(e) => setVision(e.target.checked)}
                disabled={!enabled || settings?.premiumLocked}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
              />
              <span className="text-sm text-gray-800">
                <span className="font-medium">Read customer photos</span>
                <span className="ml-2 text-xs font-medium text-violet-700">
                  ≈ ${settings?.estimates.visionPer100PhotosUsd.toFixed(2) ?? '0.00'} per 100 photos
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  The AI looks at inbound product images to answer questions
                  about them.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={voice}
                onChange={(e) => setVoice(e.target.checked)}
                disabled={!enabled || settings?.premiumLocked}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
              />
              <span className="text-sm text-gray-800">
                <span className="font-medium">Understand voice notes</span>
                <span className="ml-2 text-xs font-medium text-violet-700">
                  ≈ ${settings?.estimates.voicePerMinuteUsd.toFixed(3) ?? '0.000'} per minute
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Inbound voice notes are transcribed so the AI can act on what
                  the customer said.
                </span>
              </span>
            </label>
          </div>
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
            <p className="text-xs text-gray-400 mt-1">
              Hard ceiling — AI stops for the month once reached. Blank uses the
              platform default ($20); enter 0 for unlimited.
            </p>
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
  const [syncing, setSyncing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiKnowledgeEntry | null>(null);
  const [kbStatus, setKbStatus] = useState<{
    configured: boolean;
    products: number;
    policies: number;
    total: number;
    lastSyncedAt: string | null;
  } | null>(null);

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

  const loadStatus = useCallback(async () => {
    try {
      setKbStatus(
        await apiFetch<{
          configured: boolean;
          products: number;
          policies: number;
          total: number;
          lastSyncedAt: string | null;
        }>('/shopify/knowledge-status'),
      );
    } catch {
      /* Shopify not connected / no permission — just hide the status card */
    }
  }, []);

  const syncShopify = async () => {
    setSyncing(true);
    try {
      await apiFetch<{ started: boolean }>('/shopify/sync-knowledge', {
        method: 'POST',
      });
      toast.success(
        'Shopify sync started. Your products are being indexed in the ' +
          'background — this can take a minute for a large catalogue.',
      );
      // Poll the status for ~90s so the counts update once the job finishes.
      const startTotal = kbStatus?.total ?? -1;
      let tries = 0;
      const poll = async () => {
        tries++;
        await loadStatus();
        setKbStatus((s) => {
          // stop spinning once the indexed total changed or we've waited enough
          if ((s && s.total !== startTotal) || tries >= 18) setSyncing(false);
          return s;
        });
        if (tries < 18) setTimeout(poll, 5000);
      };
      setTimeout(poll, 5000);
    } catch (e) {
      setSyncing(false);
      toast.error(
        e instanceof ApiError
          ? e.userMessage
          : 'Shopify sync failed. Make sure Shopify is connected with read_products.',
      );
    }
  };

  useEffect(() => {
    load();
    loadStatus();
  }, [load, loadStatus]);

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
        <div className="flex items-center gap-2">
          <button
            onClick={syncShopify}
            disabled={syncing}
            title="Pull your Shopify products into the knowledge base"
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={syncing ? 'animate-spin' : undefined}
            />
            {syncing ? 'Syncing…' : 'Sync from Shopify'}
          </button>
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {kbStatus && (kbStatus.total > 0 || syncing) && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          {syncing ? (
            <span className="inline-flex items-center gap-1.5">
              <RefreshCw size={12} className="animate-spin" />
              Syncing your Shopify catalogue… indexed so far:{' '}
              <strong>{kbStatus.products}</strong> products,{' '}
              <strong>{kbStatus.policies}</strong> policies.
            </span>
          ) : (
            <span>
              ✅ Shopify catalogue synced —{' '}
              <strong>{kbStatus.products}</strong> product
              {kbStatus.products === 1 ? '' : 's'} and{' '}
              <strong>{kbStatus.policies}</strong> store polic
              {kbStatus.policies === 1 ? 'y' : 'ies'} indexed for AI search
              {kbStatus.lastSyncedAt
                ? ` · last synced ${new Date(
                    kbStatus.lastSyncedAt,
                  ).toLocaleString()}`
                : ''}
              .
            </span>
          )}
        </div>
      )}

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

// ── Competition (gamification) config tab ────────────────────────────────
// Owner/admin only. Edits the point weights, speed thresholds, and badge
// thresholds that drive the Leaderboard. Feeds PATCH /gamification/settings.
function CompetitionTab() {
  const toast = useToast();
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getGameConfig()
      .then(setConfig)
      .catch((e) =>
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load'),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const setPoint = (key: keyof GameConfig['points'], value: number) =>
    setConfig((c) => (c ? { ...c, points: { ...c.points, [key]: value } } : c));
  const setSpeed = (key: keyof GameConfig['speed'], value: number) =>
    setConfig((c) => (c ? { ...c, speed: { ...c.speed, [key]: value } } : c));
  const setBadge = (idx: number, patch: Partial<GameConfig['badges'][number]>) =>
    setConfig((c) =>
      c
        ? {
            ...c,
            badges: c.badges.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
          }
        : c,
    );

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const next = await updateGameConfig(config);
      setConfig(next);
      toast.success('Competition settings saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const pointFields: Array<[keyof GameConfig['points'], string, string]> = [
    ['perOrder', 'Points per order', 'Awarded for each order an agent creates'],
    ['perRevenue1000', 'Points per 1,000 revenue', 'Scales with order value'],
    ['perChat', 'Points per chat handled', 'Rewards throughput'],
    ['perCartRecovered', 'Points per cart recovered', 'Assigned abandoned cart that converted'],
    ['conversionBonusMax', 'Max conversion bonus', '× the agent’s conversion rate'],
    ['speedBonusMax', 'Max speed bonus', 'Full when replies are fast (see below)'],
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">Point weights</h3>
        <p className="text-xs text-gray-500 mb-4">
          How the leaderboard turns activity into points. Changes apply the next
          time the board loads.
        </p>
        <div className="space-y-3">
          {pointFields.map(([key, label, hint]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-gray-800">{label}</p>
                <p className="text-xs text-gray-400">{hint}</p>
              </div>
              <input
                type="number"
                min={0}
                value={config.points[key]}
                onChange={(e) => setPoint(key, Number(e.target.value))}
                className="w-24 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-right"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">
          Response-speed bonus
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          Full speed bonus at or under the fast threshold, tapering to zero at the
          slow threshold (seconds).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-gray-600 mb-1 block">
              Fast threshold (s)
            </span>
            <input
              type="number"
              min={0}
              value={config.speed.fastSec}
              onChange={(e) => setSpeed('fastSec', Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 mb-1 block">
              Slow threshold (s)
            </span>
            <input
              type="number"
              min={0}
              value={config.speed.slowSec}
              onChange={(e) => setSpeed('slowSec', Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">Badges</h3>
        <p className="text-xs text-gray-500 mb-4">
          Edit each badge’s name and the threshold agents must hit to earn it.
        </p>
        <div className="space-y-3">
          {config.badges.map((b, i) => (
            <div key={b.id} className="flex items-center gap-2">
              <input
                value={b.label}
                onChange={(e) => setBadge(i, { label: e.target.value })}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              />
              <span className="text-xs text-gray-400 whitespace-nowrap">
                {b.type === 'rank' ? 'rank in' : ''} {b.metric} {b.op}
              </span>
              <input
                type="number"
                value={b.threshold}
                onChange={(e) => setBadge(i, { threshold: Number(e.target.value) })}
                className="w-20 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-right"
              />
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="px-5 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );
}
