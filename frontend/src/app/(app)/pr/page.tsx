'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Plus,
  Check,
  X,
  Trash2,
  Gift,
  Loader2,
  Link2,
  Instagram,
  Music2,
  Phone,
  Users,
  UserPlus,
  MapPin,
  ChevronDown,
  Truck,
  Search,
  Package,
  RefreshCw,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { cn, fmtDate, fmtDateTime } from '@/lib/utils';
import {
  PrCampaign,
  PrSubmission,
  PrOrderRow,
  SUBMISSION_STATUS_META,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  listSubmissions,
  listPrOrders,
  decideSubmission,
  createManualSubmission,
  ManualSubmissionInput,
  publicFormUrl,
} from '@/lib/pr';
import {
  ContactOrder,
  orderDisplayStatus,
  orderStatusTone,
  orderIsActive,
  orderIsDelivered,
  orderIsFailed,
} from '@/lib/contact-orders';
import { socialHandle, socialUrl, initials } from '@/lib/pr-format';
import OrderTrackingModal from '@/components/inbox/order-tracking-modal';
import { SendPackageModal } from '@/components/pr/send-package-modal';
import { InfluencersTab } from '@/components/pr/influencers-tab';
import { VideoManager } from '@/components/pr/video-manager';

type Tab = 'submissions' | 'orders' | 'campaigns' | 'influencers';
const STATUS_FILTERS = ['all', 'new', 'approved', 'sent', 'declined'];
const TAB_LABEL: Record<Tab, string> = {
  submissions: 'Submissions',
  orders: 'PR Orders',
  campaigns: 'Campaigns',
  influencers: 'Influencers',
};

/** Gradient ring used on avatar circles, varied by name so cards differ. */
const AVATAR_GRADIENTS = [
  'from-pink-500 to-violet-500',
  'from-amber-400 to-pink-500',
  'from-emerald-400 to-sky-500',
  'from-sky-500 to-indigo-500',
  'from-rose-400 to-orange-400',
  'from-fuchsia-500 to-purple-500',
];
function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

