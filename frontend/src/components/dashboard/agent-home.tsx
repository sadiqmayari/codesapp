'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageSquareText, Zap } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { fullMoney } from '@/lib/format-number';
import { getMe, fmtDuration, fmtWait, type MeData } from '@/lib/dashboard';
import { getMyToday, fmtClock, type MyToday } from '@/lib/attendance';
import { getMyEarnings, type MyEarnings } from '@/lib/commissions';
import { getLeaderboard, type LeaderboardRow } from '@/lib/gamification';
import { zonedMonthRange } from '@/lib/utils';
import { Avatar, Chip, Panel, PanelLink, Ring, SkeletonBlock, type Tone } from './kit';
import { TaskTiles, type NeedTile } from './needs-kpis';
import { EmptyState } from '@/components/ui/empty-state';

function cmpTone(v: number, avg: number | null | undefined): Tone {
  if (avg == null) return 'flat';
  return v > avg ? 'good' : v < avg * 0.8 ? 'warn' : 'flat';
}

/** The agent's own cockpit: who to answer next, their queue, their day and month. */
export function AgentHome() {
  const { user } = useAuth();
  const mods = user?.company?.modules ?? null;
  const has = (k: string) => (mods ? mods[k] === true : false);
  const { on, reconnectSeq } = useSocket();
  const [me, setMe] = useState<MeData | null>(null);
  const [att, setAtt] = useState<MyToday | null>(null);
  const [earn, setEarn] = useState<MyEarnings | null>(null);
  const [rank, setRank] = useState<{ row: LeaderboardRow; of: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    const [m] = await Promise.allSettled([getMe()]);
    if (id !== seq.current) return;
    if (m.status === 'fulfilled') setMe(m.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const seenSeq = useRef(reconnectSeq);
  useEffect(() => {
    if (reconnectSeq === seenSeq.current) return;
    seenSeq.current = reconnectSeq;
    load();
  }, [reconnectSeq, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    const offs = [on('message.received', bump), on('message.read.bulk', bump), on('conversation.updated', bump)];
    return () => {
      offs.forEach((o) => o?.());
      if (timer) clearTimeout(timer);
    };
  }, [on, load]);

  // Optional, module-gated extras: each fails silently.
  useEffect(() => {
    if (has('attendance')) getMyToday().then(setAtt).catch(() => undefined);
    if (has('commissions')) getMyEarnings().then(setEarn).catch(() => undefined);
    if (has('leaderboard') && user) {
      getLeaderboard(zonedMonthRange(0))
        .then((r) => {
          const row = r.rows.find((x) => x.userId === user.id);
          if (row) setRank({ row, of: r.rows.length });
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, mods]);

  const q = me?.queue;
  const tiles: NeedTile[] = [
    {
      key: 'mine',
      label: 'My unread',
      value: q ? q.myUnread : null,
      hint: 'Assigned to you',
      cta: 'Reply',
      href: '/inbox?status=unread&mine=1',
      accent: 'bg-red-500',
    },
    {
      key: 'waiting',
      label: 'Waiting over 1 hour',
      value: q ? q.waitingOver1h : null,
      hint: 'Your chats, oldest first',
      cta: 'Open',
      href: '/inbox?status=unread&mine=1',
      accent: 'bg-amber-500',
      chip: q && q.waitingOver1h > 0 ? { text: '1h+', tone: 'bad' } : null,
    },
    {
      key: 'pool',
      label: 'Unassigned pool',
      value: q ? q.pool : null,
      hint: 'Pick one up',
      cta: 'Take a chat',
      href: '/inbox?status=unread',
      accent: 'bg-sky-500',
    },
    {
      key: 'open',
      label: 'My open chats',
      value: q ? q.assignedOpen : null,
      hint: 'Not resolved yet',
      cta: 'Inbox',
      href: '/inbox?mine=1',
      accent: 'bg-violet-500',
    },
  ];

  const plan = earn?.plans.find((p) => p.next) ?? earn?.plans[0] ?? null;
  const ringPct = plan?.next ? (plan.units / plan.next.at) * 100 : null;
  const next = me?.nextUp;
  const rec = att?.record;

  if (loading && !me) {
    return (
      <div className="flex flex-col gap-5">
        <SkeletonBlock className="h-64" />
        <SkeletonBlock className="h-36" />
        <SkeletonBlock className="h-72" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="grid overflow-hidden rounded-[22px] bg-navy text-white shadow-[0_20px_48px_rgba(14,26,43,.28)] lg:grid-cols-[1.35fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4 p-6 sm:p-7">
          <div className="text-xs font-extrabold uppercase tracking-[.08em] text-accent">
            Next up · {next?.fromPool ? 'longest waiting in the pool' : 'your longest waiting chat'}
          </div>
          {next ? (
            <>
              <div className="flex items-center gap-3.5">
                <Avatar name={next.name} i={1} size={48} />
                <div className="min-w-0">
                  <div className="truncate text-xl font-extrabold">{next.name}</div>
                  <div className="text-[13px] text-[#9AA4B2]">
                    {[next.city, next.orders ? `${next.orders} past order${next.orders > 1 ? 's' : ''}` : 'New customer', next.lifetimeNet ? `${fullMoney(next.lifetimeNet, me?.currency)} spent` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              </div>
              {next.lastMessage && (
                <blockquote className="line-clamp-3 rounded-2xl border border-navy-line bg-navy-2 px-4 py-3 text-[15px] leading-relaxed">
                  {next.lastMessage}
                </blockquote>
              )}
              <div className="flex flex-wrap items-center gap-2.5">
                <Link
                  href={`/inbox/${next.conversationId}`}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-500 px-4 text-[13px] font-extrabold text-[#04150C] hover:bg-emerald-400"
                >
                  <MessageSquareText size={15} aria-hidden="true" /> Open chat
                </Link>
                {next.waitingMin != null && (
                  <span className="inline-flex h-6 items-center rounded-full bg-amber-500/20 px-2.5 text-xs font-bold text-[#FEC84B]">
                    Waiting {fmtWait(next.waitingMin)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-navy-line bg-navy-2 p-5">
              <div className="text-lg font-extrabold">Inbox zero.</div>
              <div className="text-sm text-[#C7CED9]">No customer is waiting on you. Pick up a chat from the pool or check your follow-ups.</div>
              <Link href="/inbox" className="mt-3 inline-block text-[13px] font-extrabold text-[#6CE9A6] hover:underline">
                Go to the inbox →
              </Link>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-6 bg-navy-2 p-6 sm:p-7">
          {plan && ringPct != null ? (
            <Ring pct={ringPct} label={String(Math.round(plan.units))} sub={`OF ${plan.next!.at}`} size={128} ariaLabel={`${Math.round(plan.units)} of ${plan.next!.at} for ${plan.planName}`} />
          ) : (
            <Ring
              pct={me?.avg30?.confirmed ? Math.min(100, ((me?.today?.confirmed ?? 0) / Math.max(1, me.avg30.confirmed)) * 100) : 0}
              label={String(me?.today?.confirmed ?? 0)}
              sub="CONFIRMED"
              size={128}
              ariaLabel={`${me?.today?.confirmed ?? 0} orders confirmed today`}
            />
          )}
          <div className="flex min-w-[180px] flex-col gap-1.5 text-sm text-[#C7CED9]">
            <div className="text-base font-extrabold text-white">{plan ? plan.planName : 'Today'}</div>
            {plan?.next && <div>{plan.next.label}</div>}
            {earn && (
              <div>
                Commission this month <strong className="text-white">{fullMoney(earn.total, me?.currency)}</strong>
              </div>
            )}
            {rank && (
              <div>
                Leaderboard <strong className="text-white">#{rank.row.rank} of {rank.of}</strong> · {rank.row.points.toLocaleString('en-US')} pts
              </div>
            )}
            {rec?.checkInAt ? (
              <div>
                In since {fmtClock(rec.checkInAt)}
                {att?.effectiveEnd ? ` · shift ends ${att.effectiveEnd}` : ''}
              </div>
            ) : att && !att.excluded && att.dayKind === 'work' ? (
              <div className="font-bold text-[#FEC84B]">Not checked in yet</div>
            ) : null}
            {!plan && !earn && !rank && !att && <div>Your average is {me?.avg30?.confirmed ?? 0} confirmations a day.</div>}
          </div>
        </div>
      </section>

      <TaskTiles tiles={tiles} loading={loading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="My chats" description="Assigned to you, unread first" action={<PanelLink href="/inbox?mine=1">Inbox</PanelLink>}>
          {!me?.chats.length ? (
            <EmptyState compact title="No chats assigned to you" description="Chats you take from the pool show up here." />
          ) : (
            <ul className="flex flex-col gap-2">
              {me.chats.map((c, i) => (
                <li key={c.conversationId}>
                  <Link
                    href={`/inbox/${c.conversationId}`}
                    className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-ink hover:border-emerald-500"
                  >
                    <Avatar name={c.name} i={i + 1} />
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-extrabold">{c.name}</div>
                      <div className="truncate text-[12.5px] text-muted">{c.lastMessage ?? '—'}</div>
                    </div>
                    {c.unread > 0 ? (
                      <Chip tone={c.waitingMin != null && c.waitingMin >= 60 ? 'bad' : c.waitingMin != null && c.waitingMin >= 15 ? 'warn' : 'good'}>
                        {c.waitingMin != null ? fmtWait(c.waitingMin) : `${c.unread} new`}
                      </Chip>
                    ) : (
                      <Chip>replied</Chip>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="My day" description="Today so far vs your 30-day daily average">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Chats replied', v: me?.today?.replies ?? 0, avg: me?.avg30?.replies },
              { label: 'Orders confirmed', v: me?.today?.confirmed ?? 0, avg: me?.avg30?.confirmed },
              { label: 'Orders created', v: me?.today?.created ?? 0, avg: me?.avg30?.created },
            ].map((x) => (
              <div key={x.label} className="rounded-2xl bg-sunken p-3.5">
                <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-muted">{x.label}</span>
                <div className="my-1 text-[26px] font-extrabold tabular-nums text-ink">{x.v}</div>
                <Chip tone={cmpTone(x.v, x.avg)}>avg {x.avg ?? '—'}</Chip>
              </div>
            ))}
            <div className="rounded-2xl bg-sunken p-3.5">
              <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-muted">My first reply</span>
              <div className="my-1 text-[26px] font-extrabold tabular-nums text-ink">{fmtDuration(me?.firstReplySec)}</div>
              <Chip tone={me?.firstReplySec != null && me.teamFirstReplySec != null && me.firstReplySec <= me.teamFirstReplySec ? 'good' : 'flat'}>
                team {fmtDuration(me?.teamFirstReplySec)}
              </Chip>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/inbox" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] font-bold text-ink hover:border-emerald-500">
              <Zap size={14} aria-hidden="true" /> Quick replies live in the composer (type /)
            </Link>
            {has('leaderboard') && <PanelLink href="/leaderboard">Leaderboard</PanelLink>}
          </div>
        </Panel>
      </div>
    </div>
  );
}
