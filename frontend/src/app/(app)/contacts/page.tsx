'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Ban,
  Copy as CopyIcon,
  Download,
  Filter,
  Megaphone,
  MessageCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Column, DataTable, SortState } from '@/components/ui/data-table';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import { CsvImportModal } from '@/components/contacts/csv-import-modal';
import { SegmentsDrawer } from '@/components/contacts/segments-drawer';
import { TagEditor } from '@/components/contacts/tag-editor';
import { cn, fmtListTime } from '@/lib/utils';
import type { Contact, ContactStatus, Segment } from '@/lib/crm-types';
import { apiFetch } from '@/lib/api';
import {
  BulkAction,
  ContactListQuery,
  bulkContacts,
  deleteContact,
  downloadContactsCsv,
  ensureConversation,
  filterOnly,
  formatPhone,
  hasActiveFilters,
  initials,
  isManagerRole,
  listContactTags,
  listContacts,
  listDuplicates,
  queryFromSearch,
  restoreContact,
  searchFromQuery,
} from '@/lib/contacts';

const PAGE_SIZES = [25, 50, 100];

const dayIso = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const ACTIVITY = [
  { value: '', label: 'Any activity' },
  { value: 'a7', label: 'Messaged in last 7 days' },
  { value: 'a30', label: 'Messaged in last 30 days' },
  { value: 'i30', label: 'No message for 30+ days' },
  { value: 'i90', label: 'No message for 90+ days' },
];
function activityPreset(q: ContactListQuery): string {
  if (q.lastMessageAfter && !q.lastMessageBefore) {
    if (q.lastMessageAfter === dayIso(7)) return 'a7';
    if (q.lastMessageAfter === dayIso(30)) return 'a30';
    return 'custom';
  }
  if (q.lastMessageBefore && !q.lastMessageAfter) {
    if (q.lastMessageBefore === dayIso(30)) return 'i30';
    if (q.lastMessageBefore === dayIso(90)) return 'i90';
    return 'custom';
  }
  return q.lastMessageAfter || q.lastMessageBefore ? 'custom' : '';
}
function applyActivity(v: string): Pick<ContactListQuery, 'lastMessageAfter' | 'lastMessageBefore'> {
  switch (v) {
    case 'a7':
      return { lastMessageAfter: dayIso(7), lastMessageBefore: undefined };
    case 'a30':
      return { lastMessageAfter: dayIso(30), lastMessageBefore: undefined };
    case 'i30':
      return { lastMessageAfter: undefined, lastMessageBefore: dayIso(30) };
    case 'i90':
      return { lastMessageAfter: undefined, lastMessageBefore: dayIso(90) };
    default:
      return { lastMessageAfter: undefined, lastMessageBefore: undefined };
  }
}

const SORTS: { value: string; label: string }[] = [
  { value: 'last_message_at:desc', label: 'Last message (newest)' },
  { value: 'last_message_at:asc', label: 'Last message (oldest)' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'name:desc', label: 'Name Z–A' },
  { value: 'created_at:desc', label: 'Recently added' },
  { value: 'created_at:asc', label: 'Oldest added' },
];

function StatusBadge({ c }: { c: Contact }) {
  if (c.deleted_at) return <Badge tone="neutral">Deleted</Badge>;
  if (c.status === 'blocked') return <Badge tone="danger">Blocked</Badge>;
  if (c.status === 'archived') return <Badge tone="neutral">Archived</Badge>;
  if (c.opted_out_at)
    return (
      <Badge tone="warn" title={c.opt_out_source === 'whatsapp_stop' ? 'Replied STOP' : 'Opted out by an agent'}>
        Opted out
      </Badge>
    );
  return <Badge tone="success">Subscribed</Badge>;
}

const selectCls =
  'h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none';