export default function PrPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('submissions');

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-5">
        <Sparkles className="text-pink-600" />
        <h1 className="text-xl font-semibold">PR Management</h1>
      </div>

      <div className="flex gap-1.5 mb-5 flex-wrap">
        {(['submissions', 'orders', 'campaigns', 'influencers'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-lg ${
              tab === t
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'submissions' ? (
        <Submissions toast={toast} />
      ) : tab === 'orders' ? (
        <PrOrders toast={toast} />
      ) : tab === 'campaigns' ? (
        <Campaigns toast={toast} />
      ) : (
        <InfluencersTab toast={toast} />
      )}
    </div>
  );
}

// ─── Submissions inbox ──────────────────────────────────────────────────────
function Submissions({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [status, setStatus] = useState('all');
  const [rows, setRows] = useState<PrSubmission[]>([]);
  const [ordersBySub, setOrdersBySub] = useState<Record<number, PrOrderRow>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [sendFor, setSendFor] = useState<PrSubmission | null>(null);
  const [trackOrder, setTrackOrder] = useState<ContactOrder | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pull submissions + (for the sent cards' live status strip) the shipped
      // PR orders in one pass. Orders are best-effort — a failure never blocks
      // the list.
      const [subs, orders] = await Promise.all([
        listSubmissions({ status }),
        listPrOrders().catch(() => [] as PrOrderRow[]),
      ]);
      setRows(subs);
      setOrdersBySub(
        Object.fromEntries(orders.map((o) => [o.submissionId, o])),
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load submissions');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (s: PrSubmission, decision: 'approved' | 'declined') => {
    setBusyId(s.id);
    try {
      await decideSubmission(s.id, decision);
      toast.success(decision === 'approved' ? 'Approved' : 'Declined');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <div className="flex gap-1.5 overflow-x-auto pb-1 min-w-0">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`px-3 py-1.5 text-sm rounded-full capitalize whitespace-nowrap ${
                status === f
                  ? 'bg-pink-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="ml-auto shrink-0 px-3 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 flex items-center gap-1.5"
        >
          <UserPlus size={16} /> Add influencer
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Users className="mx-auto mb-3 text-gray-300" size={40} />
          <p>No submissions yet. Share a campaign link to collect them.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((s) => (
            <SubmissionCard
              key={s.id}
              s={s}
              order={ordersBySub[s.id] ?? null}
              busy={busyId === s.id}
              toast={toast}
              onSend={() => setSendFor(s)}
              onDecide={(d) => decide(s, d)}
              onTrack={(o) => setTrackOrder(o)}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {sendFor && (
        <SendPackageModal
          submission={sendFor}
          onClose={() => setSendFor(null)}
          onDone={() => {
            setSendFor(null);
            load();
          }}
        />
      )}

      {trackOrder && (
        <OrderTrackingModal order={trackOrder} onClose={() => setTrackOrder(null)} />
      )}

      <AddInfluencerModal
        open={addOpen}
        toast={toast}
        onClose={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          load();
        }}
      />
    </div>
  );
}

// ─── Redesigned submission card ───────────────────────────────────────────────
function SubmissionCard({
  s,
  order,
  busy,
  toast,
  onSend,
  onDecide,
  onTrack,
  onChanged,
}: {
  s: PrSubmission;
  order: PrOrderRow | null;
  busy: boolean;
  toast: ReturnType<typeof useToast>;
  onSend: () => void;
  onDecide: (d: 'approved' | 'declined') => void;
  onTrack: (o: ContactOrder) => void;
  onChanged: () => void;
}) {
  const meta = SUBMISSION_STATUS_META[s.status];
  const accent =
    s.status === 'sent'
      ? 'bg-violet-500'
      : s.status === 'declined'
        ? 'bg-gray-300'
        : 'bg-gradient-to-b from-pink-500 to-violet-500';
  const followers =
    s.form_data?.followersText ?? s.follower_count?.toLocaleString() ?? null;
  const videoTypes = s.form_data?.videoTypes ?? [];
  const hasDetails =
    videoTypes.length > 0 ||
    !!s.form_data?.about ||
    !!s.form_data?.whyCollaborate ||
    !!s.form_data?.contentPlan ||
    !!s.product_wishlist ||
    !!s.address;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="flex">
        <div className={cn('w-1 shrink-0', accent)} />
        <div className="flex-1 p-4 min-w-0">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'h-11 w-11 rounded-full bg-gradient-to-br grid place-items-center text-white font-semibold shrink-0 text-sm',
                avatarGradient(s.influencer_name),
              )}
            >
              {initials(s.influencer_name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[15px]">{s.influencer_name}</span>
                <span className={cn('text-xs px-1.5 py-0.5 rounded-full', meta.cls)}>
                  {meta.label}
                </span>
                {s.campaign?.name && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {s.campaign.name}
                  </span>
                )}
              </div>

              {/* stat strip */}
              <div className="mt-1.5 flex items-center gap-x-2.5 gap-y-1 flex-wrap text-[13px] text-gray-500">
                {followers && (
                  <span className="inline-flex items-center gap-1">
                    <Users size={13} className="text-gray-400" />
                    <b className="text-gray-700 font-medium">{followers}</b> followers
                  </span>
                )}
                {s.form_data?.videosCount && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>
                      <b className="text-gray-700 font-medium">
                        {s.form_data.videosCount}
                      </b>{' '}
                      videos
                    </span>
                  </>
                )}
                {s.city && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={13} className="text-gray-400" />
                      {s.city}
                    </span>
                  </>
                )}
                {s.form_data?.category && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>{s.form_data.category}</span>
                  </>
                )}
              </div>

              {/* handle chips */}
              <HandleChips s={s} toast={toast} />
            </div>

            {/* actions */}
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              {s.status !== 'sent' && (
                <button
                  onClick={onSend}
                  className="px-3 py-1.5 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Gift size={15} /> Send package
                </button>
              )}
              {s.status === 'new' && (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => onDecide('approved')}
                    disabled={busy}
                    className="h-8 w-8 grid place-items-center rounded-lg border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
                    title="Approve"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onClick={() => onDecide('declined')}
                    disabled={busy}
                    className="h-8 w-8 grid place-items-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                    title="Decline"
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* collapsible pitch & plan */}
          {hasDetails && (
            <details className="mt-3 group">
              <summary className="list-none cursor-pointer text-[13px] font-medium text-pink-700 inline-flex items-center gap-1 select-none">
                <ChevronDown
                  size={14}
                  className="transition-transform group-open:rotate-180"
                />
                <span className="group-open:hidden">Creator pitch &amp; plan</span>
                <span className="hidden group-open:inline">Hide details</span>
              </summary>
              <div className="mt-2 grid sm:grid-cols-2 gap-2.5">
                {videoTypes.length > 0 && (
                  <DetailBox label="Creates" className="sm:col-span-2">
                    <div className="flex flex-wrap gap-1">
                      {videoTypes.map((t) => (
                        <span
                          key={t}
                          className="text-xs px-1.5 py-0.5 rounded-full bg-white border border-gray-200 text-gray-600"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </DetailBox>
                )}
                {s.form_data?.about && (
                  <DetailBox label="About">{s.form_data.about}</DetailBox>
                )}
                {s.form_data?.whyCollaborate && (
                  <DetailBox label="Why collaborate">
                    {s.form_data.whyCollaborate}
                  </DetailBox>
                )}
                {s.form_data?.contentPlan && (
                  <DetailBox label="Content plan" className="sm:col-span-2">
                    {s.form_data.contentPlan}
                  </DetailBox>
                )}
                {s.product_wishlist && (
                  <DetailBox label="Product wishlist" className="sm:col-span-2">
                    {s.product_wishlist}
                  </DetailBox>
                )}
                {s.address && (
                  <p className="text-[12px] text-gray-400 sm:col-span-2 inline-flex items-start gap-1">
                    <MapPin size={12} className="mt-0.5 shrink-0" />
                    {s.address}
                  </p>
                )}
              </div>
            </details>
          )}

          {/* sent → order status strip + videos */}
          {s.status === 'sent' && (
            <div className="mt-3 space-y-3">
              {order && (
                <OrderStatusStrip order={order} onTrack={onTrack} />
              )}
              <VideoManager submission={s} toast={toast} onChanged={onChanged} />
            </div>
          )}

          <div className="mt-3 text-xs text-gray-400">
            Submitted {fmtDateTime(s.created_at)}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailBox({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl bg-gray-50 border border-gray-100 p-3 text-[13px] text-gray-600',
        className,
      )}
    >
      <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

/** Clean Instagram/TikTok/phone chips (URL tracking junk stripped). */
function HandleChips({
  s,
  toast,
}: {
  s: PrSubmission;
  toast: ReturnType<typeof useToast>;
}) {
  const ig = socialHandle(s.instagram);
  const igUrl = socialUrl(s.instagram, 'instagram');
  const tt = socialHandle(s.tiktok);
  const ttUrl = socialUrl(s.tiktok, 'tiktok');

  const copyPhone = async () => {
    if (!s.phone) return;
    try {
      await navigator.clipboard.writeText(s.phone);
      toast.success('Phone copied');
    } catch {
      toast.info(s.phone);
    }
  };

  if (!ig && !tt && !s.phone) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      {ig && (
        <a
          href={igUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-pink-50 text-pink-700 border border-pink-100 hover:bg-pink-100"
        >
          <Instagram size={12} /> {ig}
        </a>
      )}
      {tt && (
        <a
          href={ttUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-900 text-white hover:bg-black"
        >
          <Music2 size={12} /> {tt}
        </a>
      )}
      {s.phone && (
        <button
          onClick={copyPhone}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
          title="Copy phone"
        >
          <Phone size={12} /> {s.phone}
        </button>
      )}
    </div>
  );
}

/** Live courier status line for a shipped PR package. */
function OrderStatusStrip({
  order,
  onTrack,
}: {
  order: PrOrderRow;
  onTrack: (o: ContactOrder) => void;
}) {
  const co = order as ContactOrder;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 flex items-center gap-2.5 flex-wrap">
      <span className="text-[13px] font-medium text-gray-700 inline-flex items-center gap-1">
        <Package size={14} className="text-gray-400" />
        {order.orderName ?? 'Order'}
      </span>
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded-full inline-flex items-center gap-1',
          orderStatusTone(co),
        )}
      >
        <Truck size={11} /> {orderDisplayStatus(co)}
        {order.courierType ? ` · ${order.courierType}` : ''}
      </span>
      {order.trackingNumber && (
        <span className="text-[12px] text-gray-500 font-mono">
          {order.trackingNumber}
        </span>
      )}
      {order.shipmentId != null && (
        <button
          onClick={() => onTrack(co)}
          className="ml-auto px-2.5 py-1.5 text-[13px] rounded-lg border border-gray-300 bg-white text-blue-700 font-medium hover:bg-gray-50 inline-flex items-center gap-1.5"
        >
          Track <Truck size={13} />
        </button>
      )}
    </div>
  );
}

// ─── PR Orders tab (sent packages + live courier tracking) ───────────────────
const ORDER_FILTERS = ['all', 'in_transit', 'delivered', 'issues'] as const;
type OrderFilter = (typeof ORDER_FILTERS)[number];
const ORDER_FILTER_LABEL: Record<OrderFilter, string> = {
  all: 'All',
  in_transit: 'In transit',
  delivered: 'Delivered',
  issues: 'Issues',
};

function PrOrders({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [rows, setRows] = useState<PrOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [trackOrder, setTrackOrder] = useState<ContactOrder | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      isRefresh ? setRefreshing(true) : setLoading(true);
      try {
        setRows(await listPrOrders());
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load PR orders');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const tiles = useMemo(() => {
    let active = 0;
    let delivered = 0;
    let issues = 0;
    for (const r of rows) {
      const co = r as ContactOrder;
      if (orderIsDelivered(co)) delivered += 1;
      else if (orderIsFailed(co)) issues += 1;
      else if (orderIsActive(co)) active += 1;
    }
    return { sent: rows.length, active, delivered, issues };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const co = r as ContactOrder;
      if (filter === 'delivered' && !orderIsDelivered(co)) return false;
      if (filter === 'issues' && !orderIsFailed(co)) return false;
      if (
        filter === 'in_transit' &&
        !(orderIsActive(co) && !orderIsDelivered(co) && !orderIsFailed(co))
      )
        return false;
      if (!needle) return true;
      return (
        r.influencerName.toLowerCase().includes(needle) ||
        (r.orderName ?? '').toLowerCase().includes(needle) ||
        (r.campaign?.name ?? '').toLowerCase().includes(needle) ||
        (r.trackingNumber ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, q, filter]);

  return (
    <div>
      {/* summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <StatTile label="Packages sent" value={tiles.sent} />
        <StatTile label="In transit" value={tiles.active} tone="text-blue-600" />
        <StatTile label="Delivered" value={tiles.delivered} tone="text-green-600" />
        <StatTile label="Returned / issues" value={tiles.issues} tone="text-rose-600" />
      </div>

      {/* controls */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-2.5 text-gray-400" size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search influencer, order #, tracking…"
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <div className="flex gap-1.5">
          {ORDER_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-full whitespace-nowrap',
                filter === f
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
              )}
            >
              {ORDER_FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Package className="mx-auto mb-3 text-gray-300" size={40} />
          <p>
            {rows.length === 0
              ? 'No PR packages shipped yet.'
              : 'No orders match this filter.'}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
          {shown.map((r) => (
            <PrOrderRowItem key={r.submissionId} r={r} onTrack={setTrackOrder} />
          ))}
        </div>
      )}

      {trackOrder && (
        <OrderTrackingModal order={trackOrder} onClose={() => setTrackOrder(null)} />
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className={cn('text-2xl font-semibold mt-0.5', tone)}>{value}</div>
    </div>
  );
}

function PrOrderRowItem({
  r,
  onTrack,
}: {
  r: PrOrderRow;
  onTrack: (o: ContactOrder) => void;
}) {
  const co = r as ContactOrder;
  const videoLine =
    r.videosPromised != null
      ? `${r.videosDelivered} of ${r.videosPromised} videos${
          r.videosDelivered >= r.videosPromised ? ' ✓' : ''
        }`
      : `${r.videosDelivered} video${r.videosDelivered === 1 ? '' : 's'}`;
  const sub = [
    r.orderName,
    r.courierType ?? null,
    r.trackingNumber ?? null,
    videoLine,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex items-center gap-3 p-3.5 hover:bg-gray-50">
      <div
        className={cn(
          'h-9 w-9 rounded-full bg-gradient-to-br grid place-items-center text-white text-xs font-semibold shrink-0',
          avatarGradient(r.influencerName),
        )}
      >
        {initials(r.influencerName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[14px]">{r.influencerName}</span>
          {r.campaign?.name && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {r.campaign.name}
            </span>
          )}
        </div>
        <div className="text-[12px] text-gray-500 mt-0.5 truncate">{sub}</div>
      </div>
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap',
          orderStatusTone(co),
        )}
      >
        {orderDisplayStatus(co)}
      </span>
      {r.shipmentId != null && (
        <button
          onClick={() => onTrack(co)}
          className="px-2.5 py-1.5 text-[13px] rounded-lg border border-gray-300 bg-white text-blue-700 font-medium whitespace-nowrap hover:bg-gray-50 inline-flex items-center gap-1.5"
        >
          Track <Truck size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Manually add an influencer (creates a pre-approved submission) ───────────
function AddInfluencerModal({
  open,
  toast,
  onClose,
  onDone,
}: {
  open: boolean;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onDone: () => void;
}) {
  const empty: ManualSubmissionInput = { campaignId: 0, influencerName: '' };
  const [form, setForm] = useState<ManualSubmissionInput>(empty);
  const [campaigns, setCampaigns] = useState<PrCampaign[]>([]);
  const [loadingCamps, setLoadingCamps] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(empty);
    setLoadingCamps(true);
    listCampaigns()
      .then((rows) => {
        const active = rows.filter((c) => c.active);
        setCampaigns(active);
        if (active.length === 1) {
          setForm((f) => ({ ...f, campaignId: active[0].id }));
        }
      })
      .catch((e) =>
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load campaigns'),
      )
      .finally(() => setLoadingCamps(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: keyof ManualSubmissionInput, v: string) =>
    setForm((f) => ({
      ...f,
      [k]: k === 'followerCount' ? (v ? Number(v) : undefined) : v,
    }));

  const submit = async () => {
    if (!form.campaignId) return toast.error('Pick a campaign');
    if (!form.influencerName.trim()) return toast.error('Name is required');
    if (!form.phone?.trim() && !form.instagram?.trim() && !form.email?.trim()) {
      return toast.error('Add a phone, Instagram, or email');
    }
    setBusy(true);
    try {
      const clean: ManualSubmissionInput = {
        campaignId: form.campaignId,
        influencerName: form.influencerName.trim(),
      };
      for (const k of ['phone', 'email', 'instagram', 'tiktok', 'city', 'address', 'niche', 'notes'] as const) {
        const v = form[k];
        if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
      }
      if (form.followerCount != null && !Number.isNaN(form.followerCount)) {
        clean.followerCount = form.followerCount;
      }
      await createManualSubmission(clean);
      toast.success('Influencer added');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to add influencer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add influencer"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || loadingCamps || campaigns.length === 0}
            className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Add influencer
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <p className="text-xs text-gray-500">
          Creates a pre-approved submission under a campaign and a CRM profile. Ship
          later with <span className="font-medium">Send PR package</span>. Needs a
          phone, Instagram, or email.
        </p>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Campaign *</span>
          {loadingCamps ? (
            <div className="mt-1 text-sm text-gray-400 flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" /> Loading campaigns…
            </div>
          ) : campaigns.length === 0 ? (
            <p className="mt-1 text-sm text-amber-600">
              Create a campaign first (Campaigns tab).
            </p>
          ) : (
            <select
              value={form.campaignId || ''}
              onChange={(e) => set('campaignId', e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
            >
              <option value="" disabled>
                Select a campaign…
              </option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Name *</span>
          <input
            value={form.influencerName}
            onChange={(e) => set('influencerName', e.target.value)}
            placeholder="e.g. Ayesha Khan"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Phone</span>
            <input
              value={form.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+92 300 1234567"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Email</span>
            <input
              value={form.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
              placeholder="name@email.com"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Instagram</span>
            <input
              value={form.instagram ?? ''}
              onChange={(e) => set('instagram', e.target.value)}
              placeholder="@handle"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">TikTok</span>
            <input
              value={form.tiktok ?? ''}
              onChange={(e) => set('tiktok', e.target.value)}
              placeholder="@handle"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">City</span>
            <input
              value={form.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
              placeholder="Karachi"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Followers</span>
            <input
              type="number"
              min={0}
              value={form.followerCount ?? ''}
              onChange={(e) => set('followerCount', e.target.value)}
              placeholder="48000"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Address</span>
          <input
            value={form.address ?? ''}
            onChange={(e) => set('address', e.target.value)}
            placeholder="House, street, area…"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Niche (optional)</span>
          <input
            value={form.niche ?? ''}
            onChange={(e) => set('niche', e.target.value)}
            placeholder="e.g. Beauty, Lifestyle"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Notes (optional)</span>
          <textarea
            value={form.notes ?? ''}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
            placeholder="How they reached you, anything useful…"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}

// ─── Campaigns ──────────────────────────────────────────────────────────────
function Campaigns({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [rows, setRows] = useState<PrCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [terms, setTerms] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [delId, setDelId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listCampaigns());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) return toast.error('Campaign name is required');
    setBusy(true);
    try {
      await createCampaign({
        name: name.trim(),
        intro: intro.trim() || undefined,
        terms: terms.trim() || undefined,
      });
      toast.success('Campaign created');
      setCreateOpen(false);
      setName('');
      setIntro('');
      setTerms('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (c: PrCampaign) => {
    const url = publicFormUrl(c);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.info(url);
    }
  };

  const doDelete = async () => {
    if (delId == null) return;
    setBusy(true);
    try {
      await deleteCampaign(delId);
      toast.success('Campaign deleted');
      setDelId(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setCreateOpen(true)}
          className="px-3 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 flex items-center gap-1.5"
        >
          <Plus size={16} /> New campaign
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Sparkles className="mx-auto mb-3 text-gray-300" size={40} />
          <p>No campaigns yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  {c.intro && (
                    <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{c.intro}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    {c._count?.submissions ?? 0} submissions · created {fmtDate(c.created_at)}
                    {!c.active && ' · inactive'}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => copy(c)}
                    className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5"
                    title="Copy public link"
                  >
                    {copiedId === c.id ? (
                      <Check size={15} className="text-green-600" />
                    ) : (
                      <Link2 size={15} />
                    )}
                    {copiedId === c.id ? 'Copied' : 'Copy link'}
                  </button>
                  <button
                    onClick={() => setDelId(c.id)}
                    className="px-2.5 py-1.5 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New PR campaign"
        footer={
          <>
            <button
              onClick={() => setCreateOpen(false)}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Campaign name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Winter 2026 influencer seeding"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">
              Intro shown on the public form (optional)
            </span>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={3}
              placeholder="Tell influencers what this is about…"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">
              Terms &amp; conditions shown above the consent (optional)
            </span>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={4}
              placeholder="The full terms the influencer must accept…"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={delId != null}
        title="Delete campaign?"
        message="This deletes the campaign and all its submissions. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDelId(null)}
      />
    </div>
  );
}
