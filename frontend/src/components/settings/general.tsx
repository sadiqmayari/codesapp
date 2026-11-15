'use client';

import { useMemo, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { apiFetch, ApiError, postMultipart } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { mediaUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SaveBar } from '@/components/ui/save-bar';
import { FormField, SettingsCard, SettingsPage, inputCls } from './shared';

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
    <SettingsCard
      title="Branding"
      description="Your logo appears in the top bar, on invoices and on the public tracking page."
    >
      <div className="flex flex-wrap items-center gap-4">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl(logo) ?? ''}
            alt={company?.name ?? 'Logo'}
            className="h-16 w-16 rounded-xl border border-line bg-white object-contain p-1"
          />
        ) : (
          <span className="grid h-16 w-16 place-items-center rounded-xl bg-sunken text-xl font-extrabold text-muted">
            {company?.name?.[0]?.toUpperCase() ?? '?'}
          </span>
        )}
        <div className="min-w-[180px] flex-1">
          <p className="text-sm font-semibold text-ink">{company?.name ?? 'Company logo'}</p>
          <p className="text-[13px] text-muted">
            JPEG, PNG, WebP or SVG · up to 2 MB. Without a logo your initials are shown.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" loading={busy} onClick={pick}>
            <Upload size={14} />
            {logo ? 'Replace' : 'Upload logo'}
          </Button>
          {logo && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 size={14} />
              Remove
            </Button>
          )}
        </div>
      </div>
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
    </SettingsCard>
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
    <SettingsCard
      title="Timezone"
      description="Every date, time and date-range report — dashboard, analytics, orders, attendance — uses this clock for the whole team."
    >
      <FormField
        label="Company timezone"
        htmlFor="co-tz"
        hint={nowInZone ? <>It’s <span className="font-semibold text-ink">{nowInZone}</span> in this timezone.</> : undefined}
      >
        <select id="co-tz" value={value} onChange={(e) => setValue(e.target.value)} className={inputCls}>
          <option value="">Each viewer’s device clock ({browserTz})</option>
          {zones.map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </FormField>
      <SaveBar dirty={value !== current} saving={busy} onSave={save} onDiscard={() => setValue(current)} />
    </SettingsCard>
  );
}

export function GeneralSection() {
  return (
    <SettingsPage title="General" description="Workspace details everyone on your team sees.">
      <CompanyBrandingCard />
      <CompanyTimezoneCard />
    </SettingsPage>
  );
}
