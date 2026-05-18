'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy, Check } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import type { OnboardingStatusView } from '@/lib/crm-types';

type Tab = 'whatsapp' | 'security' | 'profile';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('whatsapp');
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Settings</h1>
      <div className="flex gap-2 mb-5 border-b border-gray-200">
        {(
          [
            ['whatsapp', 'WhatsApp'],
            ['security', 'Security'],
            ['profile', 'Profile'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
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
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4 max-w-md">
      <Field label="Name" value={user?.name || '—'} />
      <Field label="Email" value={user?.email || '—'} />
      <Field label="Role" value={user?.role || '—'} />
      <p className="text-xs text-gray-400">
        Profile editing and team management are managed by your account
        administrator. To change your password, use “Forgot password” on the
        login screen.
      </p>
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
