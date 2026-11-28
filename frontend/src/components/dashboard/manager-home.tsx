'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { zonedMonthRange, zonedPresetRange, zonedTodayRange, zonedYesterdayRange } from '@/lib/utils';
import { fulfillmentLaneCounts, getCourierPerformance, type CourierPerfRow, type LaneCounts } from '@/lib/couriers';
import { getAgentsReport, type AgentReportRow } from '@/lib/agents-report';
import { getTodaySummary, type TodaySummary } from '@/lib/attendance';
import {
  getActivity,
  getLayout,
  getManager,
  getPlanAccess,
  saveLayout,
  type ActivityEvent,
  type ManagerData,
  type PlanAccess,
  type WidgetId,
} from '@/lib/dashboard';
import { Hero, type HeroSales, type TrendPoint } from './hero';
import { buildNeedTiles, HealthKpis, TaskTiles, type PeriodSales } from './needs-kpis';
import { ChatHeatmap, CourierScorecard, LiveActivity, OrderFlow, ReturnHotspots, TeamToday } from './operations';
import { CodesAppNotice, CustomisePanel, PlanAccessPanel } from './plan-access';
import { SetupChecklist, setupSteps } from './setup-checklist';
import { SectionTitle } from './kit';

export type PeriodKey = 'today' | '7d' | '30d' | 'mtd';
export const PERIODS: { key: PeriodKey; label: string; long: string }[] = [
  { key: 'today', label: 'Today', long: 'today' },
  { key: '7d', label: '7D', long: 'last 7 days' },
  { key: '30d', label: '30D', long: 'last 30 days' },
  { key: 'mtd', label: 'Month', long: 'this month' },
];

function rangeFor(p: PeriodKey) {
  if (p === 'today') return zonedTodayRange();
  if (p === '7d') return zonedPresetRange(7);
  if (p === '30d') return zonedPresetRange(30);
  return zonedMonthRange(0);
}

interface Kpi {
  value: number;
  prev: number | null;
}
interface OrdersAnalytics {
  currency: string | null;
  kpis: { gross: Kpi; net: Kpi; orders: Kpi; ordersNet: Kpi };
  trend: TrendPoint[];
}

