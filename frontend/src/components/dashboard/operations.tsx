'use client';

import Link from 'next/link';
import { cn, fmtDateTime } from '@/lib/utils';
import { money, count, pct, useNumberMode } from '@/lib/format-number';
import type { ActivityEvent, ManagerData } from '@/lib/dashboard';
import { COURIER_LABEL, fmtDuration } from '@/lib/dashboard';
import type { CourierPerfRow } from '@/lib/couriers';
import type { AgentReportRow } from '@/lib/agents-report';
import type { TodaySummary } from '@/lib/attendance';
import { Avatar, Chip, Delta, Panel, PanelLink } from './kit';
import { EmptyState } from '@/components/ui/empty-state';

// ───────────────────────── Order flow ─────────────────────────

export function OrderFlow({ flow, currency }: { flow: ManagerData['flow']; currency: string | null }) {
  const [mode] = useNumberMode();
  if (!flow) return <Panel title="Order flow" description="Orders placed in the last 30 days and where they ended up"><EmptyState compact title="No orders yet" description="Orders appear here once your store is connected." /></Panel>;
  const steps = [
    { label: 'Placed', value: flow.placed, conv: null as string | null, tone: 'flat' as const, href: '/orders' },
    { label: 'Confirmed', value: flow.confirmed, conv: flow.placed ? `${pct((flow.confirmed / flow.placed) * 100, 0)} confirmed` : null, tone: 'good' as const, href: '/orders/fulfillment?lane=unfulfilled&conf=confirmed' },
    { label: 'Shipped', value: flow.shipped, conv: flow.confirmed ? `${pct((flow.shipped / flow.confirmed) * 100, 0)} shipped` : null, tone: 'good' as const, href: '/orders/fulfillment?lane=in_flight' },
    { label: 'Delivered', value: flow.delivered, conv: flow.shipped ? `${pct((flow.delivered / Math.max(1, flow.delivered + flow.rto)) * 100, 0)} of settled` : null, tone: 'warn' as const, href: '/orders/fulfillment?lane=delivered' },
  ];
  const max = Math.max(1, flow.placed);
  return (
    <Panel title="Order flow" description="Orders placed in the last 30 days and where they ended up" action={<Chip>30 days</Chip>}>
      <div className="grid grid-cols-4 items-end gap-2.5">
        {steps.map((s, i) => (
          <Link key={s.label} href={s.href} className="group flex min-w-0 flex-col gap-2 text-ink">
            <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-muted">{s.label}</span>
            <span className="text-xl font-extrabold tabular-nums sm:text-[22px]">{count(s.value, mode)}</span>
            <span
              aria-hidden="true"
              className={cn('block rounded-xl transition group-hover:brightness-110', i === 3 ? 'bg-gradient-to-b from-emerald-500 to-emerald-500/25' : 'bg-gradient-to-b from-accent to-accent/20')}
              style={{ height: `${Math.max(14, Math.round((s.value / max) * 150))}px` }}
            />
            {s.conv ? <Chip tone={s.tone} className="self-start">{s.conv}</Chip> : <Chip className="self-start">all orders</Chip>}
          </Link>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3.5 text-[13px]">
        <span className="font-bold text-muted">Leaks</span>
        <Chip tone="bad">{count(flow.cancelledBeforeBooking, mode)} cancelled before booking</Chip>
        <Chip tone="bad">
          {count(flow.rto, mode)} returned · {money(flow.rtoValue, currency, mode)}
        </Chip>
        <Chip tone="warn">{count(flow.inTransit, mode)} still in transit</Chip>
      </div>
    </Panel>
  );
}

// ───────────────────────── Live activity ─────────────────────────

const KIND_AV: Record<ActivityEvent['kind'], number> = { agent: 0, order: 1, courier: 2, booking: 3, return: 4 };

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function LiveActivity({ events, loading }: { events: ActivityEvent[] | null; loading: boolean }) {
  return (
    <Panel
      title="Live activity"
      description="What is happening across the business right now"
      action={
        <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-emerald-700 dark:text-emerald-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live
        </span>
      }
    >
      {loading && !events ? (
        <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-sunken" />)}</div>
      ) : !events?.length ? (
        <EmptyState compact title="Quiet for now" description="Confirmations, bookings, deliveries and returns appear here as they happen." />
      ) : (
        <ol className="max-h-[360px] overflow-y-auto pr-1">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex gap-3 border-b border-line py-2.5 last:border-0">
              <Avatar name={e.who} i={KIND_AV[e.kind]} />
              <div className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">
                <strong className="font-extrabold">{e.who}</strong> {e.what}{' '}
                {e.ref && (
                  <Link href={`/orders/${encodeURIComponent(e.ref.replace(/^#/, ''))}`} className="font-bold text-brand-700 hover:underline dark:text-brand-300">
                    {e.ref}
                  </Link>
                )}
              </div>
              <time dateTime={e.at} title={fmtDateTime(e.at)} className="shrink-0 font-mono text-xs text-muted">
                {ago(e.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ───────────────────────── Heatmap ─────────────────────────

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);

export function ChatHeatmap({ heat, convo }: { heat: ManagerData['heat']; convo: ManagerData['conversations'] }) {
  const [mode] = useNumberMode();
  const peak = heat?.peak;
  const frtDelta =
    convo?.firstReplySec != null && convo.firstReplySecPrev
      ? Math.round(((convo.firstReplySecPrev - convo.firstReplySec) / convo.firstReplySecPrev) * 1000) / 10
      : null;
  return (
    <Panel
      title="When customers message"
      description={`Customer messages by hour, last ${heat?.weeks ?? 4} weeks · staff your peaks`}
      action={peak ? <Chip tone="warn">Peak: {DAYS[peak.d]} {hourLabel(peak.h)}</Chip> : undefined}
    >
      {!heat || heat.max === 0 ? (
        <EmptyState compact title="No messages yet" description="Once customers write in, you will see your busiest hours here." />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[520px]" role="table" aria-label="Messages by weekday and hour">
            {heat.grid.map((row, d) => (
              <div key={d} role="row" className="mb-[3px] grid grid-cols-[34px_repeat(24,minmax(0,1fr))] items-center gap-[3px]">
                <span role="rowheader" className="text-[11.5px] font-bold text-muted">{DAYS[d]}</span>
                {row.map((c, h) => (
                  <span
                    key={h}
                    role="cell"
                    title={`${DAYS[d]} ${hourLabel(h)} · ${c.toLocaleString('en-US')} messages`}
                    className="h-[18px] rounded"
                    style={{ background: `rgba(18,183,106,${(0.07 + (c / heat.max) * 0.93).toFixed(2)})` }}
                  />
                ))}
              </div>
            ))}
            <div className="mt-1 grid grid-cols-[34px_repeat(4,minmax(0,1fr))] font-mono text-[11px] text-muted">
              <span />
              <span>12a</span>
              <span>6a</span>
              <span>12p</span>
              <span>6p</span>
            </div>
          </div>
        </div>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3.5 text-[13px] text-muted">
        <span>
          First reply <strong className="text-ink">{fmtDuration(convo?.firstReplySec)}</strong>{' '}
          {frtDelta != null && <Delta value={frtDelta} suffix=" faster" />}
        </span>
        <span>
          Chats <strong className="text-ink">{count(convo?.chats ?? 0, mode)}</strong>
        </span>
        {convo?.aiShare != null && (
          <span>
            Answered by AI <strong className="text-ink">{pct(convo.aiShare, 0)}</strong>
          </span>
        )}
        <span>
          Read <strong className="text-ink">{pct(convo?.readRate, 0)}</strong>
        </span>
      </div>
    </Panel>
  );
}

// ───────────────────────── Team today ─────────────────────────

export function TeamToday({
  attendance,
  agents,
  currency,
  showAttendance,
  loading,
}: {
  loading?: boolean;
  attendance: TodaySummary | null;
  agents: AgentReportRow[] | null;
  currency: string | null;
  showAttendance: boolean;
}) {
  const [mode] = useNumberMode();
  const top = (agents ?? []).filter((a) => a.confirmed + a.ordersCreated > 0).sort((a, b) => b.confirmed + b.ordersCreated - (a.confirmed + a.ordersCreated)).slice(0, 5);
  const maxConf = Math.max(1, ...top.map((a) => a.confirmed));
  return (
    <Panel
      title="Team today"
      description={showAttendance ? "Attendance and who's moving orders" : "Who's moving orders"}
      action={
        showAttendance && attendance ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone="good">{attendance.present} in</Chip>
            {attendance.late > 0 && <Chip tone="warn">{attendance.late} late</Chip>}
            {attendance.absent > 0 && <Chip tone="bad">{attendance.absent} absent</Chip>}
            {attendance.notCheckedIn > 0 && <Chip>{attendance.notCheckedIn} not in</Chip>}
          </div>
        ) : undefined
      }
    >
      {loading ? (
        <div className="space-y-3" aria-busy="true">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-sunken" />)}</div>
      ) : top.length === 0 ? (
        <EmptyState compact title="No order work yet" description="Confirmations and orders made from chat show up here." />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[460px]">
            <div className="grid grid-cols-[22px_32px_minmax(0,1fr)_110px_96px] items-center gap-2.5 border-b border-line pb-2 text-xs font-bold text-muted">
              <span>#</span>
              <span />
              <span>Agent</span>
              <span>Confirmed</span>
              <span className="text-right">Net from chats</span>
            </div>
            {top.map((a, i) => (
              <div key={a.userId} className="grid grid-cols-[22px_32px_minmax(0,1fr)_110px_96px] items-center gap-2.5 border-b border-line py-2.5 text-[13px] tabular-nums last:border-0">
                <span className="font-mono text-muted">{i + 1}</span>
                <Avatar name={a.name} i={i} />
                <div className="min-w-0">
                  <div className="truncate font-extrabold text-ink">{a.name}</div>
                  <div className="text-xs text-muted">{a.ordersCreated} orders made</div>
                </div>
                <div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((a.confirmed / maxConf) * 100)}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-muted">{a.confirmed}</div>
                </div>
                <span className="text-right font-bold text-ink">{money(a.orderValue, currency, mode)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-4">
        <PanelLink href="/orders/agents">Full agent report</PanelLink>
        {showAttendance && <PanelLink href="/team-chat?view=attendance&tab=today">Attendance</PanelLink>}
      </div>
    </Panel>
  );
}

// ───────────────────────── Couriers ─────────────────────────

export function CourierScorecard({ rows }: { rows: CourierPerfRow[] | null }) {
  const list = (rows ?? []).filter((r) => r.total > 0 && r.courierType !== 'manual').sort((a, b) => b.total - a.total).slice(0, 6);
  return (
    <Panel title="Courier scorecard" description="Delivery rate, parcels booked in the last 30 days" action={<PanelLink href="/orders/fulfillment?view=performance">Performance</PanelLink>}>
      {list.length === 0 ? (
        <EmptyState compact title="No parcels yet" description="Book parcels with a courier to compare them here." />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((c) => {
            // API sends a 0–1 fraction.
            const r = (c.deliveryRate ?? 0) * 100;
            return (
              <div key={c.courierType} className="grid grid-cols-[96px_minmax(0,1fr)_56px_92px] items-center gap-3 text-[13px]">
                <span className="truncate font-extrabold text-ink">{c.courier}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-sunken">
                  <div className={cn('h-full rounded-full', r >= 78 ? 'bg-emerald-500' : r >= 70 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${Math.min(100, r)}%` }} />
                </div>
                <span className="text-right text-sm font-extrabold tabular-nums text-ink">{pct(r, 0)}</span>
                <span className="text-right text-muted tabular-nums">{c.total.toLocaleString('en-US')} parcels</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function ReturnHotspots({ hot }: { hot: ManagerData['hotspots'] }) {
  return (
    <Panel
      title="Return hotspots"
      description={hot?.storeRate != null ? `Cities returning well above your store average (${hot.storeRate}%)` : 'Cities returning more than your average'}
      action={<PanelLink href="/settings/couriers">City couriers</PanelLink>}
    >
      {!hot || hot.cities.length === 0 ? (
        <EmptyState compact title="No hotspots" description="No city returns 5 points more than your average on settled parcels." />
      ) : (
        <div className="flex flex-col gap-2.5">
          {hot.cities.map((c) => (
            <div key={c.city} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sunken px-3 py-2.5 text-[13px]">
              <span className="min-w-[90px] font-extrabold text-ink">{c.city}</span>
              <span className="text-muted">{c.parcels.toLocaleString('en-US')} parcels</span>
              <Chip tone="bad">{c.rtoRate}% returned</Chip>
              <span className="text-muted">
                {c.bestCourier ? `${COURIER_LABEL[c.bestCourier.courier] ?? c.bestCourier.courier} delivers ${c.bestCourier.deliveryRate}%` : 'Confirm by call'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
