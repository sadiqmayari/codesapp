'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { SaveBar } from '@/components/ui/save-bar';
import { CopyField, FormField, SettingsCard, SettingsPage, SettingsSkeleton, inputCls } from './shared';

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

  if (loading) return <SettingsSkeleton cards={1} />;

  return (
    <SettingsCard
      title="Your tracking handle"
      description={
        <>
          Map a template variable to <span className="font-semibold text-ink">Tracking page URL</span> (Order
          confirmation or Delivery updates) to send each customer their link.
        </>
      }
      action={current ? <Badge tone="success">Live</Badge> : <Badge>Not set</Badge>}
    >
      <FormField
        label="Handle"
        htmlFor="trk-handle"
        hint={
          valid ? (
            '2–80 lowercase letters, numbers or hyphens.'
          ) : (
            <span className="text-red-600">Use 2–80 lowercase letters, numbers or hyphens.</span>
          )
        }
      >
        <div className="flex items-center gap-2">
          <span className="hidden shrink-0 text-sm text-muted sm:inline">{previewBase}/</span>
          <input
            id="trk-handle"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="your-store"
            disabled={busy}
            className={cn(inputCls, !valid && 'border-red-400')}
          />
        </div>
      </FormField>
      {clean && valid && (
        <CopyField label="Links look like" value={`${previewBase}/${clean}/<order-id>`} />
      )}
      <SaveBar
        dirty={clean !== (current ?? '')}
        saving={busy}
        onSave={save}
        onDiscard={() => setValue(current ?? '')}
      />
    </SettingsCard>
  );
}

export function TrackingSection() {
  return (
    <SettingsPage
      title="Tracking page"
      description="A branded, public page where customers follow their own order — no login needed."
    >
      <PublicTrackingCard />
    </SettingsPage>
  );
}