export function ManagerHome({
  period,
  customizeOpen,
  onCloseCustomize,
}: {
  period: PeriodKey;
  customizeOpen: boolean;
  onCloseCustomize: () => void;
}) {
  const { user } = useAuth();
  const mods = useMemo(() => user?.company?.modules ?? {}, [user?.company?.modules]);
  // null modules (old /auth/me) = treat as granted, like the nav does.
  const has = useCallback((k: string) => (user?.company?.modules ? mods[k] === true : true), [user?.company?.modules, mods]);
  const { on, reconnectSeq } = useSocket();

  const [orders, setOrders] = useState<OrdersAnalytics | null>(null);
  const [yesterday, setYesterday] = useState<TrendPoint[] | null>(null);
  const [mgr, setMgr] = useState<ManagerData | null>(null);
  const [plan, setPlan] = useState<PlanAccess | null>(null);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [lanes, setLanes] = useState<LaneCounts | null>(null);
  const [att, setAtt] = useState<TodaySummary | null>(null);
  const [agents, setAgents] = useState<AgentReportRow[] | null>(null);
  const [couriers, setCouriers] = useState<CourierPerfRow[] | null>(null);
  // Which period each period-dependent payload belongs to. A section whose
  // data is for another period shows a skeleton, never the old figures.
  const [ordersFor, setOrdersFor] = useState<PeriodKey | null>(null);
  const [mgrFor, setMgrFor] = useState<PeriodKey | null>(null);
  const [agentsFor, setAgentsFor] = useState<PeriodKey | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [savingLayout, setSavingLayout] = useState(false);
  const seq = useRef(0);

  const range = useMemo(() => rangeFor(period), [period]);

  const loadPeriod = useCallback(
    async (silent = false) => {
      const id = ++seq.current;
      void silent;
      // Each section fills in as soon as ITS data lands (the 30-day agent report
      // can take ~6 s; the hero shouldn't wait for it). A newer period wins.
      const fresh = () => id === seq.current;
      const mark = (setFor: (p: PeriodKey) => void) => () => {
        if (fresh()) setFor(period);
      };
      const tasks: Promise<unknown>[] = [
        apiFetch<OrdersAnalytics>('/analytics/orders', {
          params: { ...range, compare: 'true', ...(period === 'today' ? { granularity: 'hour' } : {}) },
        })
          .then((o) => fresh() && setOrders(o))
          .catch(() => undefined)
          .finally(mark(setOrdersFor)),
        getManager(range)
          .then((m) => fresh() && setMgr(m))
          .catch(() => undefined)
          .finally(mark(setMgrFor)),
        getAgentsReport(range)
          .then((a) => fresh() && setAgents(a.rows))
          .catch(() => undefined)
          .finally(mark(setAgentsFor)),
      ];
      if (period === 'today') {
        tasks.push(
          apiFetch<OrdersAnalytics>('/analytics/orders', { params: { ...zonedYesterdayRange(), compare: 'false', granularity: 'hour' } })
            .then((y) => fresh() && setYesterday(y.trend))
            .catch(() => undefined),
        );
      } else setYesterday(null);
      await Promise.allSettled(tasks);
    },
    [range, period],
  );

  const loadLive = useCallback(async () => {
    const [p, e, l, t, c] = await Promise.allSettled([
      getPlanAccess(),
      getActivity(),
      fulfillmentLaneCounts(),
      has('attendance') ? getTodaySummary() : Promise.resolve(null),
      has('couriers') ? getCourierPerformance() : Promise.resolve(null),
    ]);
    if (p.status === 'fulfilled') setPlan(p.value);
    if (e.status === 'fulfilled') setEvents(e.value.events);
    if (l.status === 'fulfilled') setLanes(l.value);
    if (t.status === 'fulfilled') setAtt(t.value);
    if (c.status === 'fulfilled') setCouriers(c.value?.couriers ?? null);
  }, [has]);

  useEffect(() => {
    loadPeriod();
  }, [loadPeriod]);

  useEffect(() => {
    loadLive();
    const t = setInterval(() => {
      loadLive();
      loadPeriod(true);
    }, 90_000);
    return () => clearInterval(t);
  }, [loadLive, loadPeriod]);

  // Layout (hidden widgets): mine ?? team default.
  useEffect(() => {
    getLayout()
      .then((r) => setHidden(new Set(r.layout.hidden)))
      .catch(() => undefined);
  }, []);

  // Realtime: coalesce bursts into one silent refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        loadLive();
        loadPeriod(true);
      }, 2000);
    };
    const offs = [on('orders.changed', bump), on('message.received', bump), on('message.read.bulk', bump), on('conversation.updated', bump)];
    return () => {
      offs.forEach((o) => o?.());
      if (timer) clearTimeout(timer);
    };
  }, [on, loadLive, loadPeriod]);

  const seenSeq = useRef(reconnectSeq);
  useEffect(() => {
    if (reconnectSeq === seenSeq.current) return;
    seenSeq.current = reconnectSeq;
    loadLive();
    loadPeriod(true);
  }, [reconnectSeq, loadLive, loadPeriod]);

  const persist = useCallback((next: Set<string>, team = false) => {
    setSavingLayout(true);
    saveLayout({ hidden: Array.from(next) }, team)
      .catch(() => undefined)
      .finally(() => setSavingLayout(false));
  }, []);

  const toggle = (id: WidgetId, show: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (show) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  };

  const show = (id: WidgetId) => !hidden.has(id);
  const ordersStale = ordersFor !== period;
  const mgrStale = mgrFor !== period;
  const agentsStale = agentsFor !== period;
  const loading = ordersStale || mgrStale;
  const periodLong = PERIODS.find((p) => p.key === period)?.long ?? '';
  const k = ordersStale ? undefined : orders?.kpis;
  const heroSales: HeroSales | null = k
    ? { currency: orders!.currency, gross: k.gross.value, net: k.net.value, orders: k.orders.value, kept: k.ordersNet.value, netPrev: k.net.prev }
    : null;
  const periodSales: PeriodSales | null = k
    ? {
        currency: orders!.currency,
        gross: k.gross.value,
        grossPrev: k.gross.prev,
        net: k.net.value,
        netPrev: k.net.prev,
        orders: k.orders.value,
        ordersPrev: k.orders.prev,
        kept: k.ordersNet.value,
        keptPrev: k.ordersNet.prev,
      }
    : null;
  const currency = orders?.currency ?? null;

  const steps = setupSteps(plan);
  const coreOpen = steps.slice(0, 4).filter((s) => !s.done).length;
  const fresh = !!plan && coreOpen >= 3 && (mgr?.flow?.placed ?? 0) === 0;

  if (fresh) return <SetupChecklist plan={plan} full />;

  return (
    <div className="flex flex-col gap-5">
      {customizeOpen && (
        <CustomisePanel
          hidden={hidden}
          onToggle={toggle}
          onClose={onCloseCustomize}
          canTeam={user?.role === 'owner' || user?.role === 'admin'}
          saving={savingLayout}
          onSaveTeam={() => persist(hidden, true)}
          onReset={() => {
            setSavingLayout(true);
            saveLayout(null)
              .then((r) => setHidden(new Set(r.layout.hidden)))
              .catch(() => undefined)
              .finally(() => setSavingLayout(false));
          }}
        />
      )}

      {show('notice') && <CodesAppNotice plan={plan} />}

      {plan && coreOpen > 0 && <SetupChecklist plan={plan} full={false} />}

      {show('hero') && (
        <Hero
          periodKey={period}
          periodLabel={periodLong}
          sales={heroSales}
          trend={ordersStale ? [] : orders?.trend ?? []}
          yesterday={yesterday}
          target={mgr?.target ?? null}
          brief={mgrStale ? [] : mgr?.brief ?? []}
          loading={loading}
        />
      )}

      {show('needs') && (
        <section aria-labelledby="dash-needs">
          <SectionTitle id="dash-needs" title="Needs you now" aside={<span className="text-[13px] text-muted">Live · clears as your team works</span>} />
          <TaskTiles tiles={buildNeedTiles(mgr, lanes, { couriers: has('couriers'), tickets: has('tickets') })} loading={!mgr || !lanes} />
        </section>
      )}

      {show('kpis') && <HealthKpis m={mgr} s={periodSales} periodLabel={periodLong} loading={ordersStale || mgrStale} />}

      {(show('flow') || show('feed')) && (
        <div className="grid gap-4 xl:grid-cols-2">
          {show('flow') && <OrderFlow flow={mgr?.flow ?? null} currency={currency} />}
          {show('feed') && <LiveActivity events={events} loading={!events} />}
        </div>
      )}

      {(show('heat') || show('team')) && (
        <div className="grid gap-4 xl:grid-cols-2">
          {show('heat') && <ChatHeatmap heat={mgr?.heat ?? null} convo={mgr?.conversations ?? null} />}
          {show('team') && <TeamToday attendance={att} agents={agentsStale ? null : agents} loading={agentsStale} currency={currency} showAttendance={has('attendance')} />}
        </div>
      )}

      {show('couriers') && has('couriers') && (
        <div className="grid gap-4 xl:grid-cols-2">
          <CourierScorecard rows={couriers} />
          <ReturnHotspots hot={mgr?.hotspots ?? null} />
        </div>
      )}

      {show('plan') && <PlanAccessPanel plan={plan} />}
    </div>
  );
}
