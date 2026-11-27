'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2, Plug } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useToast } from '@/components/toast';
import { growthApi, type GoogleExchange } from '@/lib/growth';
import { Panel } from '@/components/growth/ui';
import { Skeleton } from '@/components/ui/skeleton';
import { GoogleG } from '@/components/growth/google-g';

/**
 * Google sends the browser back here (the OAuth client's redirect URI) with
 * `code` + `state`. We swap the code once (the server keeps the refresh token),
 * then the owner picks Ads accounts (grouped under their manager) or YouTube channels.
 */
function GoogleCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<GoogleExchange | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [stores, setStores] = useState<Array<{ id: number; label: string }>>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (started.current) return; // a code works once — never exchange twice
    started.current = true;
    const code = params.get('code');
    const state = params.get('state');
    const denied = params.get('error');
    if (denied) {
      setError(denied === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google sign-in failed (${denied}).`);
      return;
    }
    if (!code || !state) {
      setError('Google did not send a sign-in code. Start again from Connections.');
      return;
    }
    growthApi
      .googleExchange(code, state)
      .then((r) => {
        setPick(r);
        const ids = r.purpose === 'ads' ? r.accounts.filter((a) => !a.isManager && !a.testAccount).map((a) => a.customerId) : r.channels.map((c) => c.id);
        setChosen(new Set(ids));
      })
      .catch((e) => setError(e instanceof ApiError ? e.userMessage : 'Google sign-in failed.'));
    apiFetch<Array<{ id: number; label: string }>>('/shopify/stores').then((r) => setStores(Array.isArray(r) ? r : [])).catch(() => setStores([]));
  }, [params]);

  // Ads accounts grouped under the manager they are reached through.
  const groups = useMemo(() => {
    if (!pick || pick.purpose !== 'ads') return [];
    const out = new Map<string, { title: string; rows: GoogleExchange['accounts'] }>();
    for (const a of pick.accounts) {
      if (a.isManager) continue;
      const key = a.loginCustomerId ?? 'direct';
      const title = a.loginCustomerId ? `${a.managerName ?? 'Manager account'} · manager ${fmtCid(a.loginCustomerId)}` : 'Accounts you can access directly';
      const g = out.get(key) ?? { title, rows: [] };
      g.rows.push(a);
      out.set(key, g);
    }
    return Array.from(out.values());
  }, [pick]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id); else next.delete(id);
    setChosen(next);
  };

  const connect = async () => {
    if (!pick || chosen.size === 0) return;
    setBusy(true);
    try {
      if (pick.purpose === 'ads') {
        const r = await growthApi.googleConnect({ pickId: pick.pickId, customerIds: Array.from(chosen), storeId });
        if (r.connected) toast.success(`Connected ${r.connected} Google Ads account${r.connected === 1 ? '' : 's'}, pulling the last 90 days`);
        for (const f of r.failed) toast.error(`${fmtCid(f.customerId)}: ${f.error}`);
        if (r.connected) router.replace('/growth/connections');
      } else {
        const r = await growthApi.youtubeConnect({ pickId: pick.pickId, channelIds: Array.from(chosen) });
        if (r.connected) toast.success(`Connected ${r.connected} YouTube channel${r.connected === 1 ? '' : 's'}, pulling stats and comments`);
        for (const f of r.failed) toast.error(f.error);
        if (r.connected) router.replace('/growth/connections');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Panel title="Connect with Google">
        <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle size={15} /> {error}</p>
        <Link href="/growth/connections" className="mt-3 inline-block text-sm font-semibold text-brand-600">Back to Connections</Link>
      </Panel>
    );
  }
  if (!pick) {
    return (
      <Panel title="Connect with Google">
        <Skeleton className="h-5 w-64" />
        <p className="mt-2 text-sm text-muted">Finishing Google sign-in…</p>
      </Panel>
    );
  }
  const isAds = pick.purpose === 'ads';
  return (
    <Panel
      title={isAds ? 'Choose Google Ads accounts' : 'Choose YouTube channels'}
      hint={`${pick.email ? `Signed in as ${pick.email} · ` : ''}${isAds ? 'each account syncs 90 days of history.' : 'stats, videos and comments sync into Growth.'}`}
    >
      <div className="mb-3 flex items-center gap-2 text-sm text-muted"><GoogleG size={16} /> Google</div>
      {isAds ? (
        groups.length === 0 ? (
          <p className="text-sm text-muted">This Google login has no Google Ads accounts. Sign in with a user who has access in Google Ads.</p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.title} className="overflow-hidden rounded-lg border border-line">
                <div className="border-b border-line bg-sunken px-3 py-2 text-xs font-semibold text-muted">{g.title}</div>
                <ul className="divide-y divide-line">
                  {g.rows.map((a) => (
                    <li key={a.customerId}>
                      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                        <input type="checkbox" checked={chosen.has(a.customerId)} onChange={(e) => toggle(a.customerId, e.target.checked)} />
                        <span className="min-w-0 flex-1">
                          <span className="font-semibold text-ink">{a.name ?? 'Google Ads account'}</span>
                          <span className="block text-xs text-muted">{fmtCid(a.customerId)} · {a.currency ?? '—'} · {a.timezone ?? ''}</span>
                        </span>
                        {a.testAccount && <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Test account</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      ) : pick.channels.length === 0 ? (
        <p className="text-sm text-muted">This Google account has no YouTube channel. If the channel is a brand account, sign in again and pick the brand account on Google&apos;s screen.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {pick.channels.map((c) => (
            <li key={c.id}>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                <input type="checkbox" checked={chosen.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                {c.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element -- remote channel avatar
                  <img src={c.thumb} alt="" className="h-8 w-8 rounded-full object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-ink">{c.title ?? c.id}</span>
                  <span className="block text-xs text-muted">{c.handle ?? c.id} · {c.subscribers.toLocaleString()} subscribers · {c.videos} videos</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {isAds && stores.length > 1 && (
        <label className="mt-3 flex items-center gap-2 text-sm text-ink">
          Store
          <select value={storeId ?? ''} onChange={(e) => setStoreId(e.target.value ? Number(e.target.value) : null)} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm">
            <option value="">All stores</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      )}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy || chosen.size === 0} onClick={() => void connect()}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />} Connect {chosen.size || ''}
        </button>
        <Link href="/growth/connections" className="inline-flex min-h-[44px] items-center rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink">Cancel</Link>
      </div>
      {isAds && pick.accounts.some((a) => a.testAccount) && (
        <p className="mt-3 text-xs text-muted">Test accounts are unticked by default. They never serve ads, but they are useful to try editing and creating campaigns safely.</p>
      )}
    </Panel>
  );
}

function fmtCid(id: string) {
  const d = id.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <GoogleCallback />
    </Suspense>
  );
}
