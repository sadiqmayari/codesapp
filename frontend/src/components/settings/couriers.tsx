'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  COURIER_TYPES,
  COURIER_LABELS,
  COURIER_CREDENTIAL_FIELDS,
  getCourierSettings,
  getCourierSyncSchedule,
  setCourierSyncSchedule,
  setCourierCredentials,
  setCourierBookingEnabled,
  deleteCourierCredentials,
  getTraxPickupAddresses,
  getMnpLocations,
  seedMnpCities,
  getTcsCostCenters,
  seedTcsCities,
  getTcsStatusCodes,
  type TcsStatusCode,
  getRapidxpkWebhook,
  registerRapidxpkWebhook,
  type RapidxpkWebhookStatus,
  type CourierType,
  type CourierStatusRow,
  type CourierField,
  type CourierSyncSchedule,
} from '@/lib/couriers';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/modal';
import { SideSheet } from '@/components/ui/side-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { CourierLogo, isCourierBrand } from '@/components/icons/brand-logo';
import {
  Callout,
  CopyField,
  FormField,
  SettingRow,
  SettingsCard,
  SettingsPage,
  inputCls,
} from './shared';
import { CityCourierGrid } from './city-courier-grid';

function Logo({ courier, size = 'sm' }: { courier: CourierType; size?: 'xs' | 'sm' | 'lg' }) {
  return isCourierBrand(courier) ? (
    <CourierLogo courier={courier} size={size} />
  ) : (
    <span className="grid h-11 w-28 place-items-center rounded-lg bg-sunken text-sm font-bold text-ink">
      {COURIER_LABELS[courier]}
    </span>
  );
}

function statusBadge(row?: CourierStatusRow) {
  if (!row?.configured) return <Badge>Not connected</Badge>;
  if (row.needsReconnect) return <Badge tone="warn">Reconnect required</Badge>;
  return row.bookingEnabled ? (
    <Badge tone="success">Connected · Booking on</Badge>
  ) : (
    <Badge tone="warn">Connected · Booking off</Badge>
  );
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Settings → Couriers (owner/admin). Logo tiles with connection + booking
 * state, a side sheet per courier (credentials, webhook, courier extras),
 * the status-check cadence and the city × courier performance grid.
 */
export function CouriersSection() {
  const toast = useToast();
  const [rows, setRows] = useState<CourierStatusRow[] | null>(null);
  const [sched, setSched] = useState<CourierSyncSchedule | null>(null);
  const [open, setOpen] = useState<CourierType | null>(null);
  const [toggling, setToggling] = useState<CourierType | null>(null);
  const [gridKey, setGridKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setRows(await getCourierSettings());
    } catch {
      setRows([]);
    }
  }, []);
  const loadSched = useCallback(async () => {
    try {
      setSched(await getCourierSyncSchedule());
    } catch {
      setSched(null);
    }
  }, []);

  useEffect(() => {
    load();
    loadSched();
  }, [load, loadSched]);

  const rowOf = (c: CourierType) => rows?.find((r) => r.courierType === c);

  const toggleBooking = async (c: CourierType, next: boolean) => {
    setToggling(c);
    setRows((rs) => rs?.map((r) => (r.courierType === c ? { ...r, bookingEnabled: next } : r)) ?? rs);
    try {
      await setCourierBookingEnabled(c, next);
      toast.success(
        next
          ? `${COURIER_LABELS[c]} is offered for new orders`
          : `${COURIER_LABELS[c]} is off for new orders — existing parcels keep syncing`,
      );
      await load();
      setGridKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update');
      await load();
    } finally {
      setToggling(null);
    }
  };

  const connected = rows?.filter((r) => r.configured).length ?? 0;
  const bookable = rows?.filter((r) => r.configured && r.bookingEnabled).length ?? 0;

  return (
    <SettingsPage
      title="Couriers"
      description="Connect courier accounts to book parcels, print labels and loadsheets, and get delivery updates. Credentials are encrypted and never shown again."
    >
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Connected', rows ? `${connected} of ${COURIER_TYPES.length}` : '—'],
          ['Offered for booking', rows ? String(bookable) : '—'],
          ['Last status check', sched ? ago(sched.lastRunAt) : '—'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
            <p className="text-xs font-semibold text-muted">{k}</p>
            <p className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">{v}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {rows === null
          ? COURIER_TYPES.map((c) => <Skeleton key={c} className="h-[150px] rounded-2xl" />)
          : COURIER_TYPES.map((c) => {
              const row = rowOf(c);
              return (
                <div
                  key={c}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen(c)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpen(c);
                    }
                  }}
                  className="flex cursor-pointer flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm outline-none transition hover:-translate-y-px hover:border-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label={`${COURIER_LABELS[c]} settings`}
                >
                  <div className="flex items-center gap-3">
                    <Logo courier={c} />
                    <span className="min-w-0 truncate text-[15px] font-bold text-ink">{COURIER_LABELS[c]}</span>
                  </div>
                  <div>{statusBadge(row)}</div>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-[13px] text-muted">
                    {row?.configured ? (
                      <>
                        <span>Booking</span>
                        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <Switch
                            size="sm"
                            checked={!!row.bookingEnabled}
                            disabled={toggling === c}
                            onChange={(v) => toggleBooking(c, v)}
                            label={`Offer ${COURIER_LABELS[c]} for new bookings`}
                          />
                        </span>
                      </>
                    ) : (
                      <>
                        <span>Takes about 2 minutes</span>
                        <span className="font-semibold text-brand-700 dark:text-brand-300">Connect →</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
      </div>

      <SyncScheduleCard sched={sched} onSaved={loadSched} />

      <CityCourierGrid key={gridKey} />

      {open && (
        <CourierSheet
          courierType={open}
          row={rowOf(open)}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            await load();
            setGridKey((k) => k + 1);
          }}
          onToggleBooking={(v) => toggleBooking(open, v)}
          toggling={toggling === open}
        />
      )}
    </SettingsPage>
  );
}