export default function ContactsPage() {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const { on } = useSocket();
  const canManage = isManagerRole(user?.role);

  const [q, setQ] = useState<ContactListQuery | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [cityDraft, setCityDraft] = useState('');
  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [dupCount, setDupCount] = useState(0);

  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [tagDialog, setTagDialog] = useState<'tag_add' | 'tag_remove' | null>(null);
  const [tagDialogTags, setTagDialogTags] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ action: BulkAction; status?: ContactStatus; title: string; message: string; label: string } | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [segOpen, setSegOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);

  const seq = useRef(0);
  const qRef = useRef<ContactListQuery | null>(null);
  qRef.current = q;

  // Init from the URL once (filters survive back-nav from a contact + sharing).
  useEffect(() => {
    const init = queryFromSearch(new URLSearchParams(window.location.search));
    setQ(init);
    setSearchDraft(init.search ?? '');
    setCityDraft(init.city ?? '');
  }, []);

  const update = useCallback((patch: Partial<ContactListQuery>, keepPage = false) => {
    setQ((cur) => {
      const next = { ...(cur ?? {}), ...patch };
      if (!keepPage) next.page = 1;
      return next;
    });
    setSelected(new Set());
    setAllMatching(false);
  }, []);

  // Debounced search + city.
  useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => {
      if ((q.search ?? '') !== searchDraft.trim()) update({ search: searchDraft.trim() || undefined });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);
  useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => {
      if ((q.city ?? '') !== cityDraft.trim()) update({ city: cityDraft.trim() || undefined });
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityDraft]);

  const load = useCallback(
    async (silent = false) => {
      const cur = qRef.current;
      if (!cur) return;
      const mine = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const env = await listContacts({ ...cur, limit: cur.limit ?? 25, sort: cur.sort ?? 'last_message_at', dir: cur.dir ?? 'desc' });
        if (mine !== seq.current) return; // a newer request superseded this one
        setRows(env.data ?? []);
        setTotal(Number(env.meta?.total ?? 0));
        setLoadError(false);
      } catch (e) {
        if (mine !== seq.current) return;
        setLoadError(true);
        if (!silent) toast.error(e instanceof ApiError ? e.userMessage : 'Could not load contacts');
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [toast],
  );

  // Fetch + URL sync whenever the query changes.
  useEffect(() => {
    if (!q) return;
    void load();
    const s = searchFromQuery(q);
    if (s !== window.location.search) router.replace(`${pathname}${s}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, load, pathname]);

  const loadMeta = useCallback(() => {
    listContactTags().then(setTagOptions).catch(() => setTagOptions([]));
    apiFetch<Segment[]>('/contacts/segments').then(setSegments).catch(() => setSegments([]));
  }, []);
  useEffect(() => {
    loadMeta();
    if (canManage) listDuplicates().then((d) => setDupCount(d.total)).catch(() => setDupCount(0));
  }, [loadMeta, canManage]);

  // Live: any contact change → quiet refresh (debounced; bulk ops emit once).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('contact.updated', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(true), 600);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [on, load]);

  const limit = q?.limit ?? 25;
  const page = q?.page ?? 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const selectedIds = useMemo(() => Array.from(selected).map(Number), [selected]);
  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectionCount = allMatching ? total : selectedIds.length;
  const filtered = q ? hasActiveFilters(q) : false;

  const sortState: SortState = q?.sort
    ? { key: q.sort, dir: q.dir ?? 'desc' }
    : { key: 'last_message_at', dir: q?.dir ?? 'desc' };

  const runBulk = async (action: BulkAction, extra: { tags?: string[]; status?: ContactStatus } = {}) => {
    if (!q) return;
    setBulkBusy(true);
    try {
      const res = await bulkContacts({
        action,
        ...(allMatching ? { filter: filterOnly(q) } : { ids: selectedIds }),
        ...extra,
      });
      toast.success(`${res.affected.toLocaleString()} contact${res.affected === 1 ? '' : 's'} updated`);
      setSelected(new Set());
      setAllMatching(false);
      setTagDialog(null);
      setConfirm(null);
      void load(true);
      if (action === 'tag_add' || action === 'tag_remove') loadMeta();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk update failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const openChat = async (c: Contact) => {
    setOpening(c.id);
    try {
      const { conversationId } = await ensureConversation(c.id);
      router.push(`/inbox/${conversationId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not open the chat');
      setOpening(null);
    }
  };

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await deleteContact(delTarget.id);
      toast.success('Contact deleted — you can restore it from “Show deleted”');
      setDelTarget(null);
      void load(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not delete');
    } finally {
      setDeleting(false);
    }
  };

  const doRestore = async (c: Contact) => {
    try {
      await restoreContact(c.id);
      toast.success('Contact restored');
      void load(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not restore');
    }
  };

  const doExport = async () => {
    if (!q) return;
    setExporting(true);
    try {
      await downloadContactsCsv(q);
    } catch {
      toast.error('Export failed. Try narrowing the filter.');
    } finally {
      setExporting(false);
    }
  };

  const copyPhone = async (c: Contact) => {
    try {
      await navigator.clipboard.writeText(formatPhone(c.phone).replace(/\s/g, ''));
      toast.success('Number copied');
    } catch {
      /* ignore */
    }
  };

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Contact',
      sortable: true,
      render: (c) => (
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden
            className="h-8 w-8 shrink-0 rounded-full bg-sky-50 text-sky-700 text-xs font-bold inline-flex items-center justify-center"
          >
            {initials(c.name)}
          </span>
          <div className="min-w-0">
            <Link
              href={`/contacts/${c.id}`}
              className="block font-semibold text-ink truncate hover:underline max-w-[14rem]"
              onClick={(e) => e.stopPropagation()}
            >
              {c.name}
            </Link>
            <span className="block text-xs text-muted truncate max-w-[14rem]">
              {[c.city, c.email].filter(Boolean).join(' · ') || '—'}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      render: (c) => (
        <span className="inline-flex items-center gap-1 tabular-nums whitespace-nowrap text-ink">
          {formatPhone(c.phone)}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void copyPhone(c);
            }}
            aria-label={`Copy ${c.name}'s number`}
            className="p-1 rounded text-muted hover:text-ink hover:bg-sunken"
          >
            <CopyIcon size={12} />
          </button>
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      render: (c) => {
        const tags = Array.isArray(c.tags) ? c.tags : [];
        return (
          <div className="flex flex-wrap gap-1 max-w-[16rem]">
            {tags.slice(0, 3).map((t) => (
              <button
                key={t}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!(q?.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase()))
                    update({ tags: [...(q?.tags ?? []), t] });
                }}
                title={`Filter by ${t}`}
                className="rounded-full border border-line bg-sunken px-2 py-0.5 text-xs text-ink hover:border-brand-500"
              >
                {t}
              </button>
            ))}
            {tags.length > 3 && <span className="text-xs text-muted">+{tags.length - 3}</span>}
          </div>
        );
      },
    },
    {
      key: 'last_message_at',
      header: 'Last message',
      sortable: true,
      render: (c) => <span className="text-muted whitespace-nowrap">{fmtListTime(c.last_message_at) || 'Never'}</span>,
    },
    {
      key: 'created_at',
      header: 'Added',
      sortable: true,
      className: 'hidden xl:table-cell',
      render: (c) => <span className="text-muted whitespace-nowrap">{fmtListTime(c.created_at)}</span>,
    },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge c={c} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (c) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          {c.deleted_at ? (
            canManage && (
              <Button size="sm" variant="secondary" onClick={() => void doRestore(c)}>
                <RotateCcw size={13} /> Restore
              </Button>
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => void openChat(c)}
                disabled={opening === c.id}
                aria-label={`Open chat with ${c.name}`}
                title="Open chat"
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted hover:text-brand-700 hover:bg-sunken disabled:opacity-50"
              >
                <MessageCircle size={15} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditTarget(c);
                  setFormOpen(true);
                }}
                aria-label={`Edit ${c.name}`}
                title="Edit"
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-sunken"
              >
                <Pencil size={15} />
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setDelTarget(c)}
                  aria-label={`Delete ${c.name}`}
                  title="Delete"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted hover:text-red-600 hover:bg-sunken"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  const activeSeg = segments.find((s) => s.id === q?.segmentId);
  const act = q ? activityPreset(q) : '';

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-ink">Contacts</h1>
          <p className="text-sm text-muted tabular-nums">
            {loading && !rows.length ? 'Loading…' : `${total.toLocaleString()} ${filtered ? 'matching' : q?.deleted ? 'deleted' : 'contacts'}`}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setSegOpen(true)}>
          <Filter size={15} /> Segments
        </Button>
        {canManage && (
          <>
            <Button variant="secondary" onClick={() => setCsvOpen(true)}>
              <Upload size={15} /> Import
            </Button>
            <Button variant="secondary" onClick={doExport} loading={exporting}>
              <Download size={15} /> Export
            </Button>
          </>
        )}
        <Button
          onClick={() => {
            setEditTarget(null);
            setFormOpen(true);
          }}
        >
          <Plus size={15} /> New contact
        </Button>
      </div>

      {canManage && dupCount > 0 && !q?.deleted && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span>
            <strong>{dupCount} possible duplicate{dupCount === 1 ? '' : 's'}</strong> — the same number saved more than
            once.
          </span>
          <Link href="/contacts/duplicates" className="font-semibold underline underline-offset-2">
            Review and merge
          </Link>
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 rounded-xl border border-line bg-surface p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[14rem]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="contact-search" className="sr-only">
              Search contacts
            </label>
            <input
              id="contact-search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search name, email or number (any format)…"
              className="w-full h-9 rounded-lg border border-line bg-sunken pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="inline-flex rounded-lg border border-line overflow-hidden" role="group" aria-label="Status">
            {([['', 'All'], ['active', 'Active'], ['blocked', 'Blocked'], ['archived', 'Archived']] as const).map(
              ([v, l]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={(q?.status ?? '') === v}
                  onClick={() => update({ status: (v || undefined) as ContactStatus | undefined })}
                  className={cn(
                    'h-9 px-3 text-xs font-semibold',
                    (q?.status ?? '') === v ? 'bg-ink text-surface' : 'bg-surface text-muted hover:bg-sunken',
                  )}
                >
                  {l}
                </button>
              ),
            )}
          </div>
          <label htmlFor="contact-sort" className="sr-only">
            Sort
          </label>
          <select
            id="contact-sort"
            value={`${q?.sort ?? 'last_message_at'}:${q?.dir ?? 'desc'}`}
            onChange={(e) => {
              const [sort, dir] = e.target.value.split(':') as [ContactListQuery['sort'], 'asc' | 'desc'];
              update({ sort, dir });
            }}
            className={selectCls}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="contact-tag-add" className="sr-only">
            Filter by tag
          </label>
          <select
            id="contact-tag-add"
            value=""
            onChange={(e) => {
              const t = e.target.value;
              if (t && !(q?.tags ?? []).includes(t)) update({ tags: [...(q?.tags ?? []), t] });
            }}
            className={selectCls}
          >
            <option value="">+ Tag</option>
            {tagOptions
              .filter((t) => !(q?.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase()))
              .map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
          </select>
          <label htmlFor="contact-segment" className="sr-only">
            Segment
          </label>
          <select
            id="contact-segment"
            value={q?.segmentId ?? ''}
            onChange={(e) => update({ segmentId: e.target.value ? Number(e.target.value) : undefined })}
            className={selectCls}
          >
            <option value="">Any segment</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label htmlFor="contact-activity" className="sr-only">
            Activity
          </label>
          <select
            id="contact-activity"
            value={act === 'custom' ? '' : act}
            onChange={(e) => update(applyActivity(e.target.value))}
            className={selectCls}
          >
            {ACTIVITY.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <label htmlFor="contact-consent" className="sr-only">
            Marketing consent
          </label>
          <select
            id="contact-consent"
            value={q?.optedOut === true ? 'out' : q?.optedOut === false ? 'in' : ''}
            onChange={(e) =>
              update({ optedOut: e.target.value === 'out' ? true : e.target.value === 'in' ? false : undefined })
            }
            className={selectCls}
          >
            <option value="">Any consent</option>
            <option value="in">Subscribed</option>
            <option value="out">Opted out</option>
          </select>
          <label htmlFor="contact-email" className="sr-only">
            Email
          </label>
          <select
            id="contact-email"
            value={q?.hasEmail === true ? 'yes' : q?.hasEmail === false ? 'no' : ''}
            onChange={(e) =>
              update({ hasEmail: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined })
            }
            className={selectCls}
          >
            <option value="">Any email</option>
            <option value="yes">Has email</option>
            <option value="no">No email</option>
          </select>
          <label htmlFor="contact-city" className="sr-only">
            City
          </label>
          <input
            id="contact-city"
            value={cityDraft}
            onChange={(e) => setCityDraft(e.target.value)}
            placeholder="City"
            className={cn(selectCls, 'w-32')}
          />
          {canManage && (
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted ml-1">
              <input
                type="checkbox"
                checked={!!q?.deleted}
                onChange={(e) => update({ deleted: e.target.checked || undefined })}
                className="accent-brand-600"
              />
              Show deleted
            </label>
          )}
          {(filtered || searchDraft) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchDraft('');
                setCityDraft('');
                setQ((cur) => ({ limit: cur?.limit, sort: cur?.sort, dir: cur?.dir, page: 1 }));
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              <X size={13} /> Clear filters
            </Button>
          )}
        </div>

        {((q?.tags?.length ?? 0) > 0 || activeSeg || act === 'custom') && (
          <div className="flex flex-wrap items-center gap-1.5">
            {(q?.tags?.length ?? 0) > 1 && (
              <div className="inline-flex rounded-full border border-line overflow-hidden text-xs" role="group" aria-label="Tag match">
                {(['all', 'any'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={(q?.tagMode ?? 'all') === m}
                    onClick={() => update({ tagMode: m === 'any' ? 'any' : undefined })}
                    className={cn(
                      'px-2.5 py-0.5 font-semibold',
                      (q?.tagMode ?? 'all') === m ? 'bg-ink text-surface' : 'text-muted',
                    )}
                  >
                    {m === 'all' ? 'Has all' : 'Has any'}
                  </button>
                ))}
              </div>
            )}
            {q?.tags?.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 border border-brand-200 px-2.5 py-0.5 text-xs font-semibold text-brand-800"
              >
                <Tag size={11} /> {t}
                <button
                  type="button"
                  onClick={() => update({ tags: q.tags!.filter((x) => x !== t) })}
                  aria-label={`Remove tag filter ${t}`}
                  className="text-brand-700 hover:text-red-600"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {activeSeg && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 border border-sky-200 px-2.5 py-0.5 text-xs font-semibold text-sky-800">
                Segment: {activeSeg.name}
                <button
                  type="button"
                  onClick={() => update({ segmentId: undefined })}
                  aria-label="Remove segment filter"
                  className="hover:text-red-600"
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {act === 'custom' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken border border-line px-2.5 py-0.5 text-xs font-semibold text-ink">
                Activity {q?.lastMessageAfter ? `from ${q.lastMessageAfter}` : ''} {q?.lastMessageBefore ? `to ${q.lastMessageBefore}` : ''}
                <button type="button" onClick={() => update(applyActivity(''))} aria-label="Remove activity filter">
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Select-all-matching banner */}
      {pageAllSelected && total > rows.length && (
        <div className="mb-2 rounded-lg bg-brand-50 border border-brand-200 px-3 py-2 text-sm text-brand-900 text-center">
          {allMatching ? (
            <>
              All <strong>{total.toLocaleString()}</strong> matching contacts are selected.{' '}
              <button type="button" className="font-semibold underline" onClick={() => setAllMatching(false)}>
                Select only this page
              </button>
            </>
          ) : (
            <>
              {rows.length} on this page selected.{' '}
              <button type="button" className="font-semibold underline" onClick={() => setAllMatching(true)}>
                Select all {total.toLocaleString()} matching
              </button>
            </>
          )}
        </div>
      )}

      {loadError && !loading && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn’t refresh the list.
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        rowLabel={(c) => c.name}
        loading={loading && !rows.length}
        selectable={canManage}
        selectedKeys={selected}
        onSelectedKeysChange={(s) => {
          setSelected(s);
          if (allMatching && s.size < rows.length) setAllMatching(false);
        }}
        sortState={sortState}
        onSortChange={(s) =>
          update(s ? { sort: s.key as ContactListQuery['sort'], dir: s.dir } : { sort: undefined, dir: undefined })
        }
        onRowClick={(c) => {
          if (!c.deleted_at) router.push(`/contacts/${c.id}`);
        }}
        empty={{
          icon: Users,
          title: filtered ? 'No contacts match these filters' : q?.deleted ? 'No deleted contacts' : 'No contacts yet',
          description: filtered
            ? 'Try removing a filter or searching a shorter part of the number.'
            : 'Contacts appear automatically when customers message you. You can also add or import them.',
          action: filtered ? undefined : canManage ? (
            <Button size="sm" onClick={() => setCsvOpen(true)}>
              <Upload size={14} /> Import contacts
            </Button>
          ) : undefined,
        }}
      />

      {/* Pagination */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span className="tabular-nums">
          {total > 0
            ? `${((page - 1) * limit + 1).toLocaleString()}–${Math.min(page * limit, total).toLocaleString()} of ${total.toLocaleString()}`
            : ''}
        </span>
        <div className="flex items-center gap-2">
          <label htmlFor="page-size" className="sr-only">
            Rows per page
          </label>
          <select
            id="page-size"
            value={limit}
            onChange={(e) => update({ limit: Number(e.target.value) })}
            className={selectCls}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => update({ page: page - 1 }, true)}>
            Previous
          </Button>
          <span className="tabular-nums">
            {page} / {pages}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => update({ page: page + 1 }, true)}>
            Next
          </Button>
        </div>
      </div>

      {/* Bulk bar */}
      {canManage && selectionCount > 0 && (
        <div className="fixed inset-x-0 bottom-20 md:bottom-5 z-30 flex justify-center px-3 pointer-events-none">
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-2xl">
            <span className="px-1 font-semibold tabular-nums">{selectionCount.toLocaleString()} selected</span>
            <span className="h-5 w-px bg-white/20" />
            {q?.deleted ? (
              <BulkBtn onClick={() => void runBulk('restore')} disabled={bulkBusy}>
                <RotateCcw size={13} /> Restore
              </BulkBtn>
            ) : (
              <>
                <BulkBtn
                  primary
                  onClick={() => {
                    setTagDialogTags([]);
                    setTagDialog('tag_add');
                  }}
                  disabled={bulkBusy}
                >
                  <Tag size={13} /> Add tag
                </BulkBtn>
                <BulkBtn
                  onClick={() => {
                    setTagDialogTags([]);
                    setTagDialog('tag_remove');
                  }}
                  disabled={bulkBusy}
                >
                  Remove tag
                </BulkBtn>
                {!allMatching && selectedIds.length <= 500 && (
                  <BulkBtn onClick={() => router.push(`/broadcasts/new?contacts=${selectedIds.join(',')}`)}>
                    <Megaphone size={13} /> Broadcast
                  </BulkBtn>
                )}
                <BulkBtn
                  onClick={() =>
                    setConfirm({
                      action: 'opt_out',
                      title: 'Opt out of broadcasts?',
                      message: `${selectionCount.toLocaleString()} contacts will stop receiving broadcasts. You can still chat with them.`,
                      label: 'Opt out',
                    })
                  }
                  disabled={bulkBusy}
                >
                  Opt out
                </BulkBtn>
                <BulkBtn
                  onClick={() =>
                    setConfirm({
                      action: 'status',
                      status: 'blocked',
                      title: 'Block contacts?',
                      message: `${selectionCount.toLocaleString()} contacts will be blocked: their messages are stored but raise no alerts, and you can’t message them.`,
                      label: 'Block',
                    })
                  }
                  disabled={bulkBusy}
                >
                  <Ban size={13} /> Block
                </BulkBtn>
                <BulkBtn
                  danger
                  onClick={() =>
                    setConfirm({
                      action: 'delete',
                      title: 'Delete contacts?',
                      message: `${selectionCount.toLocaleString()} contacts will be removed from the list. Their chat history is kept and they can be restored.`,
                      label: 'Delete',
                    })
                  }
                  disabled={bulkBusy}
                >
                  <Trash2 size={13} /> Delete
                </BulkBtn>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
              aria-label="Clear selection"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      <Modal
        open={!!tagDialog}
        onClose={() => setTagDialog(null)}
        title={tagDialog === 'tag_add' ? 'Add tags' : 'Remove tags'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTagDialog(null)}>
              Cancel
            </Button>
            <Button
              loading={bulkBusy}
              disabled={!tagDialogTags.length}
              onClick={() => void runBulk(tagDialog!, { tags: tagDialogTags })}
            >
              {tagDialog === 'tag_add' ? 'Add' : 'Remove'} on {selectionCount.toLocaleString()} contacts
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted mb-3">Type a tag and press Enter. Existing tags are suggested.</p>
        <TagEditor tags={tagDialogTags} onChange={setTagDialogTags} suggestions={tagOptions} />
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.label}
        danger={confirm?.action === 'delete' || confirm?.action === 'status'}
        busy={bulkBusy}
        onConfirm={() => confirm && void runBulk(confirm.action, confirm.status ? { status: confirm.status } : {})}
        onCancel={() => setConfirm(null)}
      />

      <ContactFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        contact={editTarget}
        canEditPhone={canManage}
        tagSuggestions={tagOptions}
        onSaved={(saved) => {
          setFormOpen(false);
          void load(true);
          loadMeta();
          if (!editTarget && saved) router.push(`/contacts/${saved.id}`);
        }}
      />
      <CsvImportModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        onImported={() => {
          void load(true);
          loadMeta();
          if (canManage) listDuplicates().then((d) => setDupCount(d.total)).catch(() => undefined);
        }}
      />
      <SegmentsDrawer
        open={segOpen}
        onClose={() => setSegOpen(false)}
        onChanged={loadMeta}
        canManage={canManage}
        tagSuggestions={tagOptions}
        onApply={(id) => {
          setSegOpen(false);
          update({ segmentId: id });
        }}
      />
      <ConfirmDialog
        open={!!delTarget}
        title="Delete contact?"
        message={`${delTarget?.name ?? ''} will be removed from the list. Their chat history is kept and you can restore them from “Show deleted”.`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  );
}

function BulkBtn({
  children,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold disabled:opacity-50',
        primary ? 'bg-brand-600 hover:bg-brand-700' : danger ? 'text-red-300 hover:bg-white/10' : 'hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}
