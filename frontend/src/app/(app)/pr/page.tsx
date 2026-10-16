'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Sparkles,
  Plus,
  Copy,
  Check,
  X,
  Trash2,
  Gift,
  Loader2,
  Link2,
  Instagram,
  Users,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import {
  PrCampaign,
  PrSubmission,
  SUBMISSION_STATUS_META,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  listSubmissions,
  decideSubmission,
  publicFormUrl,
} from '@/lib/pr';
import { SendPackageModal } from '@/components/pr/send-package-modal';
import { InfluencersTab } from '@/components/pr/influencers-tab';

type Tab = 'submissions' | 'campaigns' | 'influencers';
const STATUS_FILTERS = ['all', 'new', 'approved', 'sent', 'declined'];
const TAB_LABEL: Record<Tab, string> = {
  submissions: 'Submissions',
  campaigns: 'Campaigns',
  influencers: 'Influencers',
};

export default function PrPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('submissions');

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-5">
        <Sparkles className="text-pink-600" />
        <h1 className="text-xl font-semibold">PR Management</h1>
      </div>

      <div className="flex gap-1.5 mb-5">
        {(['submissions', 'campaigns', 'influencers'] as Tab[]).map((t) => (
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
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [sendFor, setSendFor] = useState<PrSubmission | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listSubmissions({ status }));
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
      <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
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
          {rows.map((s) => {
            const meta = SUBMISSION_STATUS_META[s.status];
            return (
              <div
                key={s.id}
                className="rounded-xl border border-gray-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium">{s.influencer_name}</p>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${meta.cls}`}>
                        {meta.label}
                      </span>
                      {s.order_name && (
                        <span className="text-[11px] text-gray-400">
                          {s.order_name}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
                      {s.campaign?.name && <span>{s.campaign.name}</span>}
                      {s.instagram && (
                        <span className="flex items-center gap-1">
                          <Instagram size={13} /> {s.instagram}
                        </span>
                      )}
                      {s.follower_count != null && (
                        <span>{s.follower_count.toLocaleString()} followers</span>
                      )}
                      {s.phone && <span>{s.phone}</span>}
                      {s.city && <span>{s.city}</span>}
                    </div>
                    {s.product_wishlist && (
                      <p className="mt-1.5 text-sm text-gray-600">
                        <span className="text-gray-400">Wishlist: </span>
                        {s.product_wishlist}
                      </p>
                    )}
                    {s.address && (
                      <p className="mt-0.5 text-xs text-gray-400">{s.address}</p>
                    )}
                    <p className="mt-1 text-[11px] text-gray-400">
                      {fmtDateTime(s.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {s.status !== 'sent' && (
                      <button
                        onClick={() => setSendFor(s)}
                        className="px-3 py-1.5 text-sm rounded-lg bg-pink-600 text-white hover:bg-pink-700 flex items-center gap-1.5"
                      >
                        <Gift size={15} /> Send PR package
                      </button>
                    )}
                    {s.status === 'new' && (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => decide(s, 'approved')}
                          disabled={busyId === s.id}
                          className="px-2.5 py-1.5 text-sm rounded-lg border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
                          title="Approve"
                        >
                          <Check size={15} />
                        </button>
                        <button
                          onClick={() => decide(s, 'declined')}
                          disabled={busyId === s.id}
                          className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          title="Decline"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
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
    </div>
  );
}

// ─── Campaigns ──────────────────────────────────────────────────────────────
function Campaigns({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [rows, setRows] = useState<PrCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
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
      await createCampaign({ name: name.trim(), intro: intro.trim() || undefined });
      toast.success('Campaign created');
      setCreateOpen(false);
      setName('');
      setIntro('');
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
