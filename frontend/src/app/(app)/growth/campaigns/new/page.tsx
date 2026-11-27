'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { growthApi } from '@/lib/growth';
import { growthManageApi } from '@/lib/growth-manage';
import { MetaBuilder } from '@/components/growth/create/meta-builder';
import { GoogleBuilder } from '@/components/growth/create/google-builder';
import { TikTokBuilder } from '@/components/growth/create/tiktok-builder';
import { normalisePayload, useDraftStore, type BuilderPlatform } from '@/components/growth/create/shared';

const LABEL: Record<BuilderPlatform, string> = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' };

/** New campaign: one builder per ad platform, all creating PAUSED campaigns. */
export default function NewCampaignPage() {
  const [loaded, setLoaded] = useState(false);
  const [byPlatform, setByPlatform] = useState<Record<BuilderPlatform, Array<{ id: number; name: string | null }>>>({ meta: [], google: [], tiktok: [] });
  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  const [platform, setPlatform] = useState<BuilderPlatform>('meta');

  useEffect(() => {
    Promise.all([growthApi.accounts(), growthManageApi.access(), growthManageApi.getDraft().catch(() => null)])
      .then(([a, acc, draft]) => {
        const ok = new Set(acc.filter((x) => x.canManage).map((x) => x.accountId));
        const out: Record<BuilderPlatform, Array<{ id: number; name: string | null }>> = { meta: [], google: [], tiktok: [] };
        for (const x of a.accounts) {
          if (!ok.has(x.id) || !(x.platform in out)) continue;
          out[x.platform as BuilderPlatform].push({ id: x.id, name: x.name ?? x.externalId });
        }
        setByPlatform(out);
        const payload = (draft?.payload ?? null) as Record<string, unknown> | null;
        setInitial(payload);
        const last = normalisePayload(payload).platform;
        const first = (['meta', 'google', 'tiktok'] as const).find((p) => out[p].length);
        setPlatform(last && out[last].length ? last : first ?? 'meta');
      })
      .finally(() => setLoaded(true));
  }, []);

  const available = (['meta', 'google', 'tiktok'] as const).filter((p) => byPlatform[p].length);

  if (!loaded) {
    return <div className="flex items-center gap-2 py-16 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading your ad accounts…</div>;
  }
  if (!available.length) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-extrabold text-ink">No ad account can create ads yet</h2>
        <p className="mt-2 text-sm text-muted">Connect Meta, Google Ads or TikTok with write access. For Meta the token needs <b className="text-ink">ads_management</b>.</p>
        <Link href="/growth/connections" className="mt-4 inline-flex rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface">Open Connections</Link>
      </div>
    );
  }
  return (
    <div>
      {available.length > 1 && (
        <div role="group" aria-label="Ad platform" className="mb-4 inline-flex rounded-xl border border-line bg-sunken/60 p-1">
          {available.map((p) => (
            <button key={p} type="button" onClick={() => setPlatform(p)} aria-pressed={platform === p}
              className={cn('min-h-[40px] rounded-lg px-5 text-sm font-bold transition', platform === p ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
              {LABEL[p]}
            </button>
          ))}
        </div>
      )}
      <Builders platform={platform} initial={initial} byPlatform={byPlatform} />
    </div>
  );
}

function Builders({ platform, initial, byPlatform }: {
  platform: BuilderPlatform;
  initial: Record<string, unknown> | null;
  byPlatform: Record<BuilderPlatform, Array<{ id: number; name: string | null }>>;
}) {
  const store = useDraftStore(initial, platform);
  if (platform === 'google') return <GoogleBuilder key="google" accounts={byPlatform.google} store={store} />;
  if (platform === 'tiktok') return <TikTokBuilder key="tiktok" accounts={byPlatform.tiktok} store={store} />;
  return <MetaBuilder key="meta" accounts={byPlatform.meta} store={store} />;
}
