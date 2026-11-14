'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, Circle, Globe, ImagePlus, Loader2, MapPinOff, MessageCircle, Sparkles, Upload, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money, ratio } from '@/lib/format-number';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { useGrowth } from '@/components/growth/growth-filters';
import { growthApi } from '@/lib/growth';
import {
  BID_HINT, BID_LABEL, EVENT_LABEL, GOAL_LABEL, growthManageApi, WINDOW_LABEL,
  type AttributionWindow, type BidStrategy, type CreateAssets, type CreateDraft, type OptimizationGoal,
} from '@/lib/growth-manage';

type Section = 'campaign' | 'adset' | 'ad';

const CTAS = ['Shop now', 'Order now', 'Learn more', 'Sign up', 'Get offer', 'Contact us'];
const LEARNING_TARGET = 50;

const EMPTY: CreateDraft = {
  name: '',
  objective: 'OUTCOME_SALES',
  cbo: true,
  budgetType: 'daily',
  budget: 0,
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
  bidAmount: null,
  roasFloor: null,
  conversionLocation: 'website',
  optimizationGoal: 'OFFSITE_CONVERSIONS',
  conversionEvent: 'PURCHASE',
  attributionWindow: '7d_click_1d_view',
  pixelId: null,
  countries: ['PK'],
  excludeCities: [],
  ageMin: 18,
  ageMax: 65,
  genders: [],
  advantageAudience: true,
  advantagePlacements: true,
  startTime: null,
  endTime: null,
  pageId: '',
  instagramId: null,
  whatsappNumber: null,
  primaryText: '',
  headline: '',
  cta: 'Shop now',
  url: '',
  imageHash: null,
  videoId: null,
};

const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900';

function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

