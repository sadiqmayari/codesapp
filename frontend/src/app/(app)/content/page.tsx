'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  ContentItem,
  ContentStats,
  ContentStatus,
  DriveStatus,
  STATUS_META,
  driveThumbUrl,
  listContent,
  getContentStats,
  getDriveStatus,
  getDriveConnectUrl,
  uploadContent,
  planContentBulk,
  PlanInput,
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

export default function ContentPage() {
  const { user } = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const canManageDrive = user?.role === 'owner' || user?.role === 'admin';

  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState<ContentItem[]>([]);
  const [stats, setStats] = useState<ContentStats | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([listContent(filter), getContentStats()]);
      setItems(list);
      setStats(st);
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
          <button
            onClick={() => setPlanOpen(true)}
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

      {/* Filters */}
      <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
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

      {/* Grid */}
      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Clapperboard className="mx-auto mb-3 text-gray-300" size={40} />
          <p>No content yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {items.map((it) => (
            <ContentCard key={it.id} item={it} />
          ))}
        </div>
      )}

      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            load();
          }}
        />
      )}
      {planOpen && (
        <PlanModal
          onClose={() => setPlanOpen(false)}
          onDone={() => {
            setPlanOpen(false);
            load();
          }}
        />
      )}
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

function ContentCard({ item }: { item: ContentItem }) {
  const meta = STATUS_META[item.status as ContentStatus] ?? STATUS_META.uploaded;
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
        {item.media_type === 'video' && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="bg-black/50 rounded-full p-2">
              <Play className="text-white" size={20} fill="white" />
            </span>
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

function UploadModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
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
      </div>
    </Modal>
  );
}

interface PlanRow {
  title: string;
  platform: string;
  caption: string;
  scheduledAt: string;
  deadline: string;
}
const emptyRow = (): PlanRow => ({
  title: '',
  platform: '',
  caption: '',
  scheduledAt: '',
  deadline: '',
});

function PlanModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<PlanRow[]>([emptyRow()]);
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
      }));
      const res = await planContentBulk(items);
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
          file needed yet. Each appears on the calendar; a content manager uploads
          the media against it when ready. Set a <b>deadline</b> for when the task
          must be done (separate from the planned publish date).
        </p>

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
                  <span className="text-[11px] font-medium text-gray-500">Brief (optional)</span>
                  <input
                    value={r.caption}
                    onChange={(e) => update(i, { caption: e.target.value })}
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
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
