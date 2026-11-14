'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Database, Loader2, Plug, RefreshCw, Send, Trash2 } from 'lucide-react';
import { cn, fmtDateTime } from '@/lib/utils';
import { ApiError, apiFetch } from '@/lib/api';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { growthApi, SYNC_INTERVALS, type Accounts, type AdAccount, type GrowthStatus } from '@/lib/growth';
import { Panel } from '@/components/growth/ui';
import { WriteAccessPanel } from '@/components/growth/manage/write-access';

const LOGO: Record<string, [string, string]> = { meta: ['M', '#1877f2'], google: ['G', '#ea4335'], tiktok: ['T', '#111827'], snap: ['S', '#eab308'] };
const ID_HELP: Record<string, string> = {
  meta: 'Ads Manager → Account overview → the numeric ad account id (with or without act_).',
  google: 'The 10-digit customer id (xxx-xxx-xxxx).',
  tiktok: 'TikTok Ads Manager → advertiser id.',
  snap: 'Snapchat Ads Manager → ad account id (UUID).',
};
const TOKEN_HELP: Record<string, string> = {
  meta: 'Optional. Leave blank to reuse your WhatsApp System User token — it needs the ads_read permission and access to this ad account.',
  google: 'OAuth refresh token for a Google user with access to this account.',
  tiktok: 'Long-lived advertiser access token from your TikTok for Business app.',
  snap: 'OAuth refresh token for a Snapchat user with access to this ad account.',
};

const err = (e: unknown, fb: string) => (e instanceof ApiError ? e.userMessage : fb);

function Health({ a }: { a: AdAccount }) {
  if (a.health === 'paused') return <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300" title="Meta limits how many API calls an ad account can make per hour. Already-pulled data stays; the sync continues on its own."><Clock size={13} /> Paused by Meta&apos;s API limit — resumes automatically{a.lastSuccessAt ? ` · last data ${fmtDateTime(a.lastSuccessAt)}` : ''}</span>;
  if (a.health === 'error') return <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600"><AlertTriangle size={13} /> Sync failing</span>;
  if (a.health === 'ok') return <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 size={13} /> Synced {a.lastSuccessAt ? fmtDateTime(a.lastSuccessAt) : ''}</span>;
  return <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted"><Clock size={13} /> First sync running</span>;
}

