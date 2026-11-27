'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, CheckCircle2, Circle, Loader2, MapPinOff, Music2, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money, ratio } from '@/lib/format-number';
import { useToast } from '@/components/toast';
import { useGrowth } from '@/components/growth/growth-filters';
import { growthManageApi, type CreateAssets, type DraftBid, type TikTokCreateDraft } from '@/lib/growth-manage';
import { Card, Field, Segmented, inputCls } from './meta-builder';
import { isUrl, type BuilderProps } from './shared';

const PK = '1168579';

const EMPTY: TikTokCreateDraft = {
  platform: 'tiktok',
  objective: 'WEB_CONVERSIONS',
  name: '',
  cbo: false,
  budgetType: 'daily',
  budget: 0,
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
  bidAmount: null,
  roasFloor: null,
  pixelId: null,
  conversionEvent: 'SHOPPING',
  locationIds: [PK],
  excludeLocationIds: [],
  ageGroups: [],
  gender: 'GENDER_UNLIMITED',
  startTime: null,
  endTime: null,
  identityId: null,
  identityType: null,
  displayName: '',
  videoId: '',
  adText: '',
  cta: 'SHOP_NOW',
  url: '',
};

const AGES: Array<[string, string]> = [['AGE_18_24', '18–24'], ['AGE_25_34', '25–34'], ['AGE_35_44', '35–44'], ['AGE_45_54', '45–54'], ['AGE_55_100', '55+']];
const CTAS: Array<[string, string]> = [['SHOP_NOW', 'Shop now'], ['ORDER_NOW', 'Order now'], ['LEARN_MORE', 'Learn more'], ['GET_QUOTE', 'Get quote'], ['CONTACT_US', 'Contact us']];
const EVENTS: Array<[string, string]> = [['SHOPPING', 'Complete payment'], ['ON_WEB_ORDER', 'Place an order'], ['INITIATE_ORDER', 'Initiate checkout'], ['ON_WEB_CART', 'Add to cart']];

