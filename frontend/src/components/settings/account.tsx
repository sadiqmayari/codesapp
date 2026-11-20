'use client';

import { useEffect, useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError, setAccessToken } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/crm-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SaveBar } from '@/components/ui/save-bar';
import {
  NOTIFICATION_TONES,
  getSelectedTone,
  setSelectedTone,
  playTone,
} from '@/lib/notification-sound';
import {
  notificationPermission,
  requestNotificationPermission,
} from '@/lib/notify';
import {
  CopyField,
  FormField,
  Rows,
  SettingRow,
  SettingsCard,
  SettingsPage,
  inputCls,
} from './shared';

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

/* ───────────────────────── Profile ───────────────────────── */

export function ProfileSection() {
  const { user } = useAuth();
  const toast = useToast();
  const [saved, setSaved] = useState(user?.name ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== saved.trim();

  const save = async () => {
    if (name.trim().length < 2) {
      toast.error('Name must be at least 2 characters');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/auth/profile', { method: 'PATCH', body: { name: name.trim() } });
      setSaved(name.trim());
      toast.success('Profile updated — refresh to see it everywhere');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const role = user?.role ?? '';
  return (
    <SettingsPage title="Profile" description="Your own account. Workspace details live under General.">
      <SettingsCard>
        <div className="flex items-center gap-3.5">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-600 text-lg font-extrabold text-white">
            {initials(saved || user?.email || '')}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-ink">{saved || '—'}</p>
            <p className="text-[13px] text-muted">
              {ROLE_LABELS[role] ?? role}
              {user?.company?.name ? ` · ${user.company.name}` : ''}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" htmlFor="pf-name">
            <input
              id="pf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
              autoComplete="name"
            />
          </FormField>
          <FormField label="Email" htmlFor="pf-email" hint="Ask an owner to change your sign-in email.">
            <input id="pf-email" value={user?.email ?? ''} disabled className={inputCls} />
          </FormField>
        </div>
      </SettingsCard>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setName(saved)} />
    </SettingsPage>
  );
}

/* ───────────────────────── Security ───────────────────────── */

export function SecuritySection() {
  return (
    <SettingsPage title="Security" description="Your password and sign-in protection.">
      <PasswordCard />
      <TwoFactorCard />
    </SettingsPage>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [nw2, setNw2] = useState('');
  const [saving, setSaving] = useState(false);
  const mismatch = nw2.length > 0 && nw !== nw2;

  const change = async () => {
    if (nw.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    if (nw !== nw2) {
      toast.error('New passwords do not match');
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch<{ accessToken?: string }>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: cur, newPassword: nw },
      });
      // Other devices are signed out; this session continues on the new token.
      if (r?.accessToken) setAccessToken(r.accessToken);
      toast.success('Password changed. Other devices were signed out.');
      setCur('');
      setNw('');
      setNw2('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Password change failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard title="Password">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          change();
        }}
      >
        <FormField label="Current password" htmlFor="pw-cur">
          <input id="pw-cur" type="password" value={cur} onChange={(e) => setCur(e.target.value)} className={inputCls} autoComplete="current-password" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="New password" htmlFor="pw-new" hint="At least 8 characters.">
            <input id="pw-new" type="password" value={nw} onChange={(e) => setNw(e.target.value)} className={inputCls} autoComplete="new-password" />
          </FormField>
          <FormField
            label="Confirm new password"
            htmlFor="pw-new2"
            hint={mismatch ? <span className="text-red-600">Passwords don’t match.</span> : undefined}
          >
            <input id="pw-new2" type="password" value={nw2} onChange={(e) => setNw2(e.target.value)} className={inputCls} autoComplete="new-password" />
          </FormField>
        </div>
        <div>
          <Button type="submit" loading={saving} disabled={!cur || !nw || !nw2}>
            Change password
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

function TwoFactorCard() {
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; qrCode: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<string[] | null>(null);

  const begin = async () => {
    setBusy(true);
    try {
      setSetup(await apiFetch<{ secret: string; qrCode: string }>('/auth/2fa/setup', { method: 'POST' }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : '2FA setup failed');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ verified: boolean; backupCodes?: string[] }>('/auth/2fa/verify', {
        method: 'POST',
        body: { code: code.trim() },
      });
      if (res.verified) {
        toast.success('Two-factor authentication enabled');
        setBackup(res.backupCodes ?? null);
        setSetup(null);
        setCode('');
      } else {
        toast.error('That code is not valid — try the latest one from your app');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Verify failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title="Two-factor authentication"
      description="Ask for a 6-digit code from Google Authenticator or Authy at sign-in."
      action={backup ? <Badge tone="success">On</Badge> : undefined}
    >
      {backup && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 p-3.5 dark:border-brand-800 dark:bg-brand-900/30">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300">
            <ShieldCheck size={15} /> Backup codes — store these somewhere safe
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs text-ink sm:grid-cols-4">
            {backup.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </div>
        </div>
      )}
      {!setup ? (
        <SettingRow
          title="Set up an authenticator app"
          description="Scan a QR code (or type the key), then confirm with a code."
        >
          <Button variant="secondary" loading={busy} onClick={begin}>
            Set up 2FA
          </Button>
        </SettingRow>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {setup.qrCode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={setup.qrCode} alt="2FA QR code" className="h-44 w-44 shrink-0 rounded-lg border border-line bg-white p-1" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <CopyField label="Manual key" value={setup.secret} />
            <FormField label="6-digit code" htmlFor="tfa-code">
              <input
                id="tfa-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                className={cn(inputCls, 'max-w-[180px] font-mono tracking-widest')}
              />
            </FormField>
            <div className="flex gap-2">
              <Button loading={busy} onClick={verify} disabled={!code.trim()}>
                Verify & turn on
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

/* ───────────────────────── Notifications ───────────────────────── */

export function NotificationsSection() {
  const [selected, setSelected] = useState('chime');
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');

  useEffect(() => {
    setSelected(getSelectedTone().id);
    setPerm(notificationPermission());
  }, []);

  const choose = (id: string) => {
    setSelected(id);
    setSelectedTone(id);
  };

  return (
    <SettingsPage title="Notifications" description="Saved on this device and browser only.">
      <SettingsCard>
        <Rows>
          <SettingRow
            title="Desktop notifications"
            description={
              perm === 'granted'
                ? 'On — new chats pop up while CodesApp is in the background, with Reply and Open buttons.'
                : perm === 'denied'
                  ? 'Blocked by your browser. Allow notifications for this site in the browser’s site settings.'
                  : perm === 'unsupported'
                    ? 'This browser doesn’t support notifications.'
                    : 'Get a pop-up for new chats while CodesApp is in the background.'
            }
          >
            {perm === 'granted' ? (
              <Badge tone="success">Allowed</Badge>
            ) : perm === 'default' ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => setPerm(await requestNotificationPermission())}
              >
                Allow notifications
              </Button>
            ) : (
              <Badge tone={perm === 'denied' ? 'danger' : 'neutral'}>
                {perm === 'denied' ? 'Blocked' : 'Unavailable'}
              </Badge>
            )}
          </SettingRow>
        </Rows>
      </SettingsCard>

      <SettingsCard title="Message sound" description="Played when a new WhatsApp message arrives.">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Message sound">
          {NOTIFICATION_TONES.map((t) => (
            <label
              key={t.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5',
                selected === t.id
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30'
                  : 'border-line hover:bg-sunken',
              )}
            >
              <input
                type="radio"
                name="tone"
                checked={selected === t.id}
                onChange={() => choose(t.id)}
                className="accent-brand-600"
              />
              <span className="flex-1 text-sm font-medium text-ink">{t.label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  playTone(t.src);
                }}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:text-brand-300 dark:hover:bg-brand-900/40"
                aria-label={`Play ${t.label}`}
              >
                <Play size={13} /> Play
              </button>
            </label>
          ))}
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
