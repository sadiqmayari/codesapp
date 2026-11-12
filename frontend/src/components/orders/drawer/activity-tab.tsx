'use client';

import { useMemo, useState } from 'react';
import { Loader2, MessageCircle, Phone, ShoppingBag, StickyNote, Truck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { updateOrderNote, type OrderDetail, type OrderLiveDetail } from '@/lib/orders';
import type { TrackingCheckpoint } from '@/lib/couriers';
import { Skeleton } from '@/components/ui/skeleton';
import { Section } from './shared';

type Src = 'shopify' | 'courier' | 'whatsapp' | 'team';
interface Ev {
  src: Src;
  at: string | null;
  text: string;
}

const SRC_META: Record<Src, { label: string; chip: string; Icon: React.ElementType }> = {
  shopify: { label: 'Shopify', chip: 'bg-brand-50 text-brand-700', Icon: ShoppingBag },
  courier: { label: 'Courier', chip: 'bg-amber-50 text-amber-700', Icon: Truck },
  whatsapp: { label: 'WhatsApp', chip: 'bg-sky-50 text-sky-700', Icon: MessageCircle },
  team: { label: 'Team', chip: 'bg-violet-50 text-violet-700', Icon: Phone },
};

const CONF_TEXT: Record<string, string> = {
  confirmed: 'Customer confirmed the order on WhatsApp',
  cancelled: 'Customer chose Cancel on the WhatsApp confirmation',
  no_response: 'Marked “No response” to the confirmation',
  undeliverable: 'Confirmation could not be delivered (not on WhatsApp)',
};

/** Merge every source the drawer already has into one time-ordered feed. */
export function buildActivity(
  d: OrderDetail,
  live: OrderLiveDetail | null,
  scans: TrackingCheckpoint[],
): Ev[] {
  const out: Ev[] = [];
  for (const e of live?.ok ? live.timeline ?? [] : []) out.push({ src: 'shopify', at: e.at, text: e.message });
  for (const c of scans)
    out.push({ src: 'courier', at: c.at ?? null, text: c.detail ? `${c.status} · ${c.detail}` : c.status });
  const conf = d.confirmation;
  if (conf?.sentAt) out.push({ src: 'whatsapp', at: conf.sentAt, text: 'Order confirmation sent on WhatsApp' });
  if (conf && conf.updatedAt && CONF_TEXT[conf.status] && conf.updatedAt !== conf.sentAt)
    out.push({ src: 'whatsapp', at: conf.updatedAt, text: CONF_TEXT[conf.status] });
  if (d.order.manualConfirmedAt)
    out.push({ src: 'team', at: d.order.manualConfirmedAt, text: 'Order marked confirmed by an agent' });
  for (const c of d.callLogs) out.push({ src: 'team', at: c.at, text: `${c.agent ?? 'An agent'} logged a call to the customer` });
  return out.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
}

const PAGE = 30;

export function ActivityTab({
  d,
  live,
  scans,
  readOnly,
  onNoteSaved,
}: {
  d: OrderDetail;
  live: OrderLiveDetail | null;
  scans: TrackingCheckpoint[];
  readOnly: boolean;
  onNoteSaved: (note: string) => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState<Src | 'all'>('all');
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const events = useMemo(() => buildActivity(d, live, scans), [d, live, scans]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.src] = (c[e.src] ?? 0) + 1;
    return c;
  }, [events]);
  const shown = events.filter((e) => filter === 'all' || e.src === filter);

  // Team notes append a timestamped line to the order's internal note (no new
  // table) — the note is the CodesApp-only scratchpad agents already use.
  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    const stamp = fmtDateTime(new Date().toISOString());
    const prev = d.order.internalNote?.trim();
    const next = prev ? `${prev}\n[${stamp}] ${text}` : `[${stamp}] ${text}`;
    try {
      await updateOrderNote(d.order.orderGid, next);
      onNoteSaved(next);
      setDraft('');
      toast.success('Note added');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.userMessage : 'Could not add the note');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Section title="Activity">
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter activity">
        {(['all', 'shopify', 'courier', 'whatsapp', 'team'] as const).map((k) => {
          const n = k === 'all' ? events.length : counts[k] ?? 0;
          if (k !== 'all' && n === 0) return null;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-bold',
                filter === k ? 'border-ink bg-ink text-surface' : 'border-line bg-surface text-muted hover:text-ink',
              )}
            >
              {k === 'all' ? 'All' : SRC_META[k].label} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {!live && events.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full rounded-xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing here yet.</p>
      ) : (
        <ol className="relative">
          <span aria-hidden className="absolute bottom-2 left-[13px] top-2 w-0.5 bg-line" />
          {shown.slice(0, limit).map((e, i) => {
            const m = SRC_META[e.src];
            return (
              <li key={i} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2.5 pb-3.5 last:pb-0">
                <span className="relative z-[1] grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-muted">
                  <m.Icon size={13} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold leading-snug text-ink min-w-0 break-words [word-break:break-word]">
                    <span className={cn('mr-1.5 rounded px-1.5 py-px text-[10px] font-extrabold uppercase', m.chip)}>
                      {m.label}
                    </span>
                    {e.text}
                  </p>
                  <p className="text-xs text-muted">{e.at ? fmtDateTime(e.at) : ''}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {shown.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="mt-2 text-xs font-bold text-sky-700 hover:underline"
        >
          Show {Math.min(PAGE, shown.length - limit)} more
        </button>
      )}
      {live && !live.ok && (
        <p className="mt-2 text-xs text-muted">Shopify events are unavailable right now.</p>
      )}

      {!readOnly && (
        <form onSubmit={post} className="mt-4 flex gap-2 border-t border-line pt-3">
          <label htmlFor="activity-note" className="sr-only">
            Add a team note
          </label>
          <div className="relative flex-1">
            <StickyNote size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              id="activity-note"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a team note to this order…"
              autoComplete="off"
              className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[13px] text-ink placeholder:text-muted"
            />
          </div>
          <button
            type="submit"
            disabled={posting || !draft.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {posting && <Loader2 size={13} className="animate-spin" />}
            Add note
          </button>
        </form>
      )}
    </Section>
  );
}
