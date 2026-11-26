'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2, Plug } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useToast } from '@/components/toast';
import { growthApi } from '@/lib/growth';
import { Panel } from '@/components/growth/ui';
import { Skeleton } from '@/components/ui/skeleton';

type Advertiser = { id: string; name: string | null };

/**
 * TikTok sends the browser back here (the app's Advertiser redirect URL) with
 * `auth_code` + `state`. We swap the code once (server keeps the token), then
 * the owner picks which advertisers to connect.
 */
function TikTokCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pickId, setPickId] = useState<string | null>(null);
  const [advertisers, setAdvertisers] = useState<Advertiser[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [stores, setStores] = useState<Array<{ id: number; label: string }>>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (started.current) return; // an auth code works once — never exchange twice
    started.current = true;
    const code = params.get('auth_code') ?? params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setError('TikTok did not send a sign-in code. Start again from Connections.');
      return;
    }
    growthApi
      .tiktokExchange(code, state)
      .then((r) => {
        setPickId(r.pickId);
        setAdvertisers(r.advertisers);
        setChosen(new Set(r.advertisers.map((a) => a.id)));
      })
      .catch((e) => setError(e instanceof ApiError ? e.userMessage : 'TikTok sign-in failed.'));
    apiFetch<Array<{ id: number; label: string }>>('/shopify/stores').then((r) => setStores(Array.isArray(r) ? r : [])).catch(() => setStores([]));
  }, [params]);

  const connect = async () => {
    if (!pickId || chosen.size === 0) return;
    setBusy(true);
    try {
      const r = await growthApi.tiktokConnect({ pickId, advertiserIds: Array.from(chosen), storeId });
      if (r.connected) toast.success(`Connected ${r.connected} TikTok account${r.connected === 1 ? '' : 's'} — pulling the last 90 days`);
      for (const f of r.failed) toast.error(`${f.advertiserId}: ${f.error}`);
      if (r.connected) router.replace('/growth/connections');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Panel title="Connect TikTok">
        <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle size={15} /> {error}</p>
        <Link href="/growth/connections" className="mt-3 inline-block text-sm font-semibold text-brand-600">Back to Connections</Link>
      </Panel>
    );
  }
  if (!pickId) {
    return (
      <Panel title="Connect TikTok">
        <Skeleton className="h-5 w-64" />
        <p className="mt-2 text-sm text-muted">Finishing TikTok sign-in…</p>
      </Panel>
    );
  }
  return (
    <Panel title="Choose TikTok ad accounts" hint="Each account you pick syncs spend, campaigns and results into Growth.">
      {advertisers.length === 0 ? (
        <p className="text-sm text-muted">This TikTok login has no advertiser accounts. Sign in with a user who has access in TikTok Ads Manager.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {advertisers.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                <input type="checkbox" checked={chosen.has(a.id)} onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(a.id); else next.delete(a.id);
                  setChosen(next);
                }} />
                <span className="font-semibold text-ink">{a.name ?? 'TikTok advertiser'}</span>
                <span className="text-xs text-muted">{a.id}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {stores.length > 1 && (
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
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />} Connect {chosen.size || ''}
        </button>
        <Link href="/growth/connections" className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink">Cancel</Link>
      </div>
    </Panel>
  );
}

export default function TikTokCallbackPage() {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <TikTokCallback />
    </Suspense>
  );
}
