'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  Search,
  Send,
  Paperclip,
  Smile,
  Users,
  TrendingUp,
  TrendingDown,
  ShoppingBag,
  Plus,
  Minus,
} from 'lucide-react';

// A self-built carousel (no carousel lib) showcasing hand-built Tailwind
// mockups of the real product screens with dummy data — no API/DB needed.

type Slide = {
  key: string;
  label: string;
  caption: string;
  render: () => JSX.Element;
};

/* ─────────────────────────  Mock screens  ───────────────────────── */

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-2xl shadow-green-900/5 overflow-hidden">
      {/* fake titlebar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-amber-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <div className="ml-3 hidden sm:flex items-center gap-1.5 rounded-md bg-white border border-gray-200 px-2.5 py-1 text-[11px] text-gray-400">
          apps.codentra.pk
        </div>
      </div>
      {children}
    </div>
  );
}

function InboxMock() {
  const convos = [
    { name: 'Ayesha Khan', last: 'Is the order shipped yet?', time: '2m', unread: 2, active: true },
    { name: 'Bilal Traders', last: 'Thanks, received 👍', time: '14m', unread: 0 },
    { name: 'Sana Malik', last: 'Voice message', time: '1h', unread: 0 },
    { name: 'Hamza Store', last: 'Send me the catalog', time: '3h', unread: 0 },
  ];
  return (
    <BrowserFrame>
      <div className="grid grid-cols-[160px_1fr] sm:grid-cols-[220px_1fr] h-[300px] sm:h-[360px]">
        {/* conversation list */}
        <div className="border-r border-gray-100 bg-white flex flex-col">
          <div className="p-2.5 border-b border-gray-100">
            <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-2.5 py-1.5 text-[11px] text-gray-400">
              <Search size={13} /> Search name, phone or message
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {convos.map((c) => (
              <div
                key={c.name}
                className={`flex items-center gap-2.5 px-2.5 py-2.5 border-b border-gray-50 ${
                  c.active ? 'bg-green-50' : ''
                }`}
              >
                <div className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-green-400 to-emerald-600 text-white grid place-items-center text-[11px] font-semibold">
                  {c.name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="truncate text-[12px] font-medium text-gray-800">{c.name}</p>
                    <span className="text-[10px] text-gray-400">{c.time}</span>
                  </div>
                  <p className="truncate text-[11px] text-gray-500">{c.last}</p>
                </div>
                {c.unread > 0 && (
                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-green-500 px-1 text-[10px] font-semibold text-white">
                    {c.unread}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        {/* thread */}
        <div className="flex flex-col bg-[#efeae2]">
          <div className="flex items-center gap-2.5 border-b border-black/5 bg-white px-3 py-2">
            <div className="h-7 w-7 rounded-full bg-gradient-to-br from-green-400 to-emerald-600 text-white grid place-items-center text-[10px] font-semibold">
              A
            </div>
            <div>
              <p className="text-[12px] font-medium text-gray-800">Ayesha Khan</p>
              <p className="text-[10px] text-green-600">online</p>
            </div>
          </div>
          <div className="flex-1 space-y-2 overflow-hidden p-3">
            <div className="max-w-[75%] rounded-lg rounded-tl-sm bg-white px-2.5 py-1.5 text-[11px] text-gray-700 shadow-sm">
              Hi! Is the order shipped yet?
              <span className="ml-2 align-bottom text-[9px] text-gray-400">10:24</span>
            </div>
            <div className="ml-auto max-w-[75%] rounded-lg rounded-tr-sm bg-[#d9fdd3] px-2.5 py-1.5 text-[11px] text-gray-800 shadow-sm">
              Yes, dispatched today 🚚 Tracking #PK-48201
              <span className="ml-1 inline-flex items-center gap-0.5 align-bottom text-[9px] text-gray-500">
                10:25 <CheckCheck size={11} className="text-sky-500" />
              </span>
            </div>
            <div className="max-w-[75%] rounded-lg rounded-tl-sm bg-white px-2.5 py-1.5 text-[11px] text-gray-700 shadow-sm">
              Perfect, thank you! 🙏
              <span className="ml-2 align-bottom text-[9px] text-gray-400">10:25</span>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-black/5 bg-white px-3 py-2">
            <Smile size={16} className="text-gray-400" />
            <Paperclip size={16} className="text-gray-400" />
            <div className="flex-1 rounded-full bg-gray-100 px-3 py-1.5 text-[11px] text-gray-400">
              Type a message
            </div>
            <span className="grid h-7 w-7 place-items-center rounded-full bg-green-500 text-white">
              <Send size={14} />
            </span>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

function BroadcastMock() {
  const rows = [
    { name: 'Eid Sale — 30% off', status: 'Sending', sent: 742, total: 1000, color: 'bg-green-500' },
    { name: 'New Arrivals drop', status: 'Completed', sent: 540, total: 540, color: 'bg-gray-400' },
    { name: 'Cart reminder', status: 'Scheduled', sent: 0, total: 318, color: 'bg-amber-400' },
  ];
  return (
    <BrowserFrame>
      <div className="h-[300px] sm:h-[360px] bg-gray-50 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-800">Broadcasts</h4>
            <p className="text-[11px] text-gray-500">Campaign builder · per-recipient personalization</p>
          </div>
          <span className="rounded-lg bg-green-500 px-3 py-1.5 text-[11px] font-semibold text-white">
            + New campaign
          </span>
        </div>
        <div className="space-y-2.5">
          {rows.map((r) => {
            const pct = Math.round((r.sent / r.total) * 100);
            return (
              <div key={r.name} className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[12px] font-medium text-gray-800">{r.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      r.status === 'Sending'
                        ? 'bg-green-100 text-green-700'
                        : r.status === 'Scheduled'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="mb-1.5 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div className={`h-full rounded-full ${r.color}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} /> {r.total.toLocaleString()} recipients
                  </span>
                  <span>
                    {r.sent.toLocaleString()} / {r.total.toLocaleString()} sent
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </BrowserFrame>
  );
}

function AnalyticsMock() {
  const kpis = [
    { label: 'Messages sent', value: '12,480', delta: '+18%', up: true },
    { label: 'Active chats', value: '1,204', delta: '+9%', up: true },
    { label: 'Reply rate', value: '87%', delta: '+4%', up: true },
    { label: 'Avg response', value: '2m 11s', delta: '-12%', up: false },
  ];
  const bars = [40, 62, 48, 75, 90, 68, 82];
  return (
    <BrowserFrame>
      <div className="h-[300px] sm:h-[360px] bg-gray-50 p-4 sm:p-5">
        <h4 className="mb-3 text-sm font-semibold text-gray-800">Analytics</h4>
        <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-xl border border-gray-100 bg-white p-2.5 shadow-sm">
              <p className="text-[10px] text-gray-500">{k.label}</p>
              <p className="text-base font-bold text-gray-900">{k.value}</p>
              <span
                className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${
                  k.up ? 'text-green-600' : 'text-red-500'
                }`}
              >
                {k.up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {k.delta}
              </span>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
          <p className="mb-2 text-[11px] font-medium text-gray-600">Messages — last 7 days</p>
          <div className="flex h-28 items-end justify-between gap-2">
            {bars.map((h, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-green-500 to-emerald-400"
                  style={{ height: `${h}%` }}
                />
                <span className="text-[9px] text-gray-400">{['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

function ShopifyOrderMock() {
  const items = [
    { name: 'Cotton Kurta — Medium', qty: 2, price: 2400 },
    { name: 'Embroidered Dupatta', qty: 1, price: 1850 },
  ];
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = 250;
  return (
    <BrowserFrame>
      <div className="h-[300px] sm:h-[360px] bg-gray-50 p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <ShoppingBag size={16} className="text-emerald-600" />
          <h4 className="text-sm font-semibold text-gray-800">Create Shopify order</h4>
          <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            From chat
          </span>
        </div>
        <div className="space-y-2.5">
          {items.map((it) => (
            <div
              key={it.name}
              className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-2.5 shadow-sm"
            >
              <div className="min-w-0">
                <p className="truncate text-[12px] font-medium text-gray-800">{it.name}</p>
                <p className="text-[10px] text-gray-500">Rs {it.price.toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="grid h-5 w-5 place-items-center rounded-md border border-gray-200 text-gray-500">
                  <Minus size={11} />
                </span>
                <span className="w-4 text-center text-[12px] font-medium text-gray-800">{it.qty}</span>
                <span className="grid h-5 w-5 place-items-center rounded-md border border-gray-200 text-gray-500">
                  <Plus size={11} />
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-gray-100 bg-white p-3 text-[11px] shadow-sm">
          <div className="flex justify-between text-gray-500">
            <span>Subtotal</span>
            <span>Rs {subtotal.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-gray-500">
            <span>Shipping</span>
            <span>Rs {shipping}</span>
          </div>
          <div className="mt-1.5 flex justify-between border-t border-gray-100 pt-1.5 text-[12px] font-semibold text-gray-900">
            <span>Total</span>
            <span>Rs {(subtotal + shipping).toLocaleString()}</span>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex-1 rounded-lg border border-emerald-200 bg-emerald-50 py-1.5 text-center text-[11px] font-medium text-emerald-700">
            COD
          </span>
          <span className="flex-1 rounded-lg border border-gray-200 py-1.5 text-center text-[11px] text-gray-500">
            Prepaid
          </span>
          <span className="rounded-lg bg-green-500 px-3 py-1.5 text-[11px] font-semibold text-white">
            Place order
          </span>
        </div>
      </div>
    </BrowserFrame>
  );
}

/* ─────────────────────────  Carousel  ───────────────────────── */

const SLIDES: Slide[] = [
  {
    key: 'inbox',
    label: 'Shared Inbox',
    caption: 'A real-time, multi-agent WhatsApp inbox — assign chats, reply with media, never miss a message.',
    render: () => <InboxMock />,
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts',
    caption: 'Build campaigns, segment your audience and watch delivery progress live.',
    render: () => <BroadcastMock />,
  },
  {
    key: 'analytics',
    label: 'Analytics',
    caption: 'Track messages, reply rates and response times with a clean dashboard.',
    render: () => <AnalyticsMock />,
  },
  {
    key: 'shopify',
    label: 'Shopify orders',
    caption: 'Create and confirm Shopify orders right from the conversation — COD or prepaid.',
    render: () => <ShopifyOrderMock />,
  },
];

export default function FeatureSlider() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = SLIDES.length;

  const go = useCallback((next: number) => setIdx(((next % count) + count) % count), [count]);
  const prev = useCallback(() => go(idx - 1), [go, idx]);
  const next = useCallback(() => go(idx + 1), [go, idx]);

  // auto-advance (paused on hover/focus)
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const t = setInterval(() => {
      if (!pausedRef.current) setIdx((i) => (i + 1) % count);
    }, 4500);
    return () => clearInterval(t);
  }, [count]);

  // keyboard support for the swipe region
  const touchX = useRef<number | null>(null);

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      role="group"
      aria-roledescription="carousel"
      aria-label="Product feature screenshots"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') prev();
        if (e.key === 'ArrowRight') next();
      }}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (dx > 48) prev();
        else if (dx < -48) next();
        touchX.current = null;
      }}
    >
      {/* viewport */}
      <div className="overflow-hidden">
        <div
          className="flex transition-transform duration-500 ease-out"
          style={{ transform: `translateX(-${idx * 100}%)` }}
        >
          {SLIDES.map((s) => (
            <div key={s.key} className="w-full shrink-0 px-1 sm:px-2">
              {s.render()}
            </div>
          ))}
        </div>
      </div>

      {/* caption */}
      <div className="mx-auto mt-5 max-w-xl text-center">
        <p className="text-sm font-semibold text-green-700">{SLIDES[idx].label}</p>
        <p className="mt-1 text-sm text-gray-500">{SLIDES[idx].caption}</p>
      </div>

      {/* controls */}
      <button
        type="button"
        onClick={prev}
        aria-label="Previous"
        className="absolute left-0 top-[40%] -translate-y-1/2 sm:-left-4 grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-md transition hover:bg-gray-50"
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        onClick={next}
        aria-label="Next"
        className="absolute right-0 top-[40%] -translate-y-1/2 sm:-right-4 grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-md transition hover:bg-gray-50"
      >
        <ChevronRight size={18} />
      </button>

      {/* dots */}
      <div className="mt-5 flex items-center justify-center gap-2">
        {SLIDES.map((s, i) => (
          <button
            key={s.key}
            type="button"
            aria-label={`Go to ${s.label}`}
            aria-current={i === idx}
            onClick={() => go(i)}
            className={`h-2 rounded-full transition-all ${
              i === idx ? 'w-6 bg-green-500' : 'w-2 bg-gray-300 hover:bg-gray-400'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
