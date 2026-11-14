'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, GitCompareArrows, MousePointerClick, RefreshCw, Sparkles, Store } from 'lucide-react';
import { useSocket } from '@/context/socket-context';
import { zonedYMDString, cn } from '@/lib/utils';
import { useNumberMode, type NumberMode } from '@/lib/format-number';
import { growthApi, MODEL_LABEL, type CompareMode, type GrowthQuery, type Model } from '@/lib/growth';
import { apiFetch } from '@/lib/api';

export type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'mtd' | 'last_month' | 'last90' | 'qtd' | 'ytd' | 'custom';

export const PRESETS: Array<[Preset, string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['mtd', 'This month'],
  ['last_month', 'Last month'],
  ['last90', 'Last 90 days'],
  ['qtd', 'This quarter'],
  ['ytd', 'This year'],
  ['custom', 'Custom range'],
];

const shift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Tenant-calendar day range for a preset (pure string maths on the tenant's "today"). */
export function presetRange(p: Preset, today = zonedYMDString()): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (x: number) => String(x).padStart(2, '0');
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1) };
    case 'last7':
      return { from: shift(today, -6), to: today };
    case 'last90':
      return { from: shift(today, -89), to: today };
    case 'mtd':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const lm = new Date(Date.UTC(y, m - 2, 1));
      const end = shift(`${today.slice(0, 7)}-01`, -1);
      return { from: lm.toISOString().slice(0, 10), to: end };
    }
    case 'qtd':
      return { from: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, to: today };
    case 'ytd':
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: shift(today, -29), to: today };
  }
}

interface Filters {
  preset: Preset;
  from: string;
  to: string;
  compare: CompareMode;
  model: Model;
  win: number;
  storeId: number | null;
}

interface Ctx {
  filters: Filters;
  query: GrowthQuery;
  set: (patch: Partial<Filters>) => void;
  /** Bumps on every `growth.updated` socket event / manual refresh. */
  version: number;
  refresh: () => void;
  mode: NumberMode;
  setMode: (m: NumberMode) => void;
  askOpen: boolean;
  setAskOpen: (v: boolean) => void;
  lastUpdate: Date | null;
}

const GrowthCtx = createContext<Ctx | null>(null);

export function useGrowth() {
  const c = useContext(GrowthCtx);
  if (!c) throw new Error('useGrowth must be used inside <GrowthProvider>');
  return c;
}

const DEFAULT: Filters = { preset: 'last30', from: '', to: '', compare: 'prev', model: 'last', win: 28, storeId: null };

export function GrowthProvider({ children }: { children: React.ReactNode }) {
  const [filters, setFilters] = useState<Filters>(() => ({ ...DEFAULT, ...presetRange('last30') }));
  const [hydrated, setHydrated] = useState(false);
  const [version, setVersion] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [mode, setMode] = useNumberMode();
  const { on, reconnectSeq } = useSocket();
  const seqRef = useRef(reconnectSeq);

  // Hydrate once from the URL so a shared link reproduces the view.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const preset = (sp.get('period') as Preset) || 'last30';
    const range = preset === 'custom' ? { from: sp.get('from') ?? '', to: sp.get('to') ?? '' } : presetRange(preset);
    const valid = /^\d{4}-\d{2}-\d{2}$/;
    setFilters({
      preset: PRESETS.some(([k]) => k === preset) ? preset : 'last30',
      from: valid.test(range.from) ? range.from : presetRange('last30').from,
      to: valid.test(range.to) ? range.to : presetRange('last30').to,
      compare: (['prev', 'yoy', 'none'] as const).includes(sp.get('compare') as CompareMode) ? (sp.get('compare') as CompareMode) : 'prev',
      model: (Object.keys(MODEL_LABEL) as string[]).includes(sp.get('model') ?? '') && sp.get('model') !== 'platform' ? (sp.get('model') as Model) : 'last',
      win: [1, 7, 28].includes(Number(sp.get('win'))) ? Number(sp.get('win')) : 28,
      storeId: Number(sp.get('store')) || null,
    });
    setHydrated(true);
  }, []);

  // Mirror to the URL without a navigation (keeps tab links + reloads in sync).
  useEffect(() => {
    if (!hydrated) return;
    const sp = new URLSearchParams();
    if (filters.preset !== 'last30') sp.set('period', filters.preset);
    if (filters.preset === 'custom') {
      sp.set('from', filters.from);
      sp.set('to', filters.to);
    }
    if (filters.compare !== 'prev') sp.set('compare', filters.compare);
    if (filters.model !== 'last') sp.set('model', filters.model);
    if (filters.win !== 28) sp.set('win', String(filters.win));
    if (filters.storeId) sp.set('store', String(filters.storeId));
    const q = sp.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, [filters, hydrated]);

  // Live: refetch when the backend reports new spend / orders / a rebuild.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('growth.updated', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        setVersion((v) => v + 1);
        setLastUpdate(new Date());
      }, 1500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [on]);

  useEffect(() => {
    if (reconnectSeq !== seqRef.current) {
      seqRef.current = reconnectSeq;
      setVersion((v) => v + 1);
    }
  }, [reconnectSeq]);

  const set = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (patch.preset && patch.preset !== 'custom') Object.assign(next, presetRange(patch.preset));
      return next;
    });
  }, []);

  const query = useMemo<GrowthQuery>(
    () => ({
      from: filters.from,
      to: filters.to,
      compare: filters.compare,
      model: filters.model,
      win: filters.win,
      ...(filters.storeId ? { storeId: filters.storeId } : {}),
    }),
    [filters],
  );

  // A period that includes today needs Meta's live spend: ask the backend to
  // pull today+yesterday now (rate-limited server-side to once per 5 min).
  // `growth.updated` refetches the page when the rows land.
  const includesToday = filters.to >= zonedYMDString();
  const pullToday = useCallback(() => {
    void growthApi.syncToday().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (hydrated && includesToday) pullToday();
  }, [hydrated, includesToday, pullToday]);

  const refresh = useCallback(() => {
    if (includesToday) pullToday();
    setVersion((v) => v + 1);
    setLastUpdate(new Date());
  }, [includesToday, pullToday]);

  const value = useMemo<Ctx>(
    () => ({ filters, query, set, version, refresh, mode, setMode, askOpen, setAskOpen, lastUpdate }),
    [filters, query, set, version, refresh, mode, setMode, askOpen, lastUpdate],
  );
  return <GrowthCtx.Provider value={value}>{hydrated ? children : null}</GrowthCtx.Provider>;
}