/** TikTok campaign builder: campaign → ad group → video ad, all created DISABLED (paused). */
export function TikTokBuilder({ accounts, store }: BuilderProps) {
  const router = useRouter();
  const toast = useToast();
  const { mode } = useGrowth();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [assets, setAssets] = useState<CreateAssets | null>(null);
  const [assetsErr, setAssetsErr] = useState<string | null>(null);
  const [d, setD] = useState<TikTokCreateDraft>(EMPTY);
  const [localVideo, setLocalVideo] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [creating, setCreating] = useState(false);
  const [locQ, setLocQ] = useState('');
  const [locHits, setLocHits] = useState<Array<{ key: string; name: string; region: string }>>([]);
  const [locNames, setLocNames] = useState<Record<string, string>>({ [PK]: 'Pakistan' });
  const hydrated = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = useCallback(<K extends keyof TikTokCreateDraft>(k: K, v: TikTokCreateDraft[K]) => setD((x) => ({ ...x, [k]: v })), []);

  useEffect(() => {
    const s = store.get('tiktok') as { accountId?: number; draft?: Partial<TikTokCreateDraft>; names?: Record<string, string> } | undefined;
    setAccountId(s?.accountId && accounts.some((a) => a.id === s.accountId) ? s.accountId : accounts[0]?.id ?? null);
    if (s?.draft) setD({ ...EMPTY, ...s.draft, platform: 'tiktok' });
    if (s?.names) setLocNames((n) => ({ ...n, ...s.names }));
    hydrated.current = true;
    // hydrate once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setAssets(null);
    setAssetsErr(null);
    growthManageApi
      .assets(accountId)
      .then((a) => {
        setAssets(a);
        setD((x) => ({
          ...x,
          pixelId: x.pixelId || a.pixels[0]?.id || null,
          identityId: x.identityId && a.identities?.some((i) => i.id === x.identityId) ? x.identityId : a.identities?.[0]?.id ?? null,
          identityType: x.identityId ? x.identityType : a.identities?.[0]?.type ?? null,
        }));
        setLocNames((n) => ({ ...n, ...Object.fromEntries(a.riskyCities.map((c) => [c.key, c.name])) }));
      })
      .catch((e) => setAssetsErr(e instanceof ApiError ? e.userMessage : 'Could not load the advertiser.'));
  }, [accountId]);

  useEffect(() => {
    if (!hydrated.current) return;
    setSaved('saving');
    const t = setTimeout(() => {
      store.save('tiktok', { accountId, draft: d, names: locNames }).then(() => setSaved('saved')).catch(() => setSaved('idle'));
    }, 1500);
    return () => clearTimeout(t);
  }, [d, accountId, store, locNames]);

  useEffect(() => {
    if (!accountId || locQ.trim().length < 2) {
      setLocHits([]);
      return;
    }
    const t = setTimeout(() => {
      growthManageApi.cities(accountId, locQ.trim()).then(setLocHits).catch(() => setLocHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [locQ, accountId]);

  const cur = assets?.account.currency ?? null;
  const fmt = (v: number | null | undefined) => money(v ?? null, cur, mode);
  const b = assets?.benchmarks;
  const web = d.objective === 'WEB_CONVERSIONS';

  const onFile = async (f: File | undefined) => {
    if (!f || !accountId) return;
    setUploading(true);
    try {
      const r = await growthManageApi.media(accountId, f);
      if (!r.videoId) throw new Error('Upload a video (MP4/MOV).');
      setLocalVideo(URL.createObjectURL(f));
      set('videoId', r.videoId);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : (e as Error).message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const checks: Array<[boolean, string]> = [
    [!!d.name.trim(), 'Campaign name'],
    [d.budget > 0, 'Budget'],
    [d.budgetType === 'daily' || !!d.endTime, 'End date (lifetime budget)'],
    [d.bidStrategy !== 'COST_CAP' || Number(d.bidAmount) > 0, 'Cost cap'],
    [d.bidStrategy !== 'LOWEST_COST_WITH_MIN_ROAS' || Number(d.roasFloor) > 0, 'Minimum ROAS'],
    [!web || !!d.pixelId, 'Pixel'],
    [d.locationIds.length > 0, 'Location'],
    [!!d.identityId || !!d.displayName?.trim(), 'Identity'],
    [!!d.videoId, 'Video'],
    [!!d.adText.trim() && d.adText.length <= 100, 'Ad text (≤ 100)'],
    [isUrl(d.url), 'Landing page'],
  ];
  const ready = checks.every(([ok]) => ok);

  const create = async () => {
    if (!accountId || !ready) return;
    setCreating(true);
    try {
      const ident = assets?.identities?.find((i) => i.id === d.identityId);
      const r = await growthManageApi.create(accountId, { ...d, identityType: ident?.type ?? d.identityType ?? null });
      await store.save('tiktok', null).catch(() => undefined);
      toast.success('TikTok campaign created (disabled). Turn it on from Campaigns when ready.');
      router.push(`/growth/campaigns?created=${r.campaignId ?? ''}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Creating the campaign failed.');
    } finally {
      setCreating(false);
    }
  };

  const strategies: Array<[DraftBid, string, string]> = [
    ['LOWEST_COST_WITHOUT_CAP', 'Maximum delivery', 'Spend the budget for the most results. Best while learning.'],
    ['COST_CAP', 'Cost cap', 'Keep the average cost per result around a target.'],
    ...(web ? [['LOWEST_COST_WITH_MIN_ROAS', 'Minimum ROAS', 'Optimise for value with a return floor.'] as [DraftBid, string, string]] : []),
  ];
  const library = assets?.videos ?? [];
  const pickedLib = library.find((v) => v.id === d.videoId);
  const identity = assets?.identities?.find((i) => i.id === d.identityId);

  return (
    <div>
      <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/growth/campaigns" aria-label="Back to campaigns" className="rounded-lg border border-line p-2 text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /></Link>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink"><Music2 size={18} /> Create TikTok campaign</h2>
            <p className="text-xs text-muted">Created <b className="text-ink">disabled</b>. Draft {saved === 'saving' ? 'saving…' : saved === 'saved' ? 'saved' : 'not saved yet'}.</p>
          </div>
        </div>
        {accounts.length > 1 && (
          <select aria-label="TikTok advertiser" value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      {assetsErr && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{assetsErr}</div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Card title="Campaign">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Campaign name"><input className={inputCls} value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={400} /></Field>
              <Field label="Objective">
                <select className={inputCls} value={d.objective} onChange={(e) => set('objective', e.target.value as TikTokCreateDraft['objective'])}>
                  <option value="WEB_CONVERSIONS">Website conversions</option>
                  <option value="TRAFFIC">Traffic</option>
                  <option value="VIDEO_VIEWS">Video views</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[auto_auto_1fr]">
              <Field label="Budget on"><Segmented value={d.cbo} onChange={(v) => set('cbo', v)} options={[[false, 'Ad group'], [true, 'Campaign']]} /></Field>
              <Field label="Budget type"><Segmented value={d.budgetType} onChange={(v) => set('budgetType', v)} options={[['daily', 'Daily'], ['lifetime', 'Lifetime']]} /></Field>
              <Field label={d.budgetType === 'daily' ? 'Daily budget' : 'Lifetime budget'} hint={b?.dailySpend ? <>About <b className="text-ink">{fmt(b.dailySpend)}</b> a day lately.</> : undefined}>
                <div className="flex items-center gap-2">
                  <input className={inputCls} inputMode="decimal" value={d.budget || ''} placeholder="0" onChange={(e) => set('budget', Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} />
                  <span className="text-xs font-bold text-muted">{cur}</span>
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Ad group">
            {web && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Pixel">
                  <select className={inputCls} value={d.pixelId ?? ''} onChange={(e) => set('pixelId', e.target.value || null)}>
                    {!(assets?.pixels.length) && <option value="">No pixel on this advertiser</option>}
                    {assets?.pixels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Optimise for">
                  <select className={inputCls} value={d.conversionEvent ?? 'SHOPPING'} onChange={(e) => set('conversionEvent', e.target.value)}>
                    {EVENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
              </div>
            )}
            <Field label="Bid strategy">
              <div className="grid gap-2 sm:grid-cols-3">
                {strategies.map(([s, l, h]) => (
                  <button key={s} type="button" onClick={() => set('bidStrategy', s)} aria-pressed={d.bidStrategy === s}
                    className={cn('rounded-xl border p-3 text-left transition', d.bidStrategy === s ? 'border-violet-400 bg-violet-50/70 ring-1 ring-violet-300 dark:border-violet-600 dark:bg-violet-950/30' : 'border-line hover:bg-sunken')}>
                    <div className="text-sm font-bold text-ink">{l}</div>
                    <div className="mt-0.5 text-xs leading-snug text-muted">{h}</div>
                  </button>
                ))}
              </div>
            </Field>
            {d.bidStrategy === 'COST_CAP' && (
              <Field label="Cost cap" hint={b?.platformCpa ? <>Recent cost per purchase on TikTok: <b className="text-ink">{fmt(b.platformCpa)}</b>.</> : undefined}>
                <div className="flex items-center gap-2">
                  <input className={inputCls} inputMode="decimal" value={d.bidAmount ?? ''} onChange={(e) => set('bidAmount', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
                  <span className="text-xs font-bold text-muted">{cur}</span>
                </div>
              </Field>
            )}
            {d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && (
              <Field label="Minimum ROAS" hint={b?.breakEvenMetaRoas != null ? <>Break-even in TikTok&apos;s placed-order terms is about <b className="text-ink">{ratio(b.breakEvenMetaRoas)}</b>.</> : undefined}>
                <input className={inputCls} inputMode="decimal" placeholder="e.g. 2.5" value={d.roasFloor ?? ''} onChange={(e) => set('roasFloor', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
              </Field>
            )}
            <Field label="Locations">
              <div className="flex flex-wrap gap-2">
                {d.locationIds.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                    {locNames[id] ?? id}<button type="button" aria-label="Remove location" onClick={() => set('locationIds', d.locationIds.filter((x) => x !== id))}><X size={12} /></button>
                  </span>
                ))}
                {(d.excludeLocationIds ?? []).map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    <MapPinOff size={12} /> {locNames[id] ?? id}<button type="button" aria-label="Remove exclusion" onClick={() => set('excludeLocationIds', (d.excludeLocationIds ?? []).filter((x) => x !== id))}><X size={12} /></button>
                  </span>
                ))}
              </div>
              {(assets?.riskyCities ?? []).filter((c) => !(d.excludeLocationIds ?? []).includes(c.key)).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(assets?.riskyCities ?? []).filter((c) => !(d.excludeLocationIds ?? []).includes(c.key)).map((c) => (
                    <button key={c.key} type="button" onClick={() => set('excludeLocationIds', [...(d.excludeLocationIds ?? []), c.key])}
                      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                      <MapPinOff size={12} /> Exclude {c.name} · {Math.round(c.rate * 100)}% return
                    </button>
                  ))}
                </div>
              )}
              <input className={cn(inputCls, 'mt-2')} placeholder="Search a city or region" value={locQ} onChange={(e) => setLocQ(e.target.value)} />
              {locHits.length > 0 && (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line">
                  {locHits.map((h) => (
                    <li key={h.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                      <span>{h.name} <span className="text-xs text-muted">{h.region}</span></span>
                      <span className="flex gap-1">
                        <button type="button" className="rounded border border-line px-2 py-0.5 text-xs font-semibold" onClick={() => { setLocNames((n) => ({ ...n, [h.key]: h.name })); set('locationIds', Array.from(new Set([...d.locationIds, h.key]))); setLocQ(''); }}>Target</button>
                        <button type="button" className="rounded border border-line px-2 py-0.5 text-xs font-semibold text-red-600" onClick={() => { setLocNames((n) => ({ ...n, [h.key]: h.name })); set('excludeLocationIds', Array.from(new Set([...(d.excludeLocationIds ?? []), h.key]))); setLocQ(''); }}>Exclude</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Age" hint="None picked = all ages.">
                <div className="flex flex-wrap gap-1.5">
                  {AGES.map(([k, l]) => {
                    const on = d.ageGroups.includes(k);
                    return <button key={k} type="button" aria-pressed={on} onClick={() => set('ageGroups', on ? d.ageGroups.filter((x) => x !== k) : [...d.ageGroups, k])}
                      className={cn('rounded-full border px-2.5 py-1 text-xs font-bold', on ? 'border-violet-400 bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200' : 'border-line text-ink')}>{l}</button>;
                  })}
                </div>
              </Field>
              <Field label="Gender">
                <Segmented value={d.gender} onChange={(v) => set('gender', v)} options={[['GENDER_UNLIMITED', 'All'], ['GENDER_FEMALE', 'Women'], ['GENDER_MALE', 'Men']]} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start" hint="Optional."><input type="date" className={inputCls} value={d.startTime?.slice(0, 10) ?? ''} onChange={(e) => set('startTime', e.target.value ? `${e.target.value}T00:00:00Z` : null)} /></Field>
              <Field label="End" hint={d.budgetType === 'lifetime' ? 'Required for a lifetime budget.' : 'Optional.'}><input type="date" className={inputCls} value={d.endTime?.slice(0, 10) ?? ''} onChange={(e) => set('endTime', e.target.value ? `${e.target.value}T23:59:00Z` : null)} /></Field>
            </div>
          </Card>

          <Card title="Ad">
            <Field label="Identity" hint={assets?.identities?.length ? 'The name and picture shown on the ad.' : 'No identity yet: enter a display name and CodesApp creates one.'}>
              {assets?.identities?.length ? (
                <select className={inputCls} value={d.identityId ?? ''} onChange={(e) => set('identityId', e.target.value || null)}>
                  {assets.identities.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id} · {i.type === 'CUSTOMIZED_USER' ? 'custom' : 'TikTok account'}</option>)}
                </select>
              ) : (
                <input className={inputCls} maxLength={40} placeholder="Your brand name" value={d.displayName ?? ''} onChange={(e) => set('displayName', e.target.value)} />
              )}
            </Field>
            <Field label="Video" hint="Vertical 9:16 works best. Pick from your TikTok library or upload.">
              <div className="flex flex-wrap gap-2">
                {library.slice(0, 10).map((v) => {
                  const on = d.videoId === v.id;
                  return (
                    <button key={v.id} type="button" aria-pressed={on} title={v.name ?? v.id} onClick={() => { set('videoId', v.id); setLocalVideo(null); }}
                      className={cn('relative h-24 w-14 overflow-hidden rounded-lg border-2 bg-sunken', on ? 'border-violet-500' : 'border-transparent')}>
                      {v.cover
                        // eslint-disable-next-line @next/next/no-img-element -- TikTok cover
                        ? <img src={v.cover} alt="" className="h-full w-full object-cover" />
                        : <span className="grid h-full w-full place-items-center text-[10px] text-muted">video</span>}
                      {on && <span className="absolute right-1 top-1 rounded-full bg-violet-600 p-0.5 text-white"><Check size={10} /></span>}
                    </button>
                  );
                })}
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || !assets}
                  className="grid h-24 w-14 place-items-center rounded-lg border border-dashed border-line text-muted hover:bg-sunken">
                  {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                </button>
              </div>
            </Field>
            <Field label={`Ad text (${d.adText.length}/100)`}>
              <textarea className={cn(inputCls, 'min-h-[72px]')} maxLength={120} value={d.adText} onChange={(e) => set('adText', e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
              <Field label="Landing page" hint="UTMs with TikTok macros are added automatically."><input className={inputCls} placeholder="https://yourstore.com/products/…" value={d.url} onChange={(e) => set('url', e.target.value)} /></Field>
              <Field label="Call to action">
                <select className={inputCls} value={d.cta} onChange={(e) => set('cta', e.target.value)}>
                  {CTAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
            </div>
          </Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Preview</div>
            <div className="relative mx-auto mt-3 aspect-[9/16] w-48 overflow-hidden rounded-2xl bg-black">
              {localVideo ? (
                <video src={localVideo} className="h-full w-full object-cover" muted loop autoPlay playsInline />
              ) : pickedLib?.cover ? (
                // eslint-disable-next-line @next/next/no-img-element -- TikTok cover
                <img src={pickedLib.cover} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center text-xs text-white/60">Your 9:16 video</span>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-white">
                <div className="text-xs font-bold">{identity?.name ?? (d.displayName || 'Your brand')} · Sponsored</div>
                <div className="mt-1 line-clamp-3 text-xs">{d.adText || 'Your ad text shows here.'}</div>
                <div className="mt-2 rounded bg-[#FE2C55] py-1 text-center text-xs font-bold">{CTAS.find(([k]) => k === d.cta)?.[1] ?? 'Shop now'}</div>
              </div>
            </div>
          </section>
          <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Ready to create</div>
            <ul className="mt-2 space-y-1.5">
              {checks.map(([ok, l]) => (
                <li key={l} className={cn('flex items-center gap-2 text-sm', ok ? 'text-ink' : 'text-amber-700 dark:text-amber-300')}>
                  {ok ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Circle size={15} />} {l}
                </li>
              ))}
            </ul>
            {b?.platformCpa != null && d.budget > 0 && d.budgetType === 'daily' && (
              <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                At ~{fmt(b.platformCpa)} per purchase, {fmt(d.budget)} a day is about <b className="text-ink">{Math.max(0, Math.round((d.budget * 7) / b.platformCpa))}</b> purchases a week. TikTok exits learning after ~50 conversions.
              </p>
            )}
            <button type="button" disabled={!ready || creating || !accountId} onClick={() => void create()}
              className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">
              {creating && <Loader2 size={15} className="animate-spin" />} Create disabled campaign
            </button>
            <p className="mt-2 text-xs text-muted">Nothing spends until you turn it on from Campaigns.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
