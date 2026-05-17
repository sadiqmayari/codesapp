'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Plus,
  Upload,
  Filter,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
} from 'lucide-react';
import { apiFetch, apiFetchEnvelope, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/modal';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import { CsvImportModal } from '@/components/contacts/csv-import-modal';
import { SegmentsDrawer } from '@/components/contacts/segments-drawer';
import type { Contact, ContactStatus, Segment } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const STATUS_FILTERS: Array<{ key: ContactStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'archived', label: 'Archived' },
];

const ACTIVITY = [
  { key: 'any', label: 'Any time', ms: 0 },
  { key: '24h', label: 'Last 24h', ms: 86_400_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
] as const;

const LIMIT = 25;

function StatusPill({ status }: { status: ContactStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'active' && 'bg-green-100 text-green-800',
        status === 'blocked' && 'bg-red-100 text-red-800',
        status === 'archived' && 'bg-gray-200 text-gray-700',
      )}
    >
      {status}
    </span>
  );
}

export default function ContactsPage() {
  const router = useRouter();
  const toast = useToast();

  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<ContactStatus | 'all'>('all');
  const [tag, setTag] = useState('');
  const [segmentId, setSegmentId] = useState<number | ''>('');
  const [activity, setActivity] =
    useState<(typeof ACTIVITY)[number]['key']>('any');

  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [segDrawer, setSegDrawer] = useState(false);
  const [delTarget, setDelTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced, status, tag, segmentId]);

  const loadFacets = useCallback(async () => {
    try {
      const [tags, segs] = await Promise.all([
        apiFetch<string[]>('/contacts/tags'),
        apiFetch<Segment[]>('/contacts/segments'),
      ]);
      setTagOptions(tags);
      setSegments(segs);
    } catch {
      /* facets are non-critical */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<Contact[]>('/contacts', {
        params: {
          page,
          limit: LIMIT,
          search: debounced || undefined,
          status: status === 'all' ? undefined : status,
          tag: tag || undefined,
          segmentId: segmentId === '' ? undefined : segmentId,
        },
      });
      setRows(env.data);
      const meta = env.meta as { total?: number } | undefined;
      setTotal(meta?.total ?? env.data.length);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load contacts',
      );
    } finally {
      setLoading(false);
    }
  }, [page, debounced, status, tag, segmentId, toast]);

  useEffect(() => {
    loadFacets();
  }, [loadFacets]);
  useEffect(() => {
    load();
  }, [load]);

  // "Last activity" has no backend filter — applied client-side to the
  // current page only (documented limitation).
  const visible = useMemo(() => {
    const sel = ACTIVITY.find((a) => a.key === activity)!;
    if (sel.ms === 0) return rows;
    const cutoff = Date.now() - sel.ms;
    return rows.filter(
      (r) =>
        r.last_message_at && new Date(r.last_message_at).getTime() >= cutoff,
    );
  }, [rows, activity]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/contacts/${delTarget.id}`, { method: 'DELETE' });
      toast.success('Contact deleted');
      setDelTarget(null);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to delete contact',
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold text-gray-900 mr-auto">Contacts</h1>
        <button
          onClick={() => setSegDrawer(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          <Filter size={16} /> Manage segments
        </button>
        <button
          onClick={() => setCsvOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          <Upload size={16} /> Import CSV
        </button>
        <button
          onClick={() => {
            setEditTarget(null);
            setFormOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm text-white font-medium"
        >
          <Plus size={16} /> New contact
        </button>
      </div>

      <div className="sticky top-0 z-10 bg-gray-50 pb-3">
        <div className="relative mb-3">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone or email…"
            className="w-full bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatus(s.key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium',
                status === s.key
                  ? 'bg-green-600 text-white'
                  : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100',
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-gray-300" />
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All tags</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={segmentId}
            onChange={(e) =>
              setSegmentId(e.target.value ? Number(e.target.value) : '')
            }
            className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All segments</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={activity}
            onChange={(e) =>
              setActivity(e.target.value as (typeof ACTIVITY)[number]['key'])
            }
            className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
            title="Filters the current page only"
          >
            {ACTIVITY.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-gray-200 bg-white mt-3">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Phone</th>
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">Tags</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Last activity</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                  No contacts found.
                </td>
              </tr>
            ) : (
              visible.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/contacts/${c.id}`)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {c.name}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.phone}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {c.email ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.tags ?? []).slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs"
                        >
                          {t}
                        </span>
                      ))}
                      {(c.tags?.length ?? 0) > 3 && (
                        <span className="text-xs text-gray-400">
                          +{c.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {c.last_message_at ? fmtDateTime(c.last_message_at) : '—'}
                  </td>
                  <td
                    className="px-4 py-3 text-right space-x-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        setEditTarget(c);
                        setFormOpen(true);
                      }}
                      className="text-gray-400 hover:text-gray-700"
                      aria-label="Edit"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => setDelTarget(c)}
                      className="text-gray-400 hover:text-red-600"
                      aria-label="Delete"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3 mt-3">
        {loading ? (
          <p className="text-center text-gray-400 py-8">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No contacts found.</p>
        ) : (
          visible.map((c) => (
            <div
              key={c.id}
              onClick={() => router.push(`/contacts/${c.id}`)}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">
                    {c.name}
                  </p>
                  <p className="text-sm text-gray-500">{c.phone}</p>
                </div>
                <StatusPill status={c.status} />
              </div>
              {c.email && (
                <p className="text-sm text-gray-500 mt-1">{c.email}</p>
              )}
              <div className="flex flex-wrap gap-1 mt-2">
                {(c.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <div
                className="flex justify-end gap-4 mt-3"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setEditTarget(c);
                    setFormOpen(true);
                  }}
                  className="text-sm text-gray-600 inline-flex items-center gap-1"
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  onClick={() => setDelTarget(c)}
                  className="text-sm text-red-600 inline-flex items-center gap-1"
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-100"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-100"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <ContactFormModal
        open={formOpen}
        contact={editTarget}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          load();
          loadFacets();
        }}
      />
      <CsvImportModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        onImported={() => {
          load();
          loadFacets();
        }}
      />
      <SegmentsDrawer
        open={segDrawer}
        onClose={() => setSegDrawer(false)}
        onChanged={loadFacets}
      />
      <ConfirmDialog
        open={!!delTarget}
        title="Delete contact"
        message={`Delete "${delTarget?.name}"? This soft-deletes the contact (it can be restored from the database).`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => !deleting && setDelTarget(null)}
      />
    </div>
  );
}
