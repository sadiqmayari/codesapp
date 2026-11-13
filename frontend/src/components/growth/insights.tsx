'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Database, Rocket, Scissors, Send, Settings2, Sparkles, TrendingDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money } from '@/lib/format-number';
import { growthApi, type Brief, type Catalog, type ChartSpec, type MetricDef, type Opportunity } from '@/lib/growth';
import { Skeleton } from '@/components/ui/skeleton';
import { useGrowth } from './growth-filters';
import { EChart, useChartTheme } from './echart';
import { askChartOption } from './chart-options';
import { useGrowthData } from './ui';

let catalogPromise: Promise<Catalog> | null = null;

/** Metric definitions (served by the backend so every surface agrees). */
export function useCatalog() {
  const [cat, setCat] = useState<Catalog | null>(null);
  useEffect(() => {
    if (!catalogPromise) catalogPromise = growthApi.catalog().catch((e) => { catalogPromise = null; throw e; });
    catalogPromise.then(setCat).catch(() => setCat(null));
  }, []);
  const byId = useMemo(() => new Map<string, MetricDef>((cat?.metrics ?? []).map((m) => [m.id, m])), [cat]);
  return { catalog: cat, def: (id: string) => byId.get(id) };
}

let currencyPromise: Promise<string | null> | null = null;

/** The tenant's reporting (store) currency, cached for the session. */
export function useBaseCurrency() {
  const [cur, setCur] = useState<string | null>(null);
  useEffect(() => {
    if (!currencyPromise) currencyPromise = growthApi.accounts().then((a) => a.baseCurrency).catch(() => { currencyPromise = null; return null; });
    void currencyPromise.then(setCur);
  }, []);
  return cur;
}

const TONE: Record<string, string> = {
  good: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  info: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
};

