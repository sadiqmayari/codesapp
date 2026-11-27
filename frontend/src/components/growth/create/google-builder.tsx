'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, CheckCircle2, Circle, ImagePlus, Loader2, MapPinOff, Plus, Sparkles, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money, ratio } from '@/lib/format-number';
import { useToast } from '@/components/toast';
import { useGrowth } from '@/components/growth/growth-filters';
import { growthManageApi, type CreateAssets, type DraftBid, type GoogleCreateDraft } from '@/lib/growth-manage';
import { Card, Field, Segmented, inputCls } from './meta-builder';
import { isUrl, type BuilderProps } from './shared';
import { GoogleG } from '@/components/growth/google-g';

const EMPTY: GoogleCreateDraft = {
  platform: 'google',
  type: 'pmax',
  name: '',
  budget: 0,
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
  bidFamily: 'value',
  bidAmount: null,
  roasFloor: null,
  countries: ['PK'],
  excludeCities: [],
  languages: ['en', 'ur'],
  startTime: null,
  endTime: null,
  url: '',
  businessName: '',
  headlines: ['', '', ''],
  longHeadlines: [''],
  descriptions: ['', ''],
  keywords: [],
  landscapeImages: [],
  squareImages: [],
  logoImages: [],
  youtubeVideoIds: [],
};

const TYPES: Array<[GoogleCreateDraft['type'], string, string]> = [
  ['search', 'Search', 'Text ads on Google search, by keyword.'],
  ['pmax', 'Performance Max', 'Search, YouTube, Display, Gmail and Maps from one set of assets.'],
  ['video', 'YouTube video', 'Video ads (Demand Gen) from your connected channel, or upload a new video.'],
];

