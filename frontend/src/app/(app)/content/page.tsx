'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Clapperboard,
  Plus,
  Play,
  ImageIcon,
  HardDrive,
  CheckCircle2,
  Loader2,
  X,
  LayoutGrid,
  List as ListIcon,
  ChevronDown,
  Folder,
  Megaphone,
  Video,
  Eye,
  Paperclip,
} from 'lucide-react';
import { ContentMediaViewer } from '@/components/content/media-viewer';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  ContentItem,
  ContentStats,
  ContentStatus,
  ContentCollection,
  CollectionKind,
  DriveStatus,
  STATUS_META,
  driveThumbUrl,
  listContent,
  getContentStats,
  getDriveStatus,
  getDriveConnectUrl,
  uploadContent,
  planContentBulk,
  listAssignees,
  listCollections,
  createCollection,
  attachReference,
  PlanInput,
  Assignee,
} from '@/lib/content';

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'planned', label: 'Planned' },
  { key: 'uploaded', label: 'Uploaded' },
  { key: 'in_review', label: 'In review' },
  { key: 'needs_changes', label: 'Needs changes' },
  { key: 'approved', label: 'Approved' },
  { key: 'published', label: 'Published' },
  { key: 'rejected', label: 'Rejected' },
];

// Palette offered when creating a campaign (the accordion swatch colour).
const CAMPAIGN_COLORS = [
  '#7c3aed', '#0ea5a3', '#db2777', '#ea580c', '#2563eb', '#65a30d', '#9333ea', '#dc2626',
];

const DRIVE_ROOT = 'CodesApp Content';