export function BriefCard() {
  const { data, loading } = useGrowthData<Brief>((q, signal) => growthApi.brief({ ...q, compare: 'prev' }, { signal }));
  return (
    <section className="relative overflow-hidden rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 via-surface to-surface p-4 shadow-sm dark:border-violet-900/60 dark:from-violet-950/40">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow">
          <Sparkles size={17} />
        </div>
        <div className="min-w-0 flex-1">
          {loading && !data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ) : data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-bold text-ink">{data.headline}</h2>
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 dark:bg-violet-900/60 dark:text-violet-200">
                  {data.source === 'ai' ? 'AI brief' : 'Summary'}
                </span>
              </div>
              <p className="mt-1 max-w-[110ch] text-sm leading-relaxed text-ink/90">{data.body}</p>
              {data.actions.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {data.actions.map((a, i) => (
                    <span key={i} className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', TONE[a.tone])}>{a.label}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">The brief is unavailable right now.</p>
          )}
        </div>
      </div>
    </section>
  );
}

const KIND_ICON: Record<Opportunity['kind'], React.ElementType> = {
  scale: Rocket,
  cut: Scissors,
  fatigue: TrendingDown,
  geo: AlertTriangle,
  capi: Send,
  data: Database,
  setup: Settings2,
};
const STRIPE: Record<Opportunity['severity'], string> = {
  good: 'bg-emerald-500',
  bad: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
};

export function OpportunityList({ limit }: { limit?: number }) {
  const { mode } = useGrowth();
  const { data, loading, error } = useGrowthData<Opportunity[]>((q, signal) => growthApi.opportunities(q, { signal }));
  const cur = useBaseCurrency();
  if (loading && !data) return <div className="space-y-3 p-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (error) return <p className="px-1 py-6 text-sm text-muted">{error}</p>;
  const rows = (data ?? []).slice(0, limit ?? 50);
  if (!rows.length) return <p className="px-1 py-6 text-sm text-muted">No opportunities right now. Your campaigns are within healthy ranges.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((o) => {
        const Icon = KIND_ICON[o.kind];
        const href = o.kind === 'setup' || o.kind === 'capi' ? '/growth/connections' : o.kind === 'fatigue' ? '/growth/creatives' : o.kind === 'data' ? '/growth/connections' : '/growth/campaigns';
        return (
          <li key={o.id} className="grid grid-cols-[4px_1fr_auto] items-center gap-3 py-2.5">
            <span className={cn('h-full min-h-[36px] rounded-full', STRIPE[o.severity])} />
            <Link href={href} className="min-w-0 group">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink group-hover:underline">
                <Icon size={14} className="shrink-0 text-muted" />
                <span className="truncate">{o.title}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">{o.detail}</span>
            </Link>
            <span className="text-right">
              <span className="block text-sm font-bold tabular-nums text-ink">{o.impact != null ? `+${money(o.impact, cur, mode)}` : ''}</span>
              <span className="block text-[11px] text-muted">{o.impactLabel}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  chart?: ChartSpec | null;
}

const SUGGESTIONS = [
  'Which campaign should I scale this week?',
  'Why did ROAS change compared to last period?',
  'Compare first-click and last-click for my top campaigns',
  'What is my break-even ROAS and am I above it?',
  'Which cities have the highest return rate?',
];

export function AskPanel() {
  const { askOpen, setAskOpen, query, mode } = useGrowth();
  const theme = useChartTheme();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!askOpen) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAskOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askOpen, setAskOpen]);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setInput('');
    const history = turns.map((t) => ({ role: t.role, text: t.text }));
    setTurns((t) => [...t, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const r = await growthApi.ask(query, question, history);
      setTurns((t) => [...t, { role: 'assistant', text: r.answer, chart: r.chart }]);
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.status === 403 ? 'AI is turned off for this workspace (Settings → AI), or this month’s AI limit was reached.' : e.userMessage
        : 'Something went wrong. Try again.';
      setTurns((t) => [...t, { role: 'assistant', text: msg }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {askOpen && <div className="fixed inset-0 z-40 bg-black/20 md:bg-transparent" onClick={() => setAskOpen(false)} aria-hidden />}
      <aside
        aria-label="Ask Growth"
        aria-hidden={!askOpen}
        className={cn(
          'fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl transition-transform duration-200 motion-reduce:transition-none',
          askOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-violet-600 to-indigo-600 text-white"><Sparkles size={14} /></div>
            <div>
              <div className="text-sm font-bold text-ink">Ask Growth</div>
              <div className="text-[11px] text-muted">Answers from your orders, ads and deliveries · {query.from} → {query.to}</div>
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={() => setAskOpen(false)} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink"><X size={16} /></button>
        </header>
        <div ref={body} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {turns.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted">Ask anything about spend, ROAS, profit, returns or customers. Every number comes from your own data.</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-xs font-medium text-ink hover:border-violet-400">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={cn('max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed', t.role === 'user' ? 'ml-auto bg-ink text-surface' : 'bg-sunken text-ink')}>
              <div className="whitespace-pre-wrap">{t.text}</div>
              {t.chart && theme && (
                <div className="mt-2 rounded-lg bg-surface p-2">
                  {t.chart.title && <div className="mb-1 text-xs font-semibold text-ink">{t.chart.title}</div>}
                  <EChart option={askChartOption(t.chart, theme, mode)} height={170} ariaLabel={t.chart.title} />
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex w-24 items-center gap-1 rounded-2xl bg-sunken px-3.5 py-3">
              {[0, 1, 2].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted motion-reduce:animate-none" style={{ animationDelay: `${d * 120}ms` }} />)}
            </div>
          )}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} className="flex gap-2 border-t border-line px-4 py-3">
          <input ref={inputRef} id="ask-growth-input" value={input} onChange={(e) => setInput(e.target.value)} maxLength={1000}
            placeholder="e.g. Which ads bring customers who actually receive the parcel?"
            className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none focus:border-violet-500" />
          <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-3 text-sm font-semibold text-white disabled:opacity-50">Ask</button>
        </form>
      </aside>
    </>
  );
}