const COUNTRIES: Array<[string, string]> = [['PK', 'Pakistan'], ['AE', 'UAE'], ['SA', 'Saudi Arabia'], ['GB', 'United Kingdom'], ['US', 'United States'], ['QA', 'Qatar']];
const LANGS: Array<[string, string]> = [['en', 'English'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['hi', 'Hindi']];

type Slot = 'landscapeImages' | 'squareImages' | 'logoImages';

/** Google Ads campaign builder: Search / Performance Max / YouTube video — created PAUSED. */
export function GoogleBuilder({ accounts, store }: BuilderProps) {
  const router = useRouter();
  const toast = useToast();
  const { mode } = useGrowth();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [assets, setAssets] = useState<CreateAssets | null>(null);
  const [assetsErr, setAssetsErr] = useState<string | null>(null);
  const [d, setD] = useState<GoogleCreateDraft>(EMPTY);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [creating, setCreating] = useState(false);
  const [cityQ, setCityQ] = useState('');
  const [cityHits, setCityHits] = useState<Array<{ key: string; name: string; region: string }>>([]);
  const [kw, setKw] = useState('');
  const hydrated = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const slotRef = useRef<Slot | 'video'>('landscapeImages');

  const set = useCallback(<K extends keyof GoogleCreateDraft>(k: K, v: GoogleCreateDraft[K]) => setD((x) => ({ ...x, [k]: v })), []);

  useEffect(() => {
    const s = store.get('google') as { accountId?: number; draft?: Partial<GoogleCreateDraft> } | undefined;
    setAccountId(s?.accountId && accounts.some((a) => a.id === s.accountId) ? s.accountId : accounts[0]?.id ?? null);
    if (s?.draft) setD({ ...EMPTY, ...s.draft, platform: 'google' });
    hydrated.current = true;
    // hydrate once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setAssets(null);
    setAssetsErr(null);
    growthManageApi.assets(accountId).then(setAssets).catch((e) => setAssetsErr(e instanceof ApiError ? e.userMessage : 'Could not load the account.'));
  }, [accountId]);

  useEffect(() => {
    if (!hydrated.current) return;
    setSaved('saving');
    const t = setTimeout(() => {
      store.save('google', { accountId, draft: d }).then(() => setSaved('saved')).catch(() => setSaved('idle'));
    }, 1500);
    return () => clearTimeout(t);
  }, [d, accountId, store]);

  useEffect(() => {
    if (!accountId || cityQ.trim().length < 2) {
      setCityHits([]);
      return;
    }
    const t = setTimeout(() => {
      growthManageApi.cities(accountId, cityQ.trim(), d.countries[0] ?? 'PK').then(setCityHits).catch(() => setCityHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [cityQ, accountId, d.countries]);

  const cur = assets?.account.currency ?? null;
  const fmt = (v: number | null | undefined) => money(v ?? null, cur, mode);
  const b = assets?.benchmarks;

  const pickFile = (slot: Slot | 'video') => {
    slotRef.current = slot;
    if (fileRef.current) {
      fileRef.current.accept = slot === 'video' ? 'video/mp4,video/quicktime' : 'image/jpeg,image/png';
      fileRef.current.click();
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f || !accountId) return;
    const slot = slotRef.current;
    setUploading(slot);
    try {
      const r = await growthManageApi.media(accountId, f);
      if (slot === 'video') {
        if (!r.videoId) throw new Error('No video id');
        set('youtubeVideoIds', [...(d.youtubeVideoIds ?? []), r.videoId]);
        toast.success('Uploaded to your YouTube channel as unlisted.');
      } else if (r.imageHash) {
        setPreviews((p) => ({ ...p, [r.imageHash!]: URL.createObjectURL(f) }));
        set(slot, [...(d[slot] ?? []), r.imageHash]);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed.');
    } finally {
      setUploading(null);
    }
  };

  const listEditor = (key: 'headlines' | 'longHeadlines' | 'descriptions', label: string, max: number, maxCount: number) => {
    const list = (d[key] as string[] | undefined) ?? [];
    return (
      <Field label={`${label} (${list.filter((x) => x.trim()).length})`} hint={`Up to ${max} characters each.`}>
        <div className="space-y-2">
          {list.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputCls} value={v} maxLength={max + 20} onChange={(e) => set(key, list.map((x, j) => (j === i ? e.target.value : x)))} />
              <span className={cn('w-10 shrink-0 text-right text-xs tabular-nums', v.length > max ? 'font-bold text-red-600' : 'text-muted')}>{v.length}/{max}</span>
              {list.length > 1 && (
                <button type="button" aria-label="Remove" onClick={() => set(key, list.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-ink"><X size={14} /></button>
              )}
            </div>
          ))}
          {list.length < maxCount && (
            <button type="button" onClick={() => set(key, [...list, ''])} className="inline-flex items-center gap-1 text-xs font-bold text-violet-700 dark:text-violet-300"><Plus size={13} /> Add</button>
          )}
        </div>
      </Field>
    );
  };

  const imageSlot = (slot: Slot, label: string, ratioCls: string) => (
    <div>
      <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="flex flex-wrap gap-2">
        {(d[slot] ?? []).map((a) => (
          <div key={a} className={cn('relative overflow-hidden rounded-lg border border-line bg-sunken', ratioCls)}>
            {previews[a]
              // eslint-disable-next-line @next/next/no-img-element -- local blob preview
              ? <img src={previews[a]} alt="" className="h-full w-full object-cover" />
              : <span className="grid h-full w-full place-items-center text-[10px] text-muted">uploaded</span>}
            <button type="button" aria-label="Remove image" onClick={() => set(slot, (d[slot] ?? []).filter((x) => x !== a))} className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"><X size={12} /></button>
          </div>
        ))}
        <button type="button" onClick={() => pickFile(slot)} disabled={!!uploading}
          className={cn('grid place-items-center rounded-lg border border-dashed border-line text-muted hover:bg-sunken', ratioCls)}>
          {uploading === slot ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={18} />}
        </button>
      </div>
    </div>
  );

  const clean = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
  const checks: Array<[boolean, string]> = [
    [!!d.name.trim(), 'Campaign name'],
    [d.budget > 0, 'Daily budget'],
    [d.bidStrategy !== 'COST_CAP' || Number(d.bidAmount) > 0, 'Bid target'],
    [d.bidStrategy !== 'LOWEST_COST_WITH_MIN_ROAS' || Number(d.roasFloor) > 0, 'Target ROAS'],
    [isUrl(d.url), 'Website URL'],
    [clean(d.headlines).length >= (d.type === 'video' ? 1 : 3) && clean(d.headlines).every((h) => h.length <= 30), d.type === 'video' ? 'Headline' : '3+ headlines (≤ 30)'],
    [clean(d.descriptions).length >= (d.type === 'video' ? 1 : 2) && clean(d.descriptions).every((h) => h.length <= 90), d.type === 'video' ? 'Description' : '2+ descriptions'],
    ...(d.type === 'search' ? [[(d.keywords ?? []).length > 0, 'Keywords'] as [boolean, string]] : []),
    ...(d.type !== 'search' ? [
      [clean(d.longHeadlines).length > 0, 'Long headline'] as [boolean, string],
      [!!d.businessName?.trim(), 'Business name'] as [boolean, string],
      [(d.logoImages ?? []).length > 0, 'Logo'] as [boolean, string],
    ] : []),
    ...(d.type === 'pmax' ? [
      [(d.landscapeImages ?? []).length > 0, 'Landscape image'] as [boolean, string],
      [(d.squareImages ?? []).length > 0, 'Square image'] as [boolean, string],
    ] : []),
    ...(d.type === 'video' ? [[(d.youtubeVideoIds ?? []).length > 0, 'YouTube video'] as [boolean, string]] : []),
  ];
  const ready = checks.every(([ok]) => ok);

  const create = async () => {
    if (!accountId || !ready) return;
    setCreating(true);
    try {
      const payload: GoogleCreateDraft = {
        ...d,
        headlines: clean(d.headlines),
        longHeadlines: clean(d.longHeadlines),
        descriptions: clean(d.descriptions),
        bidFamily: d.bidStrategy === 'COST_CAP' ? 'conversions' : d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'value' : d.bidFamily,
      };
      const r = await growthManageApi.create(accountId, payload);
      await store.save('google', null).catch(() => undefined);
      toast.success('Google campaign created (paused). Turn it on from Campaigns when ready.');
      router.push(`/growth/campaigns?created=${r.campaignId ?? ''}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Creating the campaign failed.');
    } finally {
      setCreating(false);
    }
  };

  const strategies: Array<[DraftBid, string, string]> = [
    ['LOWEST_COST_WITHOUT_CAP', d.bidFamily === 'value' ? 'Maximize conversion value' : 'Maximize conversions', 'Google spends the budget to get the most sales (value) or orders.'],
    ['COST_CAP', 'Target CPA', 'Most conversions while keeping cost per conversion near a target.'],
    ['LOWEST_COST_WITH_MIN_ROAS', 'Target ROAS', 'Most conversion value while aiming for a return on ad spend.'],
  ];
  const ytVideos = assets?.youtubeVideos ?? [];
  const firstVideo = d.youtubeVideoIds?.[0];

  return (
    <div>
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/growth/campaigns" aria-label="Back to campaigns" className="rounded-lg border border-line p-2 text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /></Link>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink"><GoogleG /> Create Google Ads campaign</h2>
            <p className="text-xs text-muted">Created <b className="text-ink">paused</b>. Draft {saved === 'saving' ? 'saving…' : saved === 'saved' ? 'saved' : 'not saved yet'}.</p>
          </div>
        </div>
        {accounts.length > 1 && (
          <select aria-label="Google Ads account" value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      {assetsErr && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{assetsErr}</div>}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {TYPES.map(([t, l, h]) => (
          <button key={t} type="button" onClick={() => set('type', t)} aria-pressed={d.type === t}
            className={cn('min-h-[84px] rounded-xl border p-4 text-left transition', d.type === t ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-400 dark:bg-blue-950/30' : 'border-line bg-surface hover:bg-sunken')}>
            <div className="text-sm font-extrabold text-ink">{l}</div>
            <div className="mt-1 text-xs text-muted">{h}</div>
          </button>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Card title="Budget & bidding">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Campaign name"><input className={inputCls} value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={255} /></Field>
              <Field label="Daily budget" hint={b?.dailySpend ? <>This account spent about <b className="text-ink">{fmt(b.dailySpend)}</b> a day lately.</> : undefined}>
                <div className="flex items-center gap-2">
                  <input className={inputCls} inputMode="decimal" value={d.budget || ''} placeholder="0" onChange={(e) => set('budget', Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} />
                  <span className="text-xs font-bold text-muted">{cur}</span>
                </div>
              </Field>
            </div>
            <Field label="Optimise for">
              <Segmented value={d.bidFamily} onChange={(v) => set('bidFamily', v)} options={[['value', 'Sales value'], ['conversions', 'Number of orders']]} />
            </Field>
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
              <Field label="Target CPA" hint={b?.platformCpa ? <>Recent cost per conversion on this account: <b className="text-ink">{fmt(b.platformCpa)}</b>.</> : undefined}>
                <div className="flex items-center gap-2">
                  <input className={inputCls} inputMode="decimal" value={d.bidAmount ?? ''} onChange={(e) => set('bidAmount', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
                  <span className="text-xs font-bold text-muted">{cur}</span>
                </div>
              </Field>
            )}
            {d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && (
              <Field label="Target ROAS">
                <div className="flex items-center gap-2">
                  <input className={inputCls} inputMode="decimal" placeholder="e.g. 3.0" value={d.roasFloor ?? ''} onChange={(e) => set('roasFloor', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
                  <span className="text-xs font-bold text-muted">×</span>
                </div>
                {b?.breakEvenMetaRoas != null && (
                  <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
                    <div className="flex items-center gap-1.5 font-bold"><Sparkles size={13} /> CodesApp insight</div>
                    <p className="mt-1 leading-relaxed">You break even at <b>{ratio(b.breakEvenRoas)}</b> on delivered orders. Counting placed orders like Google does, that is about <b>{ratio(b.breakEvenMetaRoas)}</b>.</p>
                    <button type="button" className="mt-1.5 font-bold underline" onClick={() => set('roasFloor', Math.round(b.breakEvenMetaRoas! * 1.1 * 100) / 100)}>Use {ratio(b.breakEvenMetaRoas * 1.1)} (break-even + 10%)</button>
                  </div>
                )}
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start" hint="Optional — it stays paused until you turn it on anyway."><input type="date" className={inputCls} value={d.startTime?.slice(0, 10) ?? ''} onChange={(e) => set('startTime', e.target.value ? `${e.target.value}T00:00:00Z` : null)} /></Field>
              <Field label="End" hint="Optional."><input type="date" className={inputCls} value={d.endTime?.slice(0, 10) ?? ''} onChange={(e) => set('endTime', e.target.value ? `${e.target.value}T23:59:00Z` : null)} /></Field>
            </div>
          </Card>

          <Card title="Locations & languages">
            <Field label="Countries">
              <div className="flex flex-wrap gap-2">
                {COUNTRIES.map(([c, l]) => {
                  const on = d.countries.includes(c);
                  return (
                    <button key={c} type="button" aria-pressed={on} onClick={() => set('countries', on ? d.countries.filter((x) => x !== c) : [...d.countries, c])}
                      className={cn('rounded-full border px-3 py-1.5 text-xs font-bold', on ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'border-line text-ink')}>{l}</button>
                  );
                })}
              </div>
            </Field>
            <Field label="Exclude cities" hint="High-return cities from your own delivery data are suggested first.">
              {(assets?.riskyCities ?? []).filter((c) => !d.excludeCities.some((x) => x.key === c.key)).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {(assets?.riskyCities ?? []).filter((c) => !d.excludeCities.some((x) => x.key === c.key)).map((c) => (
                    <button key={c.key} type="button" onClick={() => set('excludeCities', [...d.excludeCities, { key: c.key, name: c.name }])}
                      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                      <MapPinOff size={12} /> {c.name} · {Math.round(c.rate * 100)}% return
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {d.excludeCities.map((c) => (
                  <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    {c.name}<button type="button" aria-label={`Remove ${c.name}`} onClick={() => set('excludeCities', d.excludeCities.filter((x) => x.key !== c.key))}><X size={12} /></button>
                  </span>
                ))}
              </div>
              <input className={cn(inputCls, 'mt-2')} placeholder="Search a city to exclude" value={cityQ} onChange={(e) => setCityQ(e.target.value)} />
              {cityHits.length > 0 && (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line">
                  {cityHits.map((h) => (
                    <li key={h.key}>
                      <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-sunken" onClick={() => { set('excludeCities', [...d.excludeCities, { key: h.key, name: h.name }]); setCityQ(''); }}>
                        {h.name} <span className="text-xs text-muted">{h.region}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field label="Languages">
              <div className="flex flex-wrap gap-2">
                {LANGS.map(([c, l]) => {
                  const on = d.languages.includes(c);
                  return (
                    <button key={c} type="button" aria-pressed={on} onClick={() => set('languages', on ? d.languages.filter((x) => x !== c) : [...d.languages, c])}
                      className={cn('rounded-full border px-3 py-1.5 text-xs font-bold', on ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'border-line text-ink')}>{l}</button>
                  );
                })}
              </div>
            </Field>
          </Card>

          <Card title={d.type === 'search' ? 'Ad + keywords' : d.type === 'pmax' ? 'Asset group' : 'Video ad'}>
            <Field label="Final URL" hint="UTMs and Google auto-tagging are added so orders attribute to this campaign from day one.">
              <input className={inputCls} placeholder="https://yourstore.com/collections/…" value={d.url} onChange={(e) => set('url', e.target.value)} />
            </Field>
            {d.type !== 'search' && (
              <Field label="Business name"><input className={inputCls} maxLength={25} value={d.businessName ?? ''} onChange={(e) => set('businessName', e.target.value)} /></Field>
            )}
            {listEditor('headlines', 'Headlines', 30, d.type === 'video' ? 5 : 15)}
            {d.type !== 'search' && listEditor('longHeadlines', 'Long headlines', 90, 5)}
            {listEditor('descriptions', 'Descriptions', 90, d.type === 'search' ? 4 : 5)}
            {d.type === 'search' && (
              <Field label="Keywords" hint="Phrase match is a good start. Add one per line or press Enter.">
                <div className="mb-2 flex flex-wrap gap-2">
                  {(d.keywords ?? []).map((k, i) => (
                    <span key={`${k.text}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold text-ink">
                      {k.match === 'EXACT' ? `[${k.text}]` : k.match === 'PHRASE' ? `"${k.text}"` : k.text}
                      <button type="button" aria-label={`Remove ${k.text}`} onClick={() => set('keywords', (d.keywords ?? []).filter((_, j) => j !== i))}><X size={12} /></button>
                    </span>
                  ))}
                </div>
                <input className={inputCls} placeholder="e.g. lawn suits online" value={kw} onChange={(e) => setKw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !kw.trim()) return;
                    e.preventDefault();
                    set('keywords', [...(d.keywords ?? []), { text: kw.trim(), match: 'PHRASE' }]);
                    setKw('');
                  }} />
              </Field>
            )}
            {d.type === 'pmax' && (
              <div className="grid gap-4 sm:grid-cols-3">
                {imageSlot('landscapeImages', 'Landscape (1.91:1)', 'h-16 w-[122px]')}
                {imageSlot('squareImages', 'Square', 'h-16 w-16')}
                {imageSlot('logoImages', 'Logo (square)', 'h-16 w-16')}
              </div>
            )}
            {d.type === 'video' && imageSlot('logoImages', 'Logo (square)', 'h-16 w-16')}
            {d.type !== 'search' && (
              <Field label={d.type === 'video' ? 'YouTube video' : 'YouTube video (optional)'} hint={ytVideos.length ? 'Videos from your connected channel.' : 'Connect a YouTube channel (Connections) to pick or upload videos.'}>
                <div className="flex flex-wrap gap-2">
                  {ytVideos.slice(0, 12).map((v) => {
                    const on = (d.youtubeVideoIds ?? []).includes(v.id);
                    return (
                      <button key={v.id} type="button" aria-pressed={on} title={v.title ?? v.id}
                        onClick={() => set('youtubeVideoIds', on ? (d.youtubeVideoIds ?? []).filter((x) => x !== v.id) : [...(d.youtubeVideoIds ?? []), v.id])}
                        className={cn('relative h-14 w-24 overflow-hidden rounded-lg border-2', on ? 'border-violet-500' : 'border-transparent')}>
                        {v.thumb
                          // eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail
                          ? <img src={v.thumb} alt="" className="h-full w-full object-cover" />
                          : <span className="grid h-full w-full place-items-center bg-sunken text-xs text-muted">{v.id}</span>}
                        {on && <span className="absolute right-1 top-1 rounded-full bg-violet-600 p-0.5 text-white"><Check size={10} /></span>}
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => pickFile('video')} disabled={!!uploading || !assets}
                    className="grid h-14 w-24 place-items-center rounded-lg border border-dashed border-line text-xs font-semibold text-muted hover:bg-sunken">
                    {uploading === 'video' ? <Loader2 size={16} className="animate-spin" /> : <span className="inline-flex items-center gap-1"><Upload size={13} /> Upload</span>}
                  </button>
                </div>
              </Field>
            )}
          </Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Preview</div>
            {d.type === 'search' ? (
              <div className="mt-3 rounded-xl border border-line p-3 text-sm">
                <div className="text-xs text-muted">Sponsored · {safeHost(d.url)}</div>
                <div className="mt-1 font-semibold text-[#1a0dab] dark:text-blue-300">{clean(d.headlines).slice(0, 3).join(' | ') || 'Your headline | Second headline'}</div>
                <div className="mt-1 text-xs text-ink">{clean(d.descriptions)[0] || 'Your description shows here.'}</div>
              </div>
            ) : (
              <div className="mt-3 overflow-hidden rounded-xl border border-line">
                <div className="relative aspect-video bg-[#0E1A2B]">
                  {firstVideo
                    // eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail
                    ? <img src={`https://i.ytimg.com/vi/${firstVideo}/hqdefault.jpg`} alt="" className="h-full w-full object-cover" />
                    : (d.landscapeImages?.[0] && previews[d.landscapeImages[0]]
                      // eslint-disable-next-line @next/next/no-img-element -- local blob preview
                      ? <img src={previews[d.landscapeImages[0]]} alt="" className="h-full w-full object-cover" />
                      : <span className="grid h-full w-full place-items-center text-xs text-white/70">Video or image</span>)}
                </div>
                <div className="p-3 text-sm">
                  <div className="font-semibold text-ink">{clean(d.headlines)[0] || 'Your headline'}</div>
                  <div className="text-xs text-muted">Sponsored · {d.businessName || safeHost(d.url)}</div>
                </div>
              </div>
            )}
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
            {b?.platformCpa != null && d.budget > 0 && (
              <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                At ~{fmt(b.platformCpa)} per conversion, {fmt(d.budget)} a day buys about <b className="text-ink">{Math.max(0, Math.round((d.budget * 7) / b.platformCpa))}</b> conversions a week.
                Google needs ~2 weeks of steady budget to learn.
              </p>
            )}
            <button type="button" disabled={!ready || creating || !accountId} onClick={() => void create()}
              className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">
              {creating && <Loader2 size={15} className="animate-spin" />} Create paused campaign
            </button>
            <p className="mt-2 text-xs text-muted">Nothing spends until you turn it on from Campaigns.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host || 'yourstore.com';
  } catch {
    return 'yourstore.com';
  }
}