export default function ContentPage() {
  const { user } = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const canManageDrive = user?.role === 'owner' || user?.role === 'admin';
  // Managers plan/assign/upload-new; uploaders only attach media to their tasks.
  const canManage =
    user?.role === 'owner' ||
    user?.role === 'admin' ||
    user?.role === 'creative_executive' ||
    user?.role === 'content_manager';

  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState<ContentItem[]>([]);
  const [collections, setCollections] = useState<ContentCollection[]>([]);
  const [stats, setStats] = useState<ContentStats | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planPreset, setPlanPreset] = useState<number | null>(null);
  const [campaignModal, setCampaignModal] = useState<CollectionKind | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');

  // Remember the preferred view per browser.
  useEffect(() => {
    try {
      const v = localStorage.getItem('content_view');
      if (v === 'list' || v === 'grid') setView(v);
    } catch {
      /* ignore */
    }
  }, []);
  const changeView = (v: 'grid' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('content_view', v);
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, st, cols] = await Promise.all([
        listContent(filter),
        getContentStats(),
        listCollections(),
      ]);
      setItems(list);
      setStats(st);
      setCollections(cols);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load content');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Load the assignable team (uploaders + execs) for the task pickers.
  useEffect(() => {
    if (!canManage) return;
    listAssignees().then(setAssignees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  // Drive status + the OAuth redirect toast (?drive=connected|error|denied).
  useEffect(() => {
    if (!canManageDrive) return;
    getDriveStatus().then(setDrive).catch(() => {});
    const d = params.get('drive');
    if (d === 'connected') toast.success('Google Drive connected');
    else if (d === 'error') toast.error('Could not connect Google Drive');
    else if (d === 'denied') toast.info('Google Drive connection was cancelled');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageDrive]);

  const connectDrive = async () => {
    try {
      const { url } = await getDriveConnectUrl();
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Drive is not available');
    }
  };

  const driveReady = drive?.connected ?? true; // non-admins: assume ready

  const openPlan = (collectionId?: number) => {
    setPlanPreset(collectionId ?? null);
    setPlanOpen(true);
  };

  // A collection created from a modal is merged in locally so pickers see it
  // at once; the board refreshes fully when the plan/upload completes.
  const addCollection = (c: ContentCollection) =>
    setCollections((prev) => [...prev, c]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Clapperboard className="text-violet-600" />
          <h1 className="text-xl font-semibold">Content</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/content/calendar"
            className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
          >
            Calendar
          </Link>
          {canManage && (
            <>
              <button
                onClick={() => openPlan()}
                className="px-3 py-2 text-sm rounded-lg border border-violet-300 text-violet-700 font-medium hover:bg-violet-50 flex items-center gap-1.5"
              >
                <Plus size={16} /> Plan content
              </button>
              <button
                onClick={() => setUploadOpen(true)}
                disabled={!driveReady}
                title={driveReady ? '' : 'Connect Google Drive first'}
                className="px-3 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Plus size={16} /> Upload
              </button>
            </>
          )}
        </div>
      </div>

      {/* Drive connection banner (owner/admin) */}
      {canManageDrive && drive && !drive.connected && (
        <div className="mb-5 rounded-xl border border-violet-200 bg-violet-50 p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <HardDrive className="text-violet-600 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-violet-900">Connect Google Drive</p>
              <p className="text-violet-700">
                Content is stored in your own Google Drive — nothing is kept on our servers.
              </p>
            </div>
          </div>
          <button
            onClick={connectDrive}
            className="px-3 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 shrink-0"
          >
            Connect
          </button>
        </div>
      )}
      {canManageDrive && drive?.connected && (
        <p className="mb-4 text-xs text-gray-500 flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-green-600" />
          Google Drive connected{drive.email ? ` · ${drive.email}` : ''}
        </p>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Planned" value={stats.byStatus['planned'] ?? 0} />
          <StatCard label="In review" value={stats.byStatus['in_review'] ?? 0} />
          <StatCard label="Overdue" value={stats.overdue} danger={stats.overdue > 0} />
        </div>
      )}

      {/* Filters + view toggle */}
      <div className="flex items-center gap-2 mb-4">
      <div className="flex gap-1.5 overflow-x-auto pb-1 flex-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm rounded-full whitespace-nowrap ${
              filter === f.key
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
        <div className="flex items-center rounded-lg border border-gray-300 overflow-hidden shrink-0">
          <button
            onClick={() => changeView('grid')}
            title="Grid view"
            className={`p-1.5 ${view === 'grid' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => changeView('list')}
            title="List view"
            className={`p-1.5 ${view === 'list' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            <ListIcon size={16} />
          </button>
        </div>
      </div>

      {/* Board */}
      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <Board
          items={items}
          collections={collections}
          assignees={assignees}
          view={view}
          canManage={canManage}
          onNewCampaign={() => setCampaignModal('campaign')}
          onPlanInto={openPlan}
        />
      )}

      {uploadOpen && (
        <UploadModal
          assignees={assignees}
          collections={collections}
          onCollectionCreated={addCollection}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            load();
          }}
        />
      )}
      {planOpen && (
        <PlanModal
          assignees={assignees}
          collections={collections}
          presetCollectionId={planPreset}
          onCollectionCreated={addCollection}
          onClose={() => setPlanOpen(false)}
          onDone={() => {
            setPlanOpen(false);
            load();
          }}
        />
      )}
      {campaignModal && (
        <CollectionModal
          kind={campaignModal}
          onClose={() => setCampaignModal(null)}
          onDone={() => {
            setCampaignModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Board: campaign accordions + standalone grid/list ────────────────────────
function Board({
  items,
  collections,
  assignees,
  view,
  canManage,
  onNewCampaign,
  onPlanInto,
}: {
  items: ContentItem[];
  collections: ContentCollection[];
  assignees: Assignee[];
  view: 'grid' | 'list';
  canManage: boolean;
  onNewCampaign: () => void;
  onPlanInto: (collectionId?: number) => void;
}) {
  const campaigns = useMemo(
    () => collections.filter((c) => c.kind === 'campaign' && c.status === 'active'),
    [collections],
  );
  const folderById = useMemo(() => {
    const m = new Map<number, ContentCollection>();
    collections.forEach((c) => {
      if (c.kind === 'folder') m.set(c.id, c);
    });
    return m;
  }, [collections]);

  const itemsByCampaign = useMemo(() => {
    const m = new Map<number, ContentItem[]>();
    items.forEach((it) => {
      if (it.collection_id && campaigns.some((c) => c.id === it.collection_id)) {
        const arr = m.get(it.collection_id) ?? [];
        arr.push(it);
        m.set(it.collection_id, arr);
      }
    });
    return m;
  }, [items, campaigns]);

  // Standalone = no collection, or filed under a folder (folders don't group).
  const standalone = useMemo(
    () =>
      items.filter(
        (it) => !it.collection_id || folderById.has(it.collection_id),
      ),
    [items, folderById],
  );

  const folderName = (it: ContentItem) =>
    it.collection_id ? folderById.get(it.collection_id)?.name ?? null : null;

  // Accordion open-state, default all campaigns open.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && campaigns.length) {
      setOpen(new Set(campaigns.map((c) => c.id)));
      setSeeded(true);
    }
  }, [campaigns, seeded]);
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const visibleCampaigns = campaigns.filter(
    (c) => canManage || (itemsByCampaign.get(c.id)?.length ?? 0) > 0,
  );

  const nothing =
    items.length === 0 && visibleCampaigns.length === 0;
  if (nothing) {
    return (
      <div className="text-center py-16 text-gray-500">
        <Clapperboard className="mx-auto mb-3 text-gray-300" size={40} />
        <p>No content yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {(visibleCampaigns.length > 0 || canManage) && (
        <section>
          <SectionLabel>
            Campaigns
            {canManage && (
              <button
                onClick={onNewCampaign}
                className="ml-auto px-2.5 py-1 text-[11.5px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium flex items-center gap-1"
              >
                <Plus size={13} /> New campaign
              </button>
            )}
          </SectionLabel>
          {visibleCampaigns.length === 0 ? (
            <p className="text-sm text-gray-400">
              No campaigns yet. Create one to group a set of posts under a single
              Google Drive folder.
            </p>
          ) : (
            <div className="space-y-3">
              {visibleCampaigns.map((c) => {
                const its = itemsByCampaign.get(c.id) ?? [];
                const produced = its.filter((i) => i.drive_file_id).length;
                const pct = its.length ? Math.round((produced / its.length) * 100) : 0;
                const isOpen = open.has(c.id);
                return (
                  <div
                    key={c.id}
                    className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
                  >
                    <button
                      onClick={() => toggle(c.id)}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50/70"
                    >
                      <span
                        className="w-2.5 h-9 rounded-md shrink-0"
                        style={{ background: c.color ?? '#7c3aed' }}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="font-semibold tracking-tight flex items-center gap-2 flex-wrap">
                          {c.name}
                          <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                            <Folder size={11} /> Drive folder
                          </span>
                        </span>
                        <span className="mt-0.5 text-xs text-gray-500 flex gap-3 flex-wrap">
                          <span>{its.length} item{its.length === 1 ? '' : 's'}</span>
                          {c.launch_date && <span>Launches {fmtDate(c.launch_date)}</span>}
                        </span>
                      </span>
                      <span className="hidden sm:block w-28 shrink-0">
                        <span className="block h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <span
                            className="block h-full rounded-full bg-violet-500"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="mt-1 block text-[11px] text-gray-500 tabular-nums">
                          {produced} of {its.length} produced
                        </span>
                      </span>
                      <ChevronDown
                        size={18}
                        className={`text-gray-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 border-t border-gray-100">
                        {its.length === 0 ? (
                          <div className="py-6 text-center">
                            {canManage ? (
                              <button
                                onClick={() => onPlanInto(c.id)}
                                className="text-sm text-violet-600 hover:text-violet-700 font-medium inline-flex items-center gap-1.5"
                              >
                                <Plus size={15} /> Plan into this campaign
                              </button>
                            ) : (
                              <p className="text-sm text-gray-400">Nothing here yet.</p>
                            )}
                          </div>
                        ) : view === 'grid' ? (
                          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                            {its.map((it) => (
                              <ContentCard key={it.id} item={it} />
                            ))}
                            {canManage && (
                              <button
                                onClick={() => onPlanInto(c.id)}
                                className="rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/60 text-gray-500 hover:border-violet-300 hover:text-violet-600 flex flex-col items-center justify-center gap-1.5 text-xs font-medium min-h-[120px]"
                              >
                                <Plus size={18} /> Plan into campaign
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="mt-4">
                            <ContentList items={its} assignees={assignees} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section>
        {(visibleCampaigns.length > 0 || canManage) && (
          <SectionLabel>Standalone</SectionLabel>
        )}
        {standalone.length === 0 ? (
          <p className="text-sm text-gray-400">No standalone content.</p>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {standalone.map((it) => (
              <ContentCard key={it.id} item={it} folderName={folderName(it)} />
            ))}
          </div>
        ) : (
          <ContentList
            items={standalone}
            assignees={assignees}
            folderName={folderName}
          />
        )}
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
        {children}
      </span>
    </div>
  );
}

function ContentList({
  items,
  assignees,
  folderName,
}: {
  items: ContentItem[];
  assignees: Assignee[];
  folderName?: (it: ContentItem) => string | null;
}) {
  const nameOf = (uid: number | null) =>
    uid ? assignees.find((a) => a.id === uid)?.name ?? '—' : '—';
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 text-xs">
          <tr>
            <th className="text-left font-medium px-3 py-2">Title</th>
            <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">Platform</th>
            <th className="text-left font-medium px-3 py-2">Status</th>
            <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Assignee</th>
            <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">Scheduled</th>
            <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Deadline</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const meta = STATUS_META[it.status as ContentStatus] ?? STATUS_META.uploaded;
            const overdue =
              it.deadline && new Date(it.deadline) < new Date() && it.status !== 'published';
            const fn = folderName?.(it) ?? null;
            return (
              <tr key={it.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link href={`/content/${it.id}`} className="flex items-center gap-2">
                    <span className="w-9 h-9 rounded bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center">
                      {it.drive_file_id ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={driveThumbUrl(it.drive_file_id, 96)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon size={14} className="text-gray-300" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-gray-800 truncate max-w-[220px] block">{it.title}</span>
                      {fn && (
                        <span className="text-[11px] text-gray-400 flex items-center gap-1">
                          <Folder size={10} /> {fn}
                        </span>
                      )}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2 text-gray-500 capitalize hidden sm:table-cell">{it.platform ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
                </td>
                <td className="px-3 py-2 text-gray-500 hidden md:table-cell">{nameOf(it.assignee_user_id)}</td>
                <td className="px-3 py-2 text-gray-500 hidden sm:table-cell">
                  {it.scheduled_publish_at ? fmtDate(it.scheduled_publish_at) : '—'}
                </td>
                <td className={`px-3 py-2 hidden md:table-cell ${overdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                  {it.deadline ? fmtDate(it.deadline) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <p className={`text-2xl font-semibold ${danger ? 'text-red-600' : ''}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function ContentCard({
  item,
  folderName,
}: {
  item: ContentItem;
  folderName?: string | null;
}) {
  const meta = STATUS_META[item.status as ContentStatus] ?? STATUS_META.uploaded;
  const [viewRef, setViewRef] = useState(false);
  const hasRef = !!item.reference_drive_file_id;
  // Expected format badge: only meaningful before the real media is uploaded.
  const expected = !item.drive_file_id ? item.planned_media_type : null;
  return (
    <Link
      href={`/content/${item.id}`}
      className="group rounded-xl border border-gray-200 bg-white overflow-hidden hover:shadow-md transition-shadow"
    >
      <div className="relative aspect-square bg-gray-100">
        {item.drive_file_id ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={driveThumbUrl(item.drive_file_id)}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-300 gap-1">
            <ImageIcon size={32} />
            <span className="text-[11px] text-gray-400">No media yet</span>
          </div>
        )}
        {folderName && (
          <span className="absolute top-1.5 left-1.5 text-[10px] font-semibold text-white bg-black/55 backdrop-blur-sm px-1.5 py-0.5 rounded inline-flex items-center gap-1 max-w-[85%]">
            <Folder size={10} className="shrink-0" />
            <span className="truncate">{folderName}</span>
          </span>
        )}
        {expected && (
          <span className="absolute top-1.5 right-1.5 text-[10px] font-semibold text-white bg-violet-600/85 backdrop-blur-sm px-1.5 py-0.5 rounded inline-flex items-center gap-1 capitalize">
            {expected === 'video' ? <Video size={10} /> : <ImageIcon size={10} />}
            {expected}
          </span>
        )}
        {item.media_type === 'video' && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="bg-black/50 rounded-full p-2">
              <Play className="text-white" size={20} fill="white" />
            </span>
          </span>
        )}
        {/* Reference as a tile-inside-tile — the brief visual, click to view. */}
        {hasRef && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setViewRef(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setViewRef(true);
              }
            }}
            title="View reference"
            className="absolute bottom-1.5 right-1.5 w-[42%] max-w-[88px] aspect-square rounded-md overflow-hidden ring-2 ring-white shadow-md bg-black/10 group/ref cursor-pointer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={driveThumbUrl(item.reference_drive_file_id!, 240)}
              alt="Reference"
              className="w-full h-full object-cover"
              loading="lazy"
            />
            <span className="absolute top-0.5 left-0.5 text-[8.5px] font-bold uppercase tracking-wide text-white bg-black/60 px-1 py-px rounded">
              Ref
            </span>
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/ref:bg-black/35 transition">
              <Eye size={16} className="text-white opacity-0 group-hover/ref:opacity-100 transition" />
            </span>
          </span>
        )}
        {viewRef && item.reference_drive_file_id && (
          <span
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <ContentMediaViewer
              fileId={item.reference_drive_file_id}
              mediaType={item.reference_media_type}
              onClose={() => setViewRef(false)}
            />
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-sm font-medium truncate">{item.title}</p>
        {item.platform && (
          <p className="text-[11px] text-gray-400 capitalize truncate">
            {item.platform}
          </p>
        )}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${meta.cls}`}>
            {meta.label}
          </span>
          {item.scheduled_publish_at && (
            <span className="text-[11px] text-gray-400">
              {fmtDate(item.scheduled_publish_at)}
            </span>
          )}
        </div>
        {item.deadline && item.status !== 'published' && (
          <p
            className={`mt-1 text-[11px] ${
              new Date(item.deadline) < new Date()
                ? 'text-red-600 font-medium'
                : 'text-gray-400'
            }`}
          >
            Due {fmtDate(item.deadline)}
          </p>
        )}
      </div>
    </Link>
  );
}

// ─── Destination picker (campaign / folder / Drive root) ──────────────────────
function DestinationPicker({
  collections,
  value,
  onChange,
  onCollectionCreated,
}: {
  collections: ContentCollection[];
  value: number | null;
  onChange: (id: number | null) => void;
  onCollectionCreated: (c: ContentCollection) => void;
}) {
  const toast = useToast();
  const campaigns = collections.filter((c) => c.kind === 'campaign' && c.status === 'active');
  const folders = collections.filter((c) => c.kind === 'folder');
  const current = collections.find((c) => c.id === value) ?? null;
  const [mode, setMode] = useState<'none' | 'campaign' | 'folder'>(
    current ? current.kind : 'none',
  );

  // Inline "New" create.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const pickMode = (m: 'none' | 'campaign' | 'folder') => {
    setMode(m);
    setCreating(false);
    if (m === 'none') onChange(null);
    else {
      const list = m === 'campaign' ? campaigns : folders;
      onChange(list[0]?.id ?? null); // null → the select shows "Choose…"
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const c = await createCollection({
        kind: mode === 'folder' ? 'folder' : 'campaign',
        ...(mode === 'campaign' ? { color: CAMPAIGN_COLORS[0] } : {}),
        name,
      });
      onCollectionCreated(c);
      onChange(c.id);
      setCreating(false);
      setNewName('');
      toast.success(`${mode === 'folder' ? 'Folder' : 'Campaign'} created`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not create');
    } finally {
      setBusy(false);
    }
  };

  const list = mode === 'campaign' ? campaigns : folders;
  const destName = current?.name;
  const drivePath =
    mode === 'none' || !destName
      ? `${DRIVE_ROOT} /`
      : `${DRIVE_ROOT} / ${destName} /`;

  const seg = (m: 'none' | 'campaign' | 'folder', icon: React.ReactNode, title: string, sub: string) => (
    <button
      type="button"
      onClick={() => pickMode(m)}
      className={`rounded-lg border p-2.5 text-left transition ${
        mode === m
          ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500'
          : 'border-gray-300 hover:border-violet-300'
      }`}
    >
      <span className={`text-xs font-bold flex items-center gap-1.5 ${mode === m ? 'text-violet-700' : 'text-gray-700'}`}>
        {icon} {title}
      </span>
      <span className="text-[10.5px] text-gray-400 block mt-0.5">{sub}</span>
    </button>
  );

  return (
    <div>
      <span className="text-xs font-medium text-gray-600">File under</span>
      <div className="mt-1.5 grid grid-cols-3 gap-2">
        {seg('none', <HardDrive size={14} />, 'Drive root', 'No campaign')}
        {seg('campaign', <Megaphone size={14} />, 'Campaign', 'Grouped + folder')}
        {seg('folder', <Folder size={14} />, 'Folder', 'File only')}
      </div>

      {mode !== 'none' && (
        <div className="mt-2.5">
          {creating ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                placeholder={mode === 'folder' ? 'Folder name' : 'Campaign name'}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={create}
                disabled={busy || !newName.trim()}
                className="px-3 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {busy && <Loader2 size={14} className="animate-spin" />} Create
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="px-2 text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <select
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {list.length === 0 && <option value="">None yet — create one →</option>}
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setNewName('');
                }}
                className="whitespace-nowrap border border-dashed border-violet-300 text-violet-600 bg-violet-50 rounded-lg px-3 py-2 text-sm font-medium hover:bg-violet-100 flex items-center gap-1.5"
              >
                <Plus size={14} /> New
              </button>
            </div>
          )}
        </div>
      )}

      <p className="mt-2 text-[11px] text-gray-400 font-mono flex items-center gap-1.5">
        <Folder size={12} className="text-violet-500" />
        Uploads to <span className="text-gray-600 font-semibold not-italic">{drivePath}</span>
      </p>
    </div>
  );
}

function UploadModal({
  assignees,
  collections,
  onCollectionCreated,
  onClose,
  onDone,
}: {
  assignees: Assignee[];
  collections: ContentCollection[];
  onCollectionCreated: (c: ContentCollection) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) return toast.error('Choose an image or video');
    if (!title.trim()) return toast.error('A title is required');
    setBusy(true);
    try {
      await uploadContent(file, {
        title: title.trim(),
        caption: caption.trim() || undefined,
        scheduledPublishAt: scheduledAt
          ? new Date(scheduledAt).toISOString()
          : undefined,
        assigneeUserId: assigneeId ? Number(assigneeId) : undefined,
        collectionId: collectionId ?? undefined,
      });
      toast.success('Uploaded to Google Drive');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Upload content"
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
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Upload
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-300 rounded-lg py-6 text-sm text-gray-500 hover:border-violet-400 hover:text-violet-600"
          >
            {file ? file.name : 'Choose an image or video (max 150MB)'}
          </button>
        </div>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="e.g. Eid campaign reel"
          />
        </Field>
        <DestinationPicker
          collections={collections}
          value={collectionId}
          onChange={setCollectionId}
          onCollectionCreated={onCollectionCreated}
        />
        <Field label="Caption / notes (optional)">
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Planned publish date (optional)">
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Assign to (optional)">
          <AssigneeSelect
            assignees={assignees}
            value={assigneeId}
            onChange={setAssigneeId}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Shared assignee <select> used in the plan/upload modals. */
function AssigneeSelect({
  assignees,
  value,
  onChange,
}: {
  assignees: Assignee[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
    >
      <option value="">Unassigned</option>
      {assignees.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.role.replace('_', ' ')})
        </option>
      ))}
    </select>
  );
}

interface PlanRow {
  title: string;
  platform: string;
  caption: string;
  scheduledAt: string;
  deadline: string;
  assigneeId: string;
  format: '' | 'image' | 'video';
  referenceFile: File | null;
}
const emptyRow = (): PlanRow => ({
  title: '',
  platform: '',
  caption: '',
  scheduledAt: '',
  deadline: '',
  assigneeId: '',
  format: '',
  referenceFile: null,
});

function PlanModal({
  assignees,
  collections,
  presetCollectionId,
  onCollectionCreated,
  onClose,
  onDone,
}: {
  assignees: Assignee[];
  collections: ContentCollection[];
  presetCollectionId: number | null;
  onCollectionCreated: (c: ContentCollection) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<PlanRow[]>([emptyRow()]);
  const [collectionId, setCollectionId] = useState<number | null>(presetCollectionId);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<PlanRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const submit = async () => {
    const filled = rows.filter((r) => r.title.trim());
    if (filled.length === 0) return toast.error('Add at least one title');
    setBusy(true);
    try {
      const items: PlanInput[] = filled.map((r) => ({
        title: r.title.trim(),
        caption: r.caption.trim() || undefined,
        platform: r.platform.trim() || undefined,
        scheduledPublishAt: r.scheduledAt
          ? new Date(r.scheduledAt).toISOString()
          : undefined,
        deadline: r.deadline ? new Date(r.deadline).toISOString() : undefined,
        assigneeUserId: r.assigneeId ? Number(r.assigneeId) : undefined,
        collectionId: collectionId ?? undefined,
        plannedMediaType: r.format || undefined,
      }));
      const res = await planContentBulk(items);
      // Attach each row's reference to its just-created item (same order).
      const refJobs = filled
        .map((r, i) => ({ file: r.referenceFile, id: res.items[i]?.id }))
        .filter((j) => j.file && j.id);
      if (refJobs.length) {
        const results = await Promise.allSettled(
          refJobs.map((j) => attachReference(j.id!, j.file!)),
        );
        const failed = results.filter((x) => x.status === 'rejected').length;
        if (failed) toast.error(`${failed} reference${failed === 1 ? '' : 's'} failed to upload`);
      }
      toast.success(`${res.count} item${res.count === 1 ? '' : 's'} added to the plan`);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to plan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Plan content"
      size="xl"
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
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Add to plan
          </button>
        </>
      }
    >
      <div className="p-4 space-y-3">
        <p className="text-xs text-gray-500">
          Plan one or several posts now and attach the video/image later — no
          file needed yet. Choose where they are filed in Google Drive; a
          content manager uploads the media against each when ready.
        </p>

        <div className="rounded-xl border border-gray-200 p-3 bg-gray-50/50">
          <DestinationPicker
            collections={collections}
            value={collectionId}
            onChange={setCollectionId}
            onCollectionCreated={onCollectionCreated}
          />
        </div>

        <div className="space-y-3">
          {rows.map((r, i) => (
            <div
              key={i}
              className="rounded-xl border border-gray-200 p-3 relative"
            >
              {rows.length > 1 && (
                <button
                  onClick={() => removeRow(i)}
                  className="absolute top-2 right-2 text-gray-400 hover:text-red-500"
                  title="Remove"
                >
                  <X size={15} />
                </button>
              )}
              <div className="grid sm:grid-cols-2 gap-2.5">
                <label className="block sm:col-span-2">
                  <span className="text-[11px] font-medium text-gray-500">Title / idea</span>
                  <input
                    value={r.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                    placeholder="e.g. Unboxing reel"
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Platform</span>
                  <input
                    value={r.platform}
                    onChange={(e) => update(i, { platform: e.target.value })}
                    list="content-platforms"
                    placeholder="Instagram, TikTok…"
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Planned publish</span>
                  <input
                    type="datetime-local"
                    value={r.scheduledAt}
                    onChange={(e) => update(i, { scheduledAt: e.target.value })}
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Deadline</span>
                  <input
                    type="datetime-local"
                    value={r.deadline}
                    onChange={(e) => update(i, { deadline: e.target.value })}
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Assign to</span>
                  <AssigneeSelect
                    assignees={assignees}
                    value={r.assigneeId}
                    onChange={(v) => update(i, { assigneeId: v })}
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Format</span>
                  <div className="mt-0.5 flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                    {(['', 'image', 'video'] as const).map((f) => (
                      <button
                        key={f || 'any'}
                        type="button"
                        onClick={() => update(i, { format: f })}
                        className={`flex-1 px-2 py-2 flex items-center justify-center gap-1 ${
                          r.format === f
                            ? 'bg-violet-600 text-white'
                            : 'text-gray-600 hover:bg-gray-50'
                        } ${f !== '' ? 'border-l border-gray-300' : ''}`}
                      >
                        {f === 'image' && <ImageIcon size={14} />}
                        {f === 'video' && <Video size={14} />}
                        {f === '' ? 'Any' : f === 'image' ? 'Image' : 'Video'}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-500">Reference (optional)</span>
                  <ReferencePicker
                    file={r.referenceFile}
                    onPick={(f) => update(i, { referenceFile: f })}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-[11px] font-medium text-gray-500">Brief / script (optional)</span>
                  <textarea
                    value={r.caption}
                    onChange={(e) => update(i, { caption: e.target.value })}
                    rows={4}
                    placeholder={'Brief, shot list, or the full script / caption — line breaks are kept.'}
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono leading-relaxed resize-y min-h-[88px]"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={addRow}
          className="text-sm text-violet-600 hover:text-violet-700 flex items-center gap-1.5"
        >
          <Plus size={15} /> Add another
        </button>

        <datalist id="content-platforms">
          <option value="Instagram" />
          <option value="TikTok" />
          <option value="Facebook" />
          <option value="YouTube" />
          <option value="WhatsApp" />
        </datalist>
      </div>
    </Modal>
  );
}

// ─── Create a campaign / folder on its own ────────────────────────────────────
function CollectionModal({
  kind,
  onClose,
  onDone,
}: {
  kind: CollectionKind;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState(CAMPAIGN_COLORS[0]);
  const [launchDate, setLaunchDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return toast.error('A name is required');
    setBusy(true);
    try {
      await createCollection({
        kind,
        name: name.trim(),
        ...(kind === 'campaign' ? { color } : {}),
        description: description.trim() || undefined,
        launchDate:
          kind === 'campaign' && launchDate
            ? new Date(launchDate).toISOString()
            : undefined,
      });
      toast.success(`${kind === 'folder' ? 'Folder' : 'Campaign'} created`);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not create');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'folder' ? 'New folder' : 'New campaign'}
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
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Create
          </button>
        </>
      }
    >
      <div className="p-4 space-y-3">
        <p className="text-xs text-gray-500">
          A matching folder is created in your Google Drive
          {' '}(<span className="font-mono">{DRIVE_ROOT} / {name.trim() || '…'}</span>).
          {kind === 'campaign'
            ? ' Content planned under it is grouped on the board and filed here.'
            : ' Standalone content can be filed here when planning.'}
        </p>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder={kind === 'folder' ? 'e.g. Evergreen' : 'e.g. Eid Edit 2026'}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </Field>
        {kind === 'campaign' && (
          <>
            <Field label="Colour">
              <div className="flex gap-2 flex-wrap">
                {CAMPAIGN_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`w-7 h-7 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-gray-900' : ''}`}
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </Field>
            <Field label="Launch date (optional)">
              <input
                type="datetime-local"
                value={launchDate}
                onChange={(e) => setLaunchDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </Field>
          </>
        )}
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Small file picker for a plan row's reference (image/video, optional). */
function ReferencePicker({
  file,
  onPick,
}: {
  file: File | null;
  onPick: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-0.5">
      <input
        ref={ref}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <div className="flex items-center gap-2 border border-gray-300 rounded-lg px-2.5 py-2 text-sm">
          <Paperclip size={14} className="text-violet-600 shrink-0" />
          <span className="truncate flex-1" title={file.name}>{file.name}</span>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-gray-400 hover:text-red-500 shrink-0"
            title="Remove"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          className="w-full border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-500 hover:border-violet-400 hover:text-violet-600 flex items-center justify-center gap-1.5"
        >
          <Paperclip size={14} /> Attach reference
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