function Ctl({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted shadow-sm">
      <Icon size={14} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      {children}
    </label>
  );
}

const selectCls = 'bg-transparent font-semibold text-ink outline-none cursor-pointer pr-1';

/** Sticky Growth toolbar: period, compare, attribution, window, store, number format, live, Ask. */
export function GrowthControlBar({ showAttribution = true }: { showAttribution?: boolean }) {
  const { filters, set, refresh, mode, setMode, setAskOpen, lastUpdate } = useGrowth();
  const [stores, setStores] = useState<Array<{ id: number; name: string }>>([]);
  const [spin, setSpin] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    apiFetch<Array<{ id: number; label: string }>>('/shopify/stores')
      .then((r) => setStores((Array.isArray(r) ? r : []).map((s) => ({ id: s.id, name: s.label || `Store ${s.id}` }))))
      .catch(() => setStores([]));
    const i = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(i);
  }, []);

  const ago = lastUpdate ? Math.max(0, Math.round((Date.now() - lastUpdate.getTime()) / 1000)) : null;

  return (
    <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 border-b border-line bg-sunken/85 px-4 sm:px-6 py-2.5 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <Ctl icon={CalendarRange} label="Period">
          <select aria-label="Period" className={selectCls} value={filters.preset} onChange={(e) => set({ preset: e.target.value as Preset })}>
            {PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Ctl>
        {filters.preset === 'custom' && (
          <span className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-sm">
            <input aria-label="From" type="date" value={filters.from} max={filters.to} onChange={(e) => e.target.value && set({ from: e.target.value })} className="bg-transparent text-ink outline-none" />
            <span className="text-muted">→</span>
            <input aria-label="To" type="date" value={filters.to} min={filters.from} max={zonedYMDString()} onChange={(e) => e.target.value && set({ to: e.target.value })} className="bg-transparent text-ink outline-none" />
          </span>
        )}
        <Ctl icon={GitCompareArrows} label="Compare">
          <select aria-label="Compare" className={selectCls} value={filters.compare} onChange={(e) => set({ compare: e.target.value as CompareMode })}>
            <option value="prev">Previous period</option>
            <option value="yoy">Same period last year</option>
            <option value="none">Off</option>
          </select>
        </Ctl>
        {showAttribution && (
          <>
            <Ctl icon={MousePointerClick} label="Attribution">
              <select aria-label="Attribution model" className={selectCls} value={filters.model} onChange={(e) => set({ model: e.target.value as Model })}>
                {(['first', 'last', 'lnd', 'linear', 'position', 'decay'] as Model[]).map((m) => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
              </select>
            </Ctl>
            <Ctl icon={MousePointerClick} label="Window">
              <select aria-label="Attribution window" className={selectCls} value={filters.win} onChange={(e) => set({ win: Number(e.target.value) })}>
                <option value={1}>1-day</option>
                <option value={7}>7-day</option>
                <option value={28}>28-day</option>
              </select>
            </Ctl>
          </>
        )}
        {stores.length > 1 && (
          <Ctl icon={Store} label="Store">
            <select aria-label="Store" className={selectCls} value={filters.storeId ?? ''} onChange={(e) => set({ storeId: Number(e.target.value) || null })}>
              <option value="">All stores</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Ctl>
        )}
        <div role="group" aria-label="Number format" className="inline-flex rounded-lg border border-line bg-surface p-0.5 shadow-sm">
          {([['compact', '12.4M'], ['full', '12,412,356'], ['lakh', '1.24 Cr']] as Array<[NumberMode, string]>).map(([m, l]) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
              className={cn('rounded-md px-2 py-1 text-xs font-semibold tabular-nums', mode === m ? 'bg-ink text-surface' : 'text-muted hover:text-ink')}>
              {l}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-60 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" /></span>
            Live{ago != null ? ` · updated ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago` : ''}
          </span>
          <button type="button" aria-label="Refresh" title="Refresh"
            onClick={() => { setSpin(true); refresh(); setTimeout(() => setSpin(false), 800); }}
            className="rounded-lg border border-line bg-surface p-1.5 text-muted shadow-sm hover:text-ink">
            <RefreshCw size={14} className={spin ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={() => setAskOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95">
            <Sparkles size={14} /> Ask Growth
          </button>
        </div>
      </div>
    </div>
  );
}
