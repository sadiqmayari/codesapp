'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search, Loader2, Instagram, Users, ExternalLink } from 'lucide-react';
import type { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import {
  PrInfluencer,
  PrSubmission,
  InfluencerStatus,
  INFLUENCER_STATUS_META,
  SUBMISSION_STATUS_META,
  listInfluencers,
  getInfluencer,
  updateInfluencer,
  setSubmissionOutcome,
} from '@/lib/pr';

const STATUS_FILTERS = ['all', 'active', 'vip', 'blacklisted'];

export function InfluencersTab({
  toast,
}: {
  toast: ReturnType<typeof useToast>;
}) {
  const [rows, setRows] = useState<PrInfluencer[]>([]);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listInfluencers({ status, q: q.trim() || undefined }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load influencers');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-2.5 text-gray-400" size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, handle, phone, email…"
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
        </div>
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
          <p>No influencers yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((inf) => {
            const meta = INFLUENCER_STATUS_META[inf.status];
            return (
              <button
                key={inf.id}
                onClick={() => setOpenId(inf.id)}
                className="w-full text-left rounded-xl border border-gray-200 bg-white p-3 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{inf.name}</span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-sm text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
                      {inf.instagram && (
                        <span className="flex items-center gap-1">
                          <Instagram size={13} /> {inf.instagram}
                        </span>
                      )}
                      {inf.follower_count != null && (
                        <span>{inf.follower_count.toLocaleString()} followers</span>
                      )}
                      {inf.niche && <span>{inf.niche}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0 text-xs text-gray-400">
                    <p className="text-gray-700 font-medium">
                      {inf.packages_count} package{inf.packages_count === 1 ? '' : 's'}
                    </p>
                    {inf.last_package_at && <p>last {fmtDate(inf.last_package_at)}</p>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {openId != null && (
        <ProfileModal
          id={openId}
          toast={toast}
          onClose={() => setOpenId(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function ProfileModal({
  id,
  toast,
  onClose,
  onSaved,
}: {
  id: number;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<PrInfluencer | null>(null);
  const [subs, setSubs] = useState<PrSubmission[]>([]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Partial<PrInfluencer>>({});

  const load = useCallback(async () => {
    try {
      const { profile: p, submissions } = await getInfluencer(id);
      setProfile(p);
      setSubs(submissions);
      setEdit({
        name: p.name,
        niche: p.niche,
        status: p.status,
        notes: p.notes,
        follower_count: p.follower_count,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await updateInfluencer(id, {
        name: edit.name,
        niche: edit.niche ?? undefined,
        status: edit.status as InfluencerStatus,
        notes: edit.notes ?? undefined,
        follower_count: edit.follower_count ?? undefined,
      });
      setProfile(updated);
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const markOutcome = async (
    subId: number,
    outcome: 'posted' | 'no_show',
  ) => {
    let postUrl: string | undefined;
    if (outcome === 'posted') {
      postUrl = window.prompt('Post URL (optional):') || undefined;
    }
    try {
      await setSubmissionOutcome(subId, outcome, postUrl);
      toast.success('Outcome updated');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  return (
    <Modal open onClose={onClose} title={profile?.name ?? 'Influencer'} size="lg">
      {!profile ? (
        <div className="flex justify-center py-12 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="p-4 space-y-5">
          {/* Contact (read-only summary) */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {profile.instagram && <Info k="Instagram" v={profile.instagram} />}
            {profile.tiktok && <Info k="TikTok" v={profile.tiktok} />}
            {profile.phone && <Info k="Phone" v={profile.phone} />}
            {profile.email && <Info k="Email" v={profile.email} />}
            {profile.city && <Info k="City" v={profile.city} />}
            {profile.address && <Info k="Address" v={profile.address} />}
          </div>

          {/* Editable fields */}
          <div className="grid sm:grid-cols-2 gap-3">
            <Fld label="Name">
              <input
                value={edit.name ?? ''}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </Fld>
            <Fld label="Status">
              <select
                value={edit.status ?? 'active'}
                onChange={(e) =>
                  setEdit({ ...edit, status: e.target.value as InfluencerStatus })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="active">Active</option>
                <option value="vip">VIP</option>
                <option value="blacklisted">Blacklisted</option>
              </select>
            </Fld>
            <Fld label="Niche / category">
              <input
                value={edit.niche ?? ''}
                onChange={(e) => setEdit({ ...edit, niche: e.target.value })}
                placeholder="e.g. beauty, fitness"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </Fld>
            <Fld label="Followers">
              <input
                inputMode="numeric"
                value={edit.follower_count ?? ''}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    follower_count: e.target.value
                      ? Number(e.target.value.replace(/[^0-9]/g, ''))
                      : null,
                  })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </Fld>
          </div>
          <Fld label="Notes">
            <textarea
              value={edit.notes ?? ''}
              onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </Fld>
          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 disabled:opacity-50"
            >
              Save profile
            </button>
          </div>

          {/* History */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">
              History ({subs.length})
            </p>
            {subs.length === 0 ? (
              <p className="text-sm text-gray-400">No submissions yet.</p>
            ) : (
              <div className="space-y-2">
                {subs.map((s) => {
                  const meta = SUBMISSION_STATUS_META[s.status];
                  return (
                    <div
                      key={s.id}
                      className="rounded-lg border border-gray-200 p-2.5 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium">
                          {s.campaign?.name ?? 'Campaign'}
                        </span>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {fmtDateTime(s.created_at)}
                        {s.order_name && ` · order ${s.order_name}`}
                      </p>
                      {s.status === 'sent' && (
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-500">
                            Outcome: {s.outcome ?? 'pending'}
                          </span>
                          {s.post_url && (
                            <a
                              href={s.post_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-pink-600 inline-flex items-center gap-0.5"
                            >
                              post <ExternalLink size={11} />
                            </a>
                          )}
                          <button
                            onClick={() => markOutcome(s.id, 'posted')}
                            className="text-xs px-2 py-0.5 rounded border border-green-300 text-green-700 hover:bg-green-50"
                          >
                            Mark posted
                          </button>
                          <button
                            onClick={() => markOutcome(s.id, 'no_show')}
                            className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                          >
                            No show
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <span className="text-gray-400">{k}: </span>
      <span className="text-gray-700">{v}</span>
    </div>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