function Segmented<T extends string | boolean>({ value, options, onChange }: { value: T; options: Array<[T, React.ReactNode]>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-sunken/60 p-0.5">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition', value === v ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <h3 className="text-sm font-extrabold text-ink">{title}</h3>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export default function NewCampaignPage() {
  const router = useRouter();
  const toast = useToast();
  const { mode } = useGrowth();
  const [accounts, setAccounts] = useState<Array<{ id: number; name: string | null }>>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [assets, setAssets] = useState<CreateAssets | null>(null);
  const [assetsErr, setAssetsErr] = useState<string | null>(null);
  const [d, setD] = useState<CreateDraft>(EMPTY);
  const [section, setSection] = useState<Section>('campaign');
  const [media, setMedia] = useState<{ url: string; kind: 'image' | 'video'; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [review, setReview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [placement, setPlacement] = useState<'feed' | 'story'>('feed');
  const [cityQ, setCityQ] = useState('');
  const [cityHits, setCityHits] = useState<Array<{ key: string; name: string; region: string }>>([]);
  const hydrated = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = useCallback(<K extends keyof CreateDraft>(k: K, v: CreateDraft[K]) => setD((x) => ({ ...x, [k]: v })), []);

  // Accounts we can manage + the saved draft.
  useEffect(() => {
    Promise.all([growthApi.accounts(), growthManageApi.access(), growthManageApi.getDraft().catch(() => null)])
      .then(([a, acc, draft]) => {
        const ok = new Set(acc.filter((x) => x.canManage).map((x) => x.accountId));
        const list = a.accounts.filter((x) => ok.has(x.id)).map((x) => ({ id: x.id, name: x.name ?? x.externalId }));
        setAccounts(list);
        const fromDraft = draft?.payload?.accountId;
        setAccountId(fromDraft && ok.has(fromDraft) ? fromDraft : list[0]?.id ?? null);
        if (draft?.payload?.draft) setD({ ...EMPTY, ...draft.payload.draft });
        hydrated.current = true;
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setAssets(null);
    setAssetsErr(null);
    growthManageApi
      .assets(accountId)
      .then((a) => {
        setAssets(a);
        setD((x) => {
          const pageId = x.pageId && a.pages.some((p) => p.id === x.pageId) ? x.pageId : a.pages[0]?.id || '';
          return {
          ...x,
          pageId,
          instagramId: x.instagramId && a.instagram.some((i) => i.id === x.instagramId) ? x.instagramId : a.pages.find((p) => p.id === pageId)?.instagramId ?? null,
          pixelId: x.pixelId || a.pixels[0]?.id || null,
          whatsappNumber: x.whatsappNumber || a.whatsappNumbers[0]?.number || null,
          };
        });
      })
      .catch((e) => setAssetsErr(e instanceof ApiError ? e.userMessage : 'Could not load the ad account’s pages and pixels.'));
  }, [accountId]);

  // Autosave (1.5 s debounce).
  useEffect(() => {
    if (!hydrated.current) return;
    setSaved('saving');
    const t = setTimeout(() => {
      growthManageApi.saveDraft({ accountId, draft: d }).then(() => setSaved('saved')).catch(() => setSaved('idle'));
    }, 1500);
    return () => clearTimeout(t);
  }, [d, accountId]);

  // City search for exclusions.
  useEffect(() => {
    if (!accountId || cityQ.trim().length < 2) {
      setCityHits([]);
      return;
    }
    const t = setTimeout(() => {
      growthManageApi.cities(accountId, cityQ, d.countries[0] ?? 'PK').then(setCityHits).catch(() => setCityHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [cityQ, accountId, d.countries]);

  const cur = assets?.account.currency ?? null;
  const fmt = (v: number | null | undefined) => money(v ?? null, cur, mode);
  const b = assets?.benchmarks;
  const wa = d.conversionLocation === 'whatsapp';

  // When the location changes, keep the goal coherent.
  const setLocation = (loc: 'website' | 'whatsapp') =>
    setD((x) => ({
      ...x,
      conversionLocation: loc,
      optimizationGoal: loc === 'whatsapp' ? 'CONVERSATIONS' : x.optimizationGoal === 'CONVERSATIONS' ? 'OFFSITE_CONVERSIONS' : x.optimizationGoal,
      objective: loc === 'whatsapp' ? 'OUTCOME_ENGAGEMENT' : 'OUTCOME_SALES',
      bidStrategy: loc === 'whatsapp' && x.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'LOWEST_COST_WITHOUT_CAP' : x.bidStrategy,
    }));

  // ── Estimates (from the account's own last 30 days) ───────────────────────
  const est = useMemo(() => {
    const days = d.budgetType === 'lifetime' && d.startTime && d.endTime
      ? Math.max(1, (Date.parse(d.endTime) - Date.parse(d.startTime)) / 86_400_000)
      : d.budgetType === 'lifetime' ? 30 : 1;
    const daily = d.budget > 0 ? d.budget / days : 0;
    const unit = wa ? b?.costPerConversation ?? null : d.optimizationGoal === 'LANDING_PAGE_VIEWS' || d.optimizationGoal === 'LINK_CLICKS' ? b?.costPerLinkClick ?? null : b?.platformCpa ?? null;
    // A cost goal below the real cost slows delivery; never estimate better than the history.
    const effUnit = unit && d.bidStrategy === 'COST_CAP' && d.bidAmount ? Math.max(unit, d.bidAmount) : unit;
    const perDay = effUnit && daily ? daily / effUnit : null;
    const weekly = perDay != null ? perDay * 7 : null;
    const needBudget = effUnit ? (LEARNING_TARGET / 7) * effUnit : null;
    const excludedSave = (assets?.riskyCities ?? []).filter((c) => d.excludeCities.some((x) => x.key === c.key)).reduce((a, c) => a + c.lostMonthly, 0);
    return { daily, unit, perDay, weekly, needBudget, excludedSave };
  }, [d, b, wa, assets]);

  // ── Readiness checklist ───────────────────────────────────────────────────
  const checks: Array<{ section: Section; label: string; ok: boolean }> = [
    { section: 'campaign', label: 'Campaign name', ok: !!d.name.trim() },
    { section: 'campaign', label: 'Budget', ok: d.budget > 0 && (d.budgetType === 'daily' || !!d.endTime) },
    { section: 'campaign', label: 'Bid strategy', ok: d.bidStrategy === 'LOWEST_COST_WITHOUT_CAP' || (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? Number(d.roasFloor) > 0 && d.optimizationGoal === 'VALUE' : Number(d.bidAmount) > 0) },
    { section: 'adset', label: wa ? 'WhatsApp number' : 'Pixel & event', ok: wa ? !!d.whatsappNumber : !!d.pixelId || d.optimizationGoal === 'LANDING_PAGE_VIEWS' || d.optimizationGoal === 'LINK_CLICKS' },
    { section: 'adset', label: 'Audience', ok: d.countries.length > 0 && d.ageMin <= d.ageMax },
    { section: 'ad', label: 'Facebook Page', ok: !!d.pageId },
    { section: 'ad', label: 'Image or video', ok: !!(d.imageHash || d.videoId) },
    { section: 'ad', label: 'Primary text', ok: !!d.primaryText.trim() },
    { section: 'ad', label: wa ? 'Chat destination' : 'Website URL', ok: wa || !!d.url?.trim() },
  ];
  const ready = checks.every((c) => c.ok);

  const upload = async (f: File) => {
    if (!accountId) return;
    const kind = f.type.startsWith('video/') ? 'video' : 'image';
    setMedia({ url: URL.createObjectURL(f), kind, name: f.name });
    setUploading(true);
    try {
      const r = await growthManageApi.media(accountId, f);
      setD((x) => ({ ...x, imageHash: r.imageHash ?? null, videoId: r.videoId ?? null }));
      toast.success(kind === 'video' ? 'Video uploaded to Meta' : 'Image uploaded to Meta');
    } catch (e) {
      setMedia(null);
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const create = async () => {
    if (!accountId) return;
    setCreating(true);
    try {
      const r = await growthManageApi.create(accountId, d);
      await growthManageApi.saveDraft(null).catch(() => undefined);
      toast.success('Campaign created (paused). Turn it on from Campaigns when ready.');
      router.push(`/growth/campaigns?created=${r.campaignId ?? ''}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Creating the campaign failed.');
    } finally {
      setCreating(false);
    }
  };

  if (!accounts.length && hydrated.current) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-extrabold text-ink">No ad account can create ads yet</h2>
        <p className="mt-2 text-sm text-muted">The connected token needs the <b className="text-ink">ads_management</b> permission, with the Page and Instagram account assigned to the system user.</p>
        <Link href="/growth/connections" className="mt-4 inline-flex rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface">Open Connections</Link>
      </div>
    );
  }

  const page = assets?.pages.find((p) => p.id === d.pageId);
  const strategies: BidStrategy[] = wa
    ? ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP']
    : ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS', 'LOWEST_COST_WITH_BID_CAP'];
  const goals: OptimizationGoal[] = wa ? ['CONVERSATIONS'] : ['OFFSITE_CONVERSIONS', 'VALUE', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS'];

  const budgetBlock = (
    <>
      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <Field label="Budget type">
          <Segmented value={d.budgetType} onChange={(v) => set('budgetType', v)} options={[['daily', 'Daily'], ['lifetime', 'Lifetime']]} />
        </Field>
        <Field label={d.budgetType === 'daily' ? 'Daily budget' : 'Lifetime budget'}
          hint={b?.dailySpend ? <>This account spent about <b className="text-ink">{fmt(b.dailySpend)}</b> a day over the last 30 days.</> : undefined}>
          <div className="flex items-center gap-2">
            <input className={inputCls} inputMode="decimal" value={d.budget || ''} placeholder="0" onChange={(e) => set('budget', Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} />
            <span className="text-xs font-bold text-muted">{cur}</span>
          </div>
        </Field>
      </div>
      <Field label="Bid strategy">
        <div className="grid gap-2 sm:grid-cols-2">
          {strategies.map((s) => (
            <button key={s} type="button" onClick={() => set('bidStrategy', s)} aria-pressed={d.bidStrategy === s}
              className={cn('rounded-xl border p-3 text-left transition', d.bidStrategy === s ? 'border-violet-400 bg-violet-50/70 ring-1 ring-violet-300 dark:border-violet-600 dark:bg-violet-950/30 dark:ring-violet-700' : 'border-line hover:bg-sunken')}>
              <div className="text-sm font-bold text-ink">{BID_LABEL[s]}</div>
              <div className="mt-0.5 text-xs leading-snug text-muted">{BID_HINT[s]}</div>
            </button>
          ))}
        </div>
      </Field>
      {(d.bidStrategy === 'COST_CAP' || d.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && (
        <Field label={d.bidStrategy === 'COST_CAP' ? 'Cost per result goal' : 'Bid cap'}
          hint={est.unit ? <>Recent cost per {wa ? 'conversation' : 'purchase'} in Meta: <b className="text-ink">{fmt(est.unit)}</b>.{d.bidAmount && d.bidAmount < est.unit * 0.8 ? <span className="font-semibold text-amber-700 dark:text-amber-300"> This low a goal usually means “learning limited”. Try ~{fmt(est.unit * 0.95)}.</span> : null}</> : undefined}>
          <div className="flex items-center gap-2">
            <input className={inputCls} inputMode="decimal" value={d.bidAmount ?? ''} onChange={(e) => set('bidAmount', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
            <span className="text-xs font-bold text-muted">{cur}</span>
          </div>
        </Field>
      )}
      {d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && (
        <Field label="ROAS goal">
          <div className="flex items-center gap-2">
            <input className={inputCls} inputMode="decimal" placeholder="e.g. 3.2" value={d.roasFloor ?? ''} onChange={(e) => set('roasFloor', Number(e.target.value.replace(/[^\d.]/g, '')) || null)} />
            <span className="text-xs font-bold text-muted">×</span>
          </div>
          {b?.breakEvenMetaRoas != null && (
            <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
              <div className="flex items-center gap-1.5 font-bold"><Sparkles size={13} /> CodesApp insight</div>
              <p className="mt-1 leading-relaxed">
                You break even at <b>{ratio(b.breakEvenRoas)}</b> on delivered orders. Meta counts placed orders, about {b.placedFactor?.toFixed(2)}× more
                {b.rtoRate != null ? ` (${b.rtoRate.toFixed(0)}% of yours come back)` : ''}, so break-even in Meta’s terms is <b>{ratio(b.breakEvenMetaRoas)}</b>.
              </p>
              <button type="button" className="mt-1.5 font-bold underline" onClick={() => setD((x) => ({ ...x, roasFloor: Math.round(b.breakEvenMetaRoas! * 1.1 * 100) / 100, optimizationGoal: 'VALUE' }))}>
                Use {ratio(b.breakEvenMetaRoas * 1.1)} and optimise for value
              </button>
            </div>
          )}
          {d.optimizationGoal !== 'VALUE' && <p className="mt-1.5 text-xs font-semibold text-red-600">A ROAS goal needs “Maximise value of conversions” (Ad set → Performance goal).</p>}
        </Field>
      )}
    </>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/growth/campaigns" aria-label="Back to campaigns" className="rounded-lg border border-line p-2 text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /></Link>
          <div>
            <h2 className="text-lg font-extrabold text-ink">Create campaign</h2>
            <p className="text-xs text-muted">Everything is created <b className="text-ink">paused</b>. Nothing spends until you turn it on.</p>
          </div>
        </div>
        {accounts.length > 1 && (
          <select aria-label="Ad account" value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      {assetsErr && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{assetsErr}</div>}

      <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_360px]">
        {/* Tree + readiness */}
        <nav aria-label="Builder sections" className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <ol className="space-y-1">
            {([['campaign', 'Campaign', d.name || 'New campaign'], ['adset', 'Ad set', wa ? 'WhatsApp · ' + (d.countries.join(', ') || '—') : 'Website · ' + (d.countries.join(', ') || '—')], ['ad', 'Ad', d.headline || 'New ad']] as Array<[Section, string, string]>).map(([id, l, sub], i) => {
              const done = checks.filter((c) => c.section === id).every((c) => c.ok);
              return (
                <li key={id}>
                  <button type="button" onClick={() => setSection(id)} aria-current={section === id ? 'step' : undefined}
                    className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition', section === id ? 'bg-ink text-surface' : 'hover:bg-sunken')}
                    style={{ marginLeft: i * 10, width: `calc(100% - ${i * 10}px)` }}>
                    <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold', done ? 'bg-emerald-500 text-white' : section === id ? 'bg-white/20' : 'bg-sunken text-muted')}>
                      {done ? <Check size={13} /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold">{l}</span>
                      <span className={cn('block truncate text-xs', section === id ? 'text-surface/70' : 'text-muted')}>{sub}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Ready to create</div>
            <ul className="space-y-1.5">
              {checks.map((c) => (
                <li key={c.label}>
                  <button type="button" onClick={() => setSection(c.section)} className="flex items-center gap-2 text-xs text-ink hover:underline">
                    {c.ok ? <CheckCircle2 size={14} className="text-emerald-600" /> : <Circle size={14} className="text-muted" />} {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* Form */}
        <div className="min-w-0 space-y-4">
          {section === 'campaign' && (
            <>
              <Card title="Campaign" sub="Name, where people convert, and how the budget is split.">
                <Field label="Campaign name">
                  <input className={inputCls} value={d.name} maxLength={400} placeholder="e.g. Winter sale · Website · Nov" onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label="Conversion location" hint={wa ? 'People tap the ad and start a WhatsApp chat with your CodesApp number. Chats land in the inbox with the ad attached.' : 'People go to your store. UTMs are added automatically so orders attribute in Growth.'}>
                  <Segmented value={d.conversionLocation} onChange={setLocation}
                    options={[['website', <><Globe size={13} /> Website</>], ['whatsapp', <><MessageCircle size={13} /> WhatsApp</>]]} />
                </Field>
                <Field label="Budget level" hint={d.cbo ? 'Advantage+ campaign budget: Meta moves the budget to the ad sets that perform best.' : 'Each ad set gets its own fixed budget.'}>
                  <Segmented value={d.cbo} onChange={(v) => set('cbo', v)} options={[[true, 'Campaign budget'], [false, 'Ad set budget']]} />
                </Field>
              </Card>
              {d.cbo && <Card title="Budget & bidding" sub="Set on the campaign (Advantage+ campaign budget).">{budgetBlock}</Card>}
              <div className="flex justify-end"><button type="button" onClick={() => setSection('adset')} className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface">Next: Ad set</button></div>
            </>
          )}

          {section === 'adset' && (
            <>
              <Card title="Performance goal" sub="What Meta optimises delivery for.">
                <Field label="Performance goal">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {goals.map((g) => (
                      <button key={g} type="button" onClick={() => set('optimizationGoal', g)} aria-pressed={d.optimizationGoal === g}
                        className={cn('rounded-xl border p-3 text-left text-sm font-bold transition', d.optimizationGoal === g ? 'border-violet-400 bg-violet-50/70 text-ink ring-1 ring-violet-300 dark:border-violet-600 dark:bg-violet-950/30' : 'border-line text-ink hover:bg-sunken')}>
                        {GOAL_LABEL[g]}
                        <span className="mt-0.5 block text-xs font-normal text-muted">
                          {g === 'OFFSITE_CONVERSIONS' ? 'Most purchases for the budget.' : g === 'VALUE' ? 'Highest-value buyers. Required for a ROAS goal.' : g === 'CONVERSATIONS' ? 'Most people starting a chat.' : g === 'LANDING_PAGE_VIEWS' ? 'People who load the page.' : 'Most clicks. Cheapest, lowest intent.'}
                        </span>
                      </button>
                    ))}
                  </div>
                </Field>
                {!wa && (d.optimizationGoal === 'OFFSITE_CONVERSIONS' || d.optimizationGoal === 'VALUE') && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Pixel">
                      <select className={inputCls} value={d.pixelId ?? ''} onChange={(e) => set('pixelId', e.target.value || null)}>
                        {!assets?.pixels.length && <option value="">No pixel found</option>}
                        {assets?.pixels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Conversion event">
                      <select className={inputCls} value={d.conversionEvent ?? 'PURCHASE'} onChange={(e) => set('conversionEvent', e.target.value)}>
                        {Object.entries(EVENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                {wa && (
                  <Field label="WhatsApp number">
                    <select className={inputCls} value={d.whatsappNumber ?? ''} onChange={(e) => set('whatsappNumber', e.target.value || null)}>
                      {!assets?.whatsappNumbers.length && <option value="">No WhatsApp number connected</option>}
                      {assets?.whatsappNumbers.map((w) => <option key={w.id} value={w.number ?? ''}>{w.number}{w.label ? ` · ${w.label}` : ''}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Attribution setting">
                  <Segmented value={d.attributionWindow} onChange={(v) => set('attributionWindow', v as AttributionWindow)}
                    options={(Object.keys(WINDOW_LABEL) as AttributionWindow[]).map((w) => [w, WINDOW_LABEL[w]])} />
                </Field>
              </Card>

              {!d.cbo && <Card title="Budget & bidding" sub="Set on this ad set.">{budgetBlock}</Card>}

              <Card title="Audience" sub="Advantage+ audience lets Meta look beyond these as a suggestion.">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Country">
                    <input className={inputCls} value={d.countries.join(', ')} onChange={(e) => set('countries', e.target.value.toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{2}$/.test(c)))} placeholder="PK" />
                  </Field>
                  <Field label="Age">
                    <div className="flex items-center gap-2">
                      <input className={inputCls} inputMode="numeric" value={d.ageMin} onChange={(e) => set('ageMin', Math.min(65, Math.max(18, Number(e.target.value) || 18)))} />
                      <span className="text-muted">–</span>
                      <input className={inputCls} inputMode="numeric" value={d.ageMax} onChange={(e) => set('ageMax', Math.min(65, Math.max(18, Number(e.target.value) || 65)))} />
                    </div>
                  </Field>
                  <Field label="Gender">
                    <Segmented value={d.genders.length === 1 ? String(d.genders[0]) : 'all'} onChange={(v) => set('genders', v === 'all' ? [] : [Number(v) as 1 | 2])}
                      options={[['all', 'All'], ['2', 'Women'], ['1', 'Men']]} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={d.advantageAudience} onChange={(e) => set('advantageAudience', e.target.checked)} /> Advantage+ audience</label>
                  <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={d.advantagePlacements} onChange={(e) => set('advantagePlacements', e.target.checked)} /> Advantage+ placements</label>
                </div>
                <Field label="Exclude cities">
                  {(assets?.riskyCities.length ?? 0) > 0 && (
                    <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
                      <div className="flex items-center gap-1.5 font-bold"><Sparkles size={13} /> High-return cities from your delivery history</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {assets!.riskyCities.map((c) => {
                          const on = d.excludeCities.some((x) => x.key === c.key);
                          return (
                            <button key={c.key} type="button" onClick={() => set('excludeCities', on ? d.excludeCities.filter((x) => x.key !== c.key) : [...d.excludeCities, { key: c.key, name: c.name }])}
                              className={cn('rounded-full border px-2.5 py-1 font-semibold', on ? 'border-violet-500 bg-violet-600 text-white' : 'border-violet-300 bg-surface text-violet-800 dark:border-violet-700 dark:text-violet-200')}>
                              {c.name} · {(c.rate * 100).toFixed(0)}% RTO
                            </button>
                          );
                        })}
                      </div>
                      {est.excludedSave > 0 && <p className="mt-2">Excluding these avoids about <b>{fmt(est.excludedSave)}</b> of returned orders a month.</p>}
                    </div>
                  )}
                  <div className="relative">
                    <input className={inputCls} value={cityQ} onChange={(e) => setCityQ(e.target.value)} placeholder="Search a city to exclude…" />
                    {cityHits.length > 0 && (
                      <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-line bg-surface py-1 shadow-xl">
                        {cityHits.map((c) => (
                          <li key={c.key}>
                            <button type="button" className="w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-sunken"
                              onClick={() => {
                                if (!d.excludeCities.some((x) => x.key === c.key)) set('excludeCities', [...d.excludeCities, { key: c.key, name: c.name }]);
                                setCityQ('');
                              }}>
                              {c.name}<span className="ml-1 text-xs text-muted">{c.region}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {d.excludeCities.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {d.excludeCities.map((c) => (
                        <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-sunken py-0.5 pl-2.5 pr-1 text-xs font-semibold text-ink">
                          <MapPinOff size={12} /> {c.name}
                          <button type="button" aria-label={`Remove ${c.name}`} onClick={() => set('excludeCities', d.excludeCities.filter((x) => x.key !== c.key))} className="rounded-full p-0.5 hover:bg-line"><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                </Field>
              </Card>

              <Card title="Schedule">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Start"><input type="date" className={inputCls} value={d.startTime?.slice(0, 10) ?? ''} onChange={(e) => set('startTime', e.target.value ? `${e.target.value}T00:00:00Z` : null)} /></Field>
                  <Field label="End" hint={d.budgetType === 'lifetime' ? 'Required for a lifetime budget.' : 'Optional.'}>
                    <input type="date" className={inputCls} value={d.endTime?.slice(0, 10) ?? ''} onChange={(e) => set('endTime', e.target.value ? `${e.target.value}T23:59:00Z` : null)} />
                  </Field>
                </div>
              </Card>
              <div className="flex justify-between">
                <button type="button" onClick={() => setSection('campaign')} className="rounded-lg px-4 py-2 text-sm font-semibold text-muted hover:text-ink">Back</button>
                <button type="button" onClick={() => setSection('ad')} className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface">Next: Ad</button>
              </div>
            </>
          )}

          {section === 'ad' && (
            <>
              <Card title="Identity">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Facebook Page">
                    <select className={inputCls} value={d.pageId}
                      onChange={(e) => {
                        const pageId = e.target.value;
                        // Follow the Page's linked Instagram account.
                        setD((x) => ({ ...x, pageId, instagramId: assets?.pages.find((p) => p.id === pageId)?.instagramId ?? null }));
                      }}>
                      {!assets?.pages.length && <option value="">No Page assigned to this token</option>}
                      {assets?.pages.map((p) => {
                        const ig = assets.instagram.find((i) => i.id === p.instagramId);
                        return <option key={p.id} value={p.id}>{p.name}{ig ? ` · @${ig.username}` : ''}</option>;
                      })}
                    </select>
                  </Field>
                  <Field label="Instagram account"
                    hint={!assets ? undefined : !assets.instagram.length
                      ? 'No Instagram account is linked to these Pages. Link one in Meta Business Settings → Instagram accounts.'
                      : !d.instagramId ? 'Not set: the ad can still run on Instagram, shown as your Facebook Page.' : undefined}>
                    <select className={inputCls} value={d.instagramId ?? ''} onChange={(e) => set('instagramId', e.target.value || null)}>
                      <option value="">Not set (show as the Facebook Page)</option>
                      {assets?.instagram.map((i) => {
                        const page = assets.pages.find((p) => p.id === i.pageId);
                        return <option key={i.id} value={i.id}>@{i.username}{page ? ` · linked to ${page.name}` : ''}</option>;
                      })}
                    </select>
                  </Field>
                </div>
              </Card>
              <Card title="Media">
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = '';
                  }} />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || !accountId}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) void upload(f);
                  }}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line px-4 py-8 text-sm text-muted transition hover:border-violet-400 hover:bg-violet-50/40 dark:hover:bg-violet-950/20">
                  {uploading ? <Loader2 size={22} className="animate-spin" /> : d.imageHash || d.videoId ? <CheckCircle2 size={22} className="text-emerald-600" /> : <ImagePlus size={22} />}
                  <span className="font-semibold text-ink">{uploading ? 'Uploading to Meta…' : d.imageHash || d.videoId ? `${media?.name ?? 'Media'} uploaded · replace` : 'Drop an image or video, or browse'}</span>
                  <span className="text-xs">JPG/PNG up to 30 MB · MP4/MOV up to 200 MB · 1:1 or 4:5 works everywhere</span>
                </button>
              </Card>
              <Card title="Text">
                <Field label="Primary text" hint={`${d.primaryText.length} characters · the first ~125 show before “See more”.`}>
                  <textarea className={cn(inputCls, 'min-h-[96px]')} value={d.primaryText} onChange={(e) => set('primaryText', e.target.value)} maxLength={2000} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Headline"><input className={inputCls} value={d.headline} onChange={(e) => set('headline', e.target.value)} maxLength={255} /></Field>
                  {!wa && (
                    <Field label="Call to action">
                      <select className={inputCls} value={d.cta} onChange={(e) => set('cta', e.target.value)}>{CTAS.map((c) => <option key={c}>{c}</option>)}</select>
                    </Field>
                  )}
                </div>
                {!wa && (
                  <Field label="Website URL" hint="CodesApp adds utm_source=facebook, utm_campaign={{campaign.name}} and utm_content={{ad.name}} so every order is attributed in Growth.">
                    <input className={inputCls} value={d.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="https://yourstore.com/products/…" />
                  </Field>
                )}
              </Card>
              <div className="flex justify-between">
                <button type="button" onClick={() => setSection('adset')} className="rounded-lg px-4 py-2 text-sm font-semibold text-muted hover:text-ink">Back</button>
              </div>
            </>
          )}
        </div>

        {/* Preview rail */}
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-muted">Preview</span>
              <Segmented value={placement} onChange={setPlacement} options={[['feed', 'Feed'], ['story', 'Story']]} />
            </div>
            {placement === 'feed' ? (
              <div className="overflow-hidden rounded-xl border border-line bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-gray-200 text-xs font-bold dark:bg-gray-700">{(page?.name ?? 'P').slice(0, 1)}</span>
                  <div><div className="text-sm font-bold leading-tight">{page?.name ?? 'Your Page'}</div><div className="text-[11px] text-gray-500">Sponsored</div></div>
                </div>
                <p className="whitespace-pre-line px-3 pb-2 text-[13px] leading-snug">{d.primaryText ? (d.primaryText.length > 125 ? `${d.primaryText.slice(0, 125)}… See more` : d.primaryText) : <span className="text-gray-400">Primary text</span>}</p>
                <div className="aspect-square bg-gray-100 dark:bg-gray-800">
                  {media ? (media.kind === 'video'
                    ? <video src={media.url} className="h-full w-full object-cover" muted loop autoPlay playsInline />
                    // eslint-disable-next-line @next/next/no-img-element
                    : <img src={media.url} alt="" className="h-full w-full object-cover" />)
                    : <div className="grid h-full place-items-center text-gray-400"><Upload size={26} /></div>}
                </div>
                <div className="flex items-center justify-between gap-2 bg-gray-50 px-3 py-2.5 dark:bg-gray-800">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] uppercase text-gray-500">{wa ? 'WhatsApp' : (d.url || 'yourstore.com').replace(/^https?:\/\//, '').split('/')[0]}</div>
                    <div className="truncate text-sm font-bold">{d.headline || 'Headline'}</div>
                  </div>
                  <span className={cn('shrink-0 rounded-md px-3 py-1.5 text-xs font-bold', wa ? 'bg-[#25d366] text-white' : 'bg-gray-200 dark:bg-gray-700')}>{wa ? 'Send message' : d.cta}</span>
                </div>
              </div>
            ) : (
              <div className="relative mx-auto aspect-[9/16] w-[220px] overflow-hidden rounded-2xl bg-gray-900 text-white">
                {media && (media.kind === 'video'
                  ? <video src={media.url} className="absolute inset-0 h-full w-full object-cover" muted loop autoPlay playsInline />
                  // eslint-disable-next-line @next/next/no-img-element
                  : <img src={media.url} alt="" className="absolute inset-0 h-full w-full object-cover" />)}
                <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent p-3 text-xs font-bold">{page?.name ?? 'Your Page'} · Sponsored</div>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                  <p className="line-clamp-3 text-xs">{d.primaryText}</p>
                  <div className="mt-2 rounded-full bg-white py-1.5 text-center text-xs font-bold text-gray-900">{wa ? 'Send message' : d.cta}</div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Estimated results</div>
            {!b ? <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Reading your history…</div> : (
              <>
                <dl className="grid grid-cols-2 gap-3">
                  <div><dt className="text-[11px] text-muted">{wa ? 'Chats / day' : 'Results / day'}</dt><dd className="text-lg font-extrabold tabular-nums text-ink">{est.perDay != null ? est.perDay.toFixed(est.perDay < 10 ? 1 : 0) : '—'}</dd></div>
                  <div><dt className="text-[11px] text-muted">Cost per result</dt><dd className="text-lg font-extrabold tabular-nums text-ink">{fmt(est.unit)}</dd></div>
                  {!wa && <div><dt className="text-[11px] text-muted">Meta ROAS</dt><dd className="text-lg font-extrabold tabular-nums text-ink">{ratio(b.platformRoas)}</dd></div>}
                  {!wa && <div><dt className="text-[11px] text-muted" title="After predicted cancellations and returns">Expected ROAS</dt><dd className={cn('text-lg font-extrabold tabular-nums', b.expRoas != null && b.breakEvenRoas != null && b.expRoas < b.breakEvenRoas ? 'text-red-600' : 'text-emerald-600')}>{ratio(b.expRoas)}</dd></div>}
                </dl>
                <div className="mt-4">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="font-bold text-ink">Learning phase</span>
                    <span className="tabular-nums text-muted">{est.weekly != null ? `${Math.round(est.weekly)} / ${LEARNING_TARGET} a week` : '—'}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken">
                    <div className={cn('h-full rounded-full transition-all', (est.weekly ?? 0) >= LEARNING_TARGET ? 'bg-emerald-500' : (est.weekly ?? 0) >= 25 ? 'bg-amber-500' : 'bg-red-500')}
                      style={{ width: `${Math.min(100, ((est.weekly ?? 0) / LEARNING_TARGET) * 100)}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {est.weekly == null ? 'Enter a budget to estimate.' : est.weekly >= LEARNING_TARGET
                      ? 'Enough conversions for Meta to exit learning in about a week.'
                      : <>Meta needs ~{LEARNING_TARGET} a week to stabilise. {est.needBudget ? <>About <b className="text-ink">{fmt(est.needBudget)}</b>/day gets there{!wa && d.conversionEvent === 'PURCHASE' ? ', or optimise for Add to cart' : ''}.</> : null}</>}
                  </p>
                </div>
                <p className="mt-3 border-t border-line pt-2 text-[11px] text-muted">From this account’s last {b.days} days. Estimates, not a promise.</p>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* Bottom bar */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <span className="text-xs text-muted">{saved === 'saving' ? 'Saving draft…' : saved === 'saved' ? 'Draft saved' : ''}</span>
          <div className="flex items-center gap-2">
            {!ready && <span className="hidden text-xs text-muted sm:inline">{checks.filter((c) => !c.ok).length} item{checks.filter((c) => !c.ok).length === 1 ? '' : 's'} left</span>}
            <button type="button" onClick={() => setReview(true)} disabled={!ready || uploading}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface disabled:opacity-40">Review &amp; create (paused)</button>
          </div>
        </div>
      </div>

      <Modal open={review} onClose={() => setReview(false)} title="Create this campaign?" size="lg"
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <button type="button" onClick={() => setReview(false)} className="rounded-lg px-3 py-2 text-sm font-semibold text-muted hover:text-ink">Keep editing</button>
            <button type="button" onClick={create} disabled={creating} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
              {creating && <Loader2 size={15} className="animate-spin" />} Create paused
            </button>
          </div>
        }>
        <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Campaign</dt><dd className="font-semibold text-ink">{d.name}</dd>
          <dt className="text-muted">Location</dt><dd className="text-ink">{wa ? `WhatsApp · ${d.whatsappNumber}` : 'Website'}</dd>
          <dt className="text-muted">Budget</dt><dd className="text-ink">{fmt(d.budget)} {d.budgetType === 'daily' ? '/ day' : 'total'} · {d.cbo ? 'campaign budget' : 'ad set budget'}</dd>
          <dt className="text-muted">Bidding</dt><dd className="text-ink">{BID_LABEL[d.bidStrategy]}{d.bidAmount ? ` · ${fmt(d.bidAmount)}` : ''}{d.roasFloor ? ` · ${d.roasFloor}×` : ''}</dd>
          <dt className="text-muted">Goal</dt><dd className="text-ink">{GOAL_LABEL[d.optimizationGoal]}{!wa && d.conversionEvent ? ` · ${EVENT_LABEL[d.conversionEvent] ?? d.conversionEvent}` : ''} · {WINDOW_LABEL[d.attributionWindow]}</dd>
          <dt className="text-muted">Audience</dt><dd className="text-ink">{d.countries.join(', ')} · {d.ageMin}–{d.ageMax}{d.excludeCities.length ? ` · excluding ${d.excludeCities.map((c) => c.name).join(', ')}` : ''}</dd>
        </dl>
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2 text-xs text-muted">
          <AlertTriangle size={14} className="mt-px shrink-0" /> The campaign, ad set and ad are all created <b className="text-ink">paused</b>. Turn the campaign on from Campaigns when you’re ready.
        </p>
      </Modal>
    </div>
  );
}