/* ───────────── status & shipper-advice check cadence ───────────── */

const SYNC_INTERVAL_OPTIONS: Array<[number | null, string]> = [
  [null, 'Platform default (every 4 hours)'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [120, 'Every 2 hours'],
  [240, 'Every 4 hours'],
  [360, 'Every 6 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Once a day'],
];

function SyncScheduleCard({ sched, onSaved }: { sched: CourierSyncSchedule | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const current = sched?.intervalMinutes ?? null;

  const onChange = async (raw: string) => {
    setSaving(true);
    try {
      await setCourierSyncSchedule(raw === '' ? null : Number(raw));
      toast.success('Check schedule updated');
      await onSaved();
    } catch {
      toast.error('Could not update the schedule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Status & shipper-advice check"
      description="How often CodesApp re-checks every open parcel with the courier and flags the ones awaiting shipper advice. Courier webhooks still update parcels in real time — this is the safety net."
    >
      <SettingRow
        title="Check every"
        description={
          sched
            ? `${sched.lastRunAt ? `Last checked ${fmtDateTime(sched.lastRunAt)}` : 'Not checked yet'}${sched.nextDueAt ? ` · next ${fmtDateTime(sched.nextDueAt)}` : ''}`
            : 'Faster surfaces shipper advice sooner but uses more courier API calls.'
        }
      >
        <select
          aria-label="Check interval"
          value={current === null ? '' : String(current)}
          disabled={!sched || saving}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputCls, 'w-auto min-w-[230px]')}
        >
          {SYNC_INTERVAL_OPTIONS.map(([v, label]) => (
            <option key={label} value={v === null ? '' : String(v)}>
              {label}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsCard>
  );
}

/* ───────────── courier side sheet (credentials + extras) ───────────── */

function CourierSheet({
  courierType,
  row,
  onClose,
  onSaved,
  onToggleBooking,
  toggling,
}: {
  courierType: CourierType;
  row?: CourierStatusRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToggleBooking: (next: boolean) => void;
  toggling: boolean;
}) {
  const toast = useToast();
  const fields = COURIER_CREDENTIAL_FIELDS[courierType];
  const configured = !!row?.configured;
  const label = COURIER_LABELS[courierType];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const f of fields) if (f.default !== undefined) defaults[f.key] = f.default;
    return { ...defaults, ...(row?.savedValues ?? {}) };
  });
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // Runtime-loaded <select> options per field key (Trax pickup addresses,
  // M&P locations). null = loading; an entry in dynErr = failed.
  const [dynOpts, setDynOpts] = useState<Record<string, Array<{ id: string; label: string }> | null>>({});
  const [dynErr, setDynErr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!configured) return;
    for (const f of fields) {
      if (!f.dynamic) continue;
      const loader =
        f.dynamic === 'traxPickupAddresses'
          ? getTraxPickupAddresses
          : f.dynamic === 'mnpLocations'
            ? getMnpLocations
            : f.dynamic === 'tcsCostCenters'
              ? getTcsCostCenters
              : null;
      if (!loader) continue;
      const key = f.key;
      setDynOpts((m) => ({ ...m, [key]: null }));
      loader()
        .then((list) => setDynOpts((m) => ({ ...m, [key]: list })))
        .catch(() => setDynErr((m) => ({ ...m, [key]: 'Couldn’t load options from the courier.' })));
    }
  }, [configured, fields]);

  const secretPlaceholder = (f: CourierField) => (row?.secretSet?.[f.key] ? '•••••••• saved — leave blank to keep' : '');

  const save = async () => {
    // Non-secret fields always go up (pre-filled, editable in place); secrets
    // only when typed. The backend merges.
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key] ?? '';
      if (f.type === 'secret' || f.type === 'textarea') {
        if (v.trim()) payload[f.key] = v.trim();
      } else {
        payload[f.key] = v;
      }
    }
    const legacyPair = !!(values.clientId?.trim() && (values.clientSecret?.trim() || row?.secretSet?.clientSecret));
    const missing = fields.filter((f) => {
      if (f.optional || f.type === 'toggle' || f.group === 'legacy') return false;
      if (f.key === 'bearerToken' && legacyPair) return false;
      if (f.type === 'secret' || f.type === 'textarea') {
        return !row?.secretSet?.[f.key] && !payload[f.key]?.trim();
      }
      // API-loaded dropdowns can't populate until the credentials are saved,
      // so they're not required on the FIRST save.
      if (f.dynamic) return configured && !payload[f.key]?.trim();
      return !payload[f.key]?.trim();
    });
    if (missing.length) {
      toast.error(`Fill in: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }
    setBusy(true);
    try {
      const res = await setCourierCredentials(courierType, payload);
      toast.success(configured ? `${label} credentials saved` : `${label} connected`);
      if (res?.webhookError) toast.error(res.webhookError);
      await onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save credentials');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteCourierCredentials(courierType);
      toast.success(`${label} disconnected`);
      setConfirmDisconnect(false);
      await onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  };

  const seedCities = async () => {
    setSeeding(true);
    try {
      const { seeded } = courierType === 'tcs' ? await seedTcsCities() : await seedMnpCities();
      toast.success(`Fetched ${seeded.toLocaleString()} ${label} cities`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : `Failed to fetch ${label} cities`);
    } finally {
      setSeeding(false);
    }
  };

  // TCS has no push webhooks (statuses are pulled on the sync schedule).
  const webhookUrl =
    courierType !== 'tcs' && row?.webhookUrl && typeof window !== 'undefined'
      ? `${window.location.origin}${row.webhookUrl}`
      : null;

  const renderField = (f: CourierField) => {
      const val = values[f.key] ?? '';
      const set = (v: string) => setValues((m) => ({ ...m, [f.key]: v }));
      const id = `cr-${courierType}-${f.key}`;
      if (f.type === 'toggle') {
        return (
          <SettingRow key={f.key} title={f.label} description={f.hint}>
            <Switch checked={val === '1'} onChange={(v) => set(v ? '1' : '0')} label={f.label} />
          </SettingRow>
        );
      }
      let control: React.ReactNode;
      if (f.type === 'select' && f.dynamic) {
        const opts = dynOpts[f.key];
        const err = dynErr[f.key];
        control = (
          <select id={id} value={val} disabled={!opts} onChange={(e) => set(e.target.value)} className={inputCls}>
            <option value="">
              {opts ? 'Choose…' : err ? 'Unavailable' : configured ? 'Loading…' : 'Save the credentials first, then reopen'}
            </option>
            {!opts && val && <option value={val}>{`Saved (id ${val})`}</option>}
            {opts?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        );
      } else if (f.type === 'select') {
        control = (
          <select id={id} value={val} onChange={(e) => set(e.target.value)} className={inputCls}>
            <option value="">Choose…</option>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      } else if (f.type === 'textarea') {
        control = (
          <textarea
            id={id}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder={secretPlaceholder(f)}
            value={val}
            onChange={(e) => set(e.target.value)}
            className={`${inputCls} font-mono text-xs break-all`}
          />
        );
      } else {
        control = (
          <input
            id={id}
            type={f.type === 'secret' ? 'password' : 'text'}
            autoComplete="new-password"
            placeholder={f.type === 'secret' ? secretPlaceholder(f) : undefined}
            value={val}
            onChange={(e) => set(e.target.value)}
            className={inputCls}
          />
        );
      }
      const err = dynErr[f.key];
      return (
        <FormField
          key={f.key}
          label={
            <>
              {f.label}
              {f.optional && <span className="font-normal text-muted"> (optional)</span>}
            </>
          }
          htmlFor={id}
          hint={err ? <span className="text-red-600">{err}</span> : f.hint}
        >
          {control}
        </FormField>
      );
  };

  return (
    <SideSheet
      open
      onClose={onClose}
      icon={<Logo courier={courierType} size="lg" />}
      title={label}
      subtitle={statusBadge(row)}
      footer={
        <>
          {configured && (
            <Button
              variant="ghost"
              className="mr-auto text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              onClick={() => setConfirmDisconnect(true)}
              title="Removes the saved credentials. To pause for new orders, turn booking off instead."
            >
              Disconnect
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            {configured ? 'Save' : `Connect ${label}`}
          </Button>
        </>
      }
    >
      <Callout tone="brand" icon={<ShieldCheck size={15} className="text-brand-600" />}>
        Credentials are encrypted. Saved secrets are never shown — leave a field blank to keep it.
      </Callout>

      {fields.filter((f) => f.group !== 'legacy').map(renderField)}
      {fields.some((f) => f.group === 'legacy') && (
        <details className="rounded-lg border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Legacy: generate bearer token from Client ID/Secret</summary>
          <div className="mt-3 space-y-4">{fields.filter((f) => f.group === 'legacy').map(renderField)}</div>
        </details>
      )}

      {(courierType === 'mnp' || courierType === 'tcs') && configured && (
        <SettingRow title="City list" description={`Fetch ${label}’s cities from their API (re-run to refresh).`}>
          <Button variant="secondary" size="sm" loading={seeding} onClick={seedCities}>
            Fetch cities
          </Button>
        </SettingRow>
      )}

      {webhookUrl && (
        <CopyField
          label="Tracking webhook URL"
          value={webhookUrl}
          hint={
            courierType === 'rapidxpk'
              ? 'Registered with RapidXpk automatically when you save the API key. You can also set it in the RapidXpk portal and paste its signing secret above.'
              : `Give this URL to ${label} so delivery updates arrive on their own.`
          }
        />
      )}

      {courierType === 'rapidxpk' && configured && <RapidxpkWebhookPanel />}
      {courierType === 'tcs' && configured && <TcsStatusCodesPanel />}

      {configured && (
        <SettingRow
          className="border-t border-line pt-4"
          title="Offer for new bookings"
          description={
            row?.bookingEnabled
              ? 'New orders can be routed here. Existing parcels keep syncing either way.'
              : 'Not offered for new orders. Credentials are kept and existing parcels still update.'
          }
        >
          <Switch checked={!!row?.bookingEnabled} disabled={toggling} onChange={onToggleBooking} label={`Offer ${label} for new bookings`} />
        </SettingRow>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title={`Disconnect ${label}?`}
        message={`This permanently removes the saved API credentials and webhook key. Existing ${label} parcels stop receiving webhooks and status updates. To simply stop using it for new orders, turn booking off instead.`}
        confirmLabel="Disconnect"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </SideSheet>
  );
}

// RapidXpk: CodesApp registers its webhook with RapidXpk itself (on save), so
// instead of a "give this URL to the courier" field we show TEST/LIVE mode, the
// registration state, RapidXpk's own last-success/last-error, and a Re-register.
/** TCS's own status vocabulary + what each code becomes in CodesApp. TCS has
 *  no webhooks — statuses are pulled on the courier sync schedule. */
function TcsStatusCodesPanel() {
  const [rows, setRows] = useState<TcsStatusCode[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || rows) return;
    getTcsStatusCodes()
      .then(setRows)
      .catch((e) => setErr(e instanceof ApiError ? e.userMessage : 'Couldn’t load TCS status codes.'));
  }, [open, rows]);
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <p className="text-muted">
        TCS sends no tracking pushes — CodesApp pulls each parcel’s status on your courier sync schedule.
      </p>
      <button type="button" className="mt-2 text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} TCS status codes
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-auto">
          {err && <p className="text-xs text-red-600">{err}</p>}
          {!rows && !err && <Skeleton className="h-16 w-full" />}
          {rows && (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code} className="border-t border-line">
                    <td className="py-1 pr-2 font-mono">{r.code}</td>
                    <td className="py-1 pr-2">{r.description}</td>
                    <td className={cn('py-1', r.mapsTo === 'unmapped' ? 'text-amber-700' : 'text-muted')}>{r.mapsTo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function RapidxpkWebhookPanel() {
  const toast = useToast();
  const [st, setSt] = useState<RapidxpkWebhookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    getRapidxpkWebhook()
      .then(setSt)
      .catch(() => setSt(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // RapidXpk GET /v1/webhooks answers { webhook: { url, failed, pending,
  // last_ok_at, last_error, created_at } } — read the nested object.
  const rawRemote = (st?.remote ?? null) as Record<string, unknown> | null;
  const remote = ((rawRemote?.webhook as Record<string, unknown> | undefined) ?? rawRemote) as Record<string, unknown> | null;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = remote?.[k];
      if (v != null && v !== '') return String(v);
    }
    return null;
  };
  const lastOk = pick('last_ok_at', 'last_success_at', 'last_delivery_at');
  const lastErr = pick('last_error', 'last_failure_reason');
  const failed = Number(remote?.failed ?? 0);
  const remoteUrl = pick('url');
  const urlMismatch = !!remoteUrl && !!st?.url && remoteUrl !== st.url;

  const reRegister = async () => {
    setBusy(true);
    try {
      await registerRapidxpkWebhook();
      toast.success('RapidXpk webhook registered — new signing secret saved');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Webhook registration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-sunken/60 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {st?.mode === 'test' && <Badge tone="warn">Test key · orders never dispatch</Badge>}
        {st?.mode === 'live' && <Badge className="bg-gray-900 text-lime-300">Live key</Badge>}
        <Badge tone={st?.registered ? 'success' : 'danger'}>
          {st?.registered ? 'Status webhook registered' : 'Status webhook not registered'}
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Last delivery</dt>
        <dd className="text-ink">{lastOk ? fmtDateTime(lastOk) : '—'}</dd>
        <dt className="text-muted">Last error</dt>
        <dd className="text-ink">
          {st?.remoteError || lastErr || 'None'}
          {failed > 0 ? ` · ${failed} failed deliveries` : ''}
        </dd>
        <dt className="text-muted">Catch-up sync</dt>
        <dd className="text-ink">{st?.syncCursor?.since ? `up to ${fmtDateTime(st.syncCursor.since)}` : 'not run yet'}</dd>
      </dl>
      {urlMismatch && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          RapidXpk is posting to a different URL ({remoteUrl}). Re-register to point it at this account.
        </p>
      )}
      <Button variant="secondary" size="sm" loading={busy} onClick={reRegister} className="mt-3">
        {!busy && <RefreshCw size={13} />} Re-register webhook
      </Button>
    </div>
  );
}