export default function GrowthConnectionsPage() {
  const toast = useToast();
  const [acc, setAcc] = useState<Accounts | null>(null);
  const [status, setStatus] = useState<GrowthStatus | null>(null);
  const [stores, setStores] = useState<Array<{ id: number; label: string }>>([]);
  const [form, setForm] = useState({ platform: 'meta', externalId: '', token: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AdAccount | null>(null);
  const [datasets, setDatasets] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([growthApi.accounts(), growthApi.status()]);
      setAcc(a);
      setStatus(s);
      setDatasets(Object.fromEntries(a.accounts.map((x) => [x.id, x.capiDatasetId ?? ''])));
    } catch (e) {
      toast.error(err(e, 'Could not load connections'));
    }
  }, [toast]);

  useEffect(() => {
    void load();
    apiFetch<Array<{ id: number; label: string }>>('/shopify/stores').then((r) => setStores(Array.isArray(r) ? r : [])).catch(() => setStores([]));
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error(err(e, 'That did not work'));
    } finally {
      setBusy(null);
    }
  };

  const available = acc?.platforms.filter((p) => p.available) ?? [];

  return (
    <div className="space-y-4">
      <Panel title="Ad accounts" hint={acc?.baseCurrency ? `Spend is converted to ${acc.baseCurrency} (your store currency) at the daily exchange rate.` : undefined}>
        {!acc ? <Skeleton className="h-24 w-full" /> : acc.accounts.length === 0 ? (
          <p className="py-3 text-sm text-muted">No ad account connected yet. Connect one below to bring spend in next to your orders.</p>
        ) : (
          <ul className="divide-y divide-line">
            {acc.accounts.map((a) => {
              const [l, c] = LOGO[a.platform] ?? ['?', '#64748b'];
              return (
                <li key={a.id} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-extrabold text-white" style={{ background: c }}>{l}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-ink">{a.name ?? a.externalId}</div>
                      <div className="text-xs text-muted">
                        {a.platform} · {a.externalId} · {a.currency ?? '—'} · {a.timezone ?? 'timezone unknown'}
                        {a.usingOverrideToken ? ' · own token' : a.platform === 'meta' ? ' · WhatsApp token' : ''}
                      </div>
                      <div className="mt-1"><Health a={a} /></div>
                      {a.lastError && a.health === 'error' && <p className="mt-1 text-xs text-red-600">{a.lastError}</p>}
                      {a.currencyMismatch && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Spend is in {a.currency}; it is converted to {acc.baseCurrency} automatically.</p>}
                      {a.timezoneMismatch && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">This account reports days in {a.timezone}, which differs from your workspace timezone, so daily spend is offset by a few hours.</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={busy === `sync${a.id}`} onClick={() => run(`sync${a.id}`, () => growthApi.syncAccount(a.id), 'Sync started')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
                        <RefreshCw size={13} className={busy === `sync${a.id}` ? 'animate-spin' : ''} /> Sync now
                      </button>
                      <button type="button" onClick={() => setConfirm(a)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-red-600"><Trash2 size={13} /> Disconnect</button>
                    </div>
                  </div>
                  <div className="grid gap-3 rounded-lg bg-sunken p-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="text-xs text-muted" htmlFor={`int-${a.id}`}>
                      Auto-sync
                      <select id={`int-${a.id}`} value={a.syncIntervalMin ?? ''} onChange={(e) => run(`int${a.id}`, () => growthApi.updateAccount(a.id, { syncIntervalMin: e.target.value ? Number(e.target.value) : null }), 'Sync schedule saved')}
                        className="mt-1 block w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                        {SYNC_INTERVALS.map(([v, lab]) => <option key={lab} value={v ?? ''}>{lab}</option>)}
                      </select>
                    </label>
                    {stores.length > 1 && (
                      <label className="text-xs text-muted" htmlFor={`st-${a.id}`}>
                        Advertises store
                        <select id={`st-${a.id}`} value={a.storeId ?? ''} onChange={(e) => run(`st${a.id}`, () => growthApi.updateAccount(a.id, { storeId: e.target.value ? Number(e.target.value) : null }), 'Store saved')}
                          className="mt-1 block w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                          <option value="">All stores</option>
                          {stores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                      </label>
                    )}
                    {a.platform === 'meta' && (
                      <div className="text-xs text-muted sm:col-span-2 lg:col-span-1">
                        <div className="flex items-center gap-1 font-semibold text-ink"><Send size={13} /> Delivered purchases → Meta</div>
                        <p className="mt-0.5">Sends a <code>DeliveredPurchase</code> event when a parcel is delivered, so Meta learns which buyers actually pay. Create a custom conversion on it and optimise to it.</p>
                        <div className="mt-1.5 flex gap-2">
                          <input aria-label="Meta dataset (pixel) id" placeholder="Dataset / pixel id" value={datasets[a.id] ?? ''} onChange={(e) => setDatasets((d) => ({ ...d, [a.id]: e.target.value.trim() }))}
                            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
                          <button type="button" onClick={() => run(`capi${a.id}`, () => growthApi.updateAccount(a.id, { capiDatasetId: datasets[a.id] || null, capiEnabled: !a.capiEnabled }), a.capiEnabled ? 'Delivered events turned off' : 'Delivered events turned on')}
                            className={cn('shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold', a.capiEnabled ? 'bg-emerald-600 text-white' : 'border border-line bg-surface text-ink')}>
                            {a.capiEnabled ? 'On' : 'Turn on'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <WriteAccessPanel />

      <Panel title="Connect an ad account">
        <form className="grid gap-3 sm:grid-cols-[180px_1fr]" onSubmit={(e) => {
          e.preventDefault();
          void run('connect', () => growthApi.connect({ platform: form.platform, externalId: form.externalId.trim(), ...(form.token.trim() ? { token: form.token.trim() } : {}) }), 'Connected — pulling the last 90 days')
            .then(() => setForm((f) => ({ ...f, externalId: '', token: '' })));
        }}>
          <label htmlFor="cn-platform" className="text-sm font-semibold text-ink sm:pt-2">Platform</label>
          <select id="cn-platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
            {(acc?.platforms ?? []).map((p) => <option key={p.platform} value={p.platform} disabled={!p.available}>{p.label}{p.available ? '' : ' — coming soon'}</option>)}
          </select>
          <label htmlFor="cn-id" className="text-sm font-semibold text-ink sm:pt-2">Ad account id</label>
          <div>
            <input id="cn-id" required value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" placeholder={form.platform === 'meta' ? '1234567890' : ''} />
            <p className="mt-1 text-xs text-muted">{ID_HELP[form.platform]}</p>
          </div>
          <label htmlFor="cn-token" className="text-sm font-semibold text-ink sm:pt-2">Token</label>
          <div>
            <input id="cn-token" type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
            <p className="mt-1 text-xs text-muted">{TOKEN_HELP[form.platform]}</p>
          </div>
          <div className="sm:col-start-2">
            <button type="submit" disabled={busy === 'connect' || !form.externalId.trim() || !available.some((p) => p.platform === form.platform)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === 'connect' ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />} Connect
            </button>
          </div>
        </form>
      </Panel>

      <div id="data">
        <Panel title="Data quality" hint="Growth reads one fact row per order. These tools fill gaps in older data.">
          <div className="grid gap-3 md:grid-cols-2">
            {([
              ['attr', 'Backfill attribution', 'Fetch Shopify customer journeys (every visit) for the last 90 days of orders without one.', () => growthApi.backfillAttribution(), 'Journey backfill started'],
              ['fin', 'Backfill order financials', 'Re-import the last 90 days so discounts and the subtotal breakdown are captured.', () => growthApi.backfillFinancials(), 'Financial backfill started'],
              ['cogs', 'Sync cost prices', 'Pull Shopify cost per item for COGS and profit.', () => growthApi.syncCogs(), 'Cost sync started'],
              ['rebuild', 'Rebuild Growth data', 'Recompute every order’s lifecycle, profit and attribution now (normally automatic).', () => growthApi.rebuild(), 'Rebuild started'],
            ] as Array<[string, string, string, () => Promise<unknown>, string]>).map(([k, title, desc, fn, ok]) => (
              <div key={k} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">{title}</div>
                  <p className="mt-0.5 text-xs text-muted">{desc}</p>
                </div>
                <button type="button" disabled={busy === k} onClick={() => run(k, fn, ok)} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
                  {busy === k ? <Loader2 size={13} className="animate-spin" /> : 'Run'}
                </button>
              </div>
            ))}
          </div>
          {status && (
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><Database size={13} /> Reading from {status.store === 'clickhouse' ? 'ClickHouse' : 'MariaDB'}{status.clickhouse.enabled && !status.clickhouse.healthy ? ' (ClickHouse unavailable)' : ''}</span>
              <span>{status.facts.orders.toLocaleString()} orders modelled{status.facts.lastBuiltAt ? ` · last built ${fmtDateTime(status.facts.lastBuiltAt)}` : ''}</span>
              <span>{status.touchpoints.toLocaleString()} journey touchpoints</span>
            </p>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title="Disconnect this ad account?"
        message={`Spend and creatives pulled from ${confirm?.name ?? confirm?.externalId ?? 'this account'} are removed from Growth. You can reconnect any time and history is pulled again.`}
        confirmLabel="Disconnect"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const a = confirm;
          setConfirm(null);
          if (a) void run(`del${a.id}`, () => growthApi.disconnect(a.id), 'Disconnected');
        }}
      />
    </div>
  );
}
