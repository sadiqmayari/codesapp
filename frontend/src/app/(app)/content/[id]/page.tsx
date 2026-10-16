'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  X,
  MessageSquareWarning,
  Trash2,
  Rocket,
  Loader2,
  Play as PlayIcon,
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import {
  ContentItem,
  ContentStatus,
  ContentEvent,
  Assignee,
  STATUS_META,
  drivePreviewUrl,
  driveThumbUrl,
  getContent,
  getContentEvents,
  listAssignees,
  assignContent,
  reviewContent,
  scheduleContent,
  publishContent,
  deleteContent,
  attachContentMedia,
  attachReference,
  removeReference,
} from '@/lib/content';

const EVENT_LABEL: Record<string, string> = {
  created: 'created',
  planned: 'planned',
  assigned: 'assigned',
  reassigned: 'reassigned',
  uploaded: 'uploaded media',
  resubmitted: 'resubmitted after changes',
  approved: 'approved',
  needs_changes: 'requested changes',
  rejected: 'rejected',
  scheduled: 'updated schedule',
  published: 'marked published',
};

export default function ContentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const itemId = Number(id);
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const canReview = user?.role === 'owner' || user?.role === 'admin';
  const canManage =
    user?.role === 'owner' ||
    user?.role === 'admin' ||
    user?.role === 'creative_executive' ||
    user?.role === 'content_manager';

  const [item, setItem] = useState<ContentItem | null>(null);
  const [events, setEvents] = useState<ContentEvent[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const refFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const it = await getContent(itemId);
      setItem(it);
      setFeedback(it.review_feedback ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Not found');
      router.replace('/content');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    listAssignees().then(setAssignees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  // Refresh the timeline whenever the item changes (load + any mutation).
  useEffect(() => {
    if (item) getContentEvents(itemId).then(setEvents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.updated_at, itemId]);

  const changeAssignee = async (value: string) => {
    setBusy(true);
    try {
      const updated = await assignContent(itemId, value ? Number(value) : null);
      setItem(updated);
      toast.success('Assignment updated');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const startPlay = () => setPlaying(true);

  const doReview = async (
    decision: 'approved' | 'needs_changes' | 'rejected',
  ) => {
    if (decision === 'needs_changes' && !feedback.trim()) {
      return toast.error('Add feedback so the content manager knows what to change');
    }
    setBusy(true);
    try {
      const updated = await reviewContent(itemId, decision, feedback.trim() || undefined);
      setItem(updated);
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doSchedule = async (
    patch: { scheduledPublishAt?: string | null; deadline?: string | null },
  ) => {
    setBusy(true);
    try {
      const updated = await scheduleContent(itemId, patch);
      setItem(updated);
      toast.success('Updated');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async () => {
    setBusy(true);
    try {
      const updated = await publishContent(itemId);
      setItem(updated);
      toast.success('Marked as published');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const onPickReference = async (f: File | null) => {
    if (!f) return;
    setUploading(true);
    try {
      const updated = await attachReference(itemId, f);
      setItem(updated);
      toast.success('Reference saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const dropReference = async () => {
    setBusy(true);
    try {
      const updated = await removeReference(itemId);
      setItem(updated);
      toast.success('Reference removed');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const onPickMedia = async (f: File | null) => {
    if (!f) return;
    setUploading(true);
    try {
      const updated = await attachContentMedia(itemId, f);
      setItem(updated);
      toast.success('Media uploaded to Google Drive');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteContent(itemId);
      toast.success('Deleted');
      router.replace('/content');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
      setBusy(false);
    }
  };

  if (loading || !item) {
    return (
      <div className="flex justify-center py-16 text-gray-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const meta = STATUS_META[item.status as ContentStatus] ?? STATUS_META.uploaded;
  const fileId = item.drive_file_id;
  const scheduledLocal = item.scheduled_publish_at
    ? new Date(item.scheduled_publish_at).toISOString().slice(0, 16)
    : '';
  const deadlineLocal = item.deadline
    ? new Date(item.deadline).toISOString().slice(0, 16)
    : '';
  const isOverdue =
    !!item.deadline &&
    new Date(item.deadline) < new Date() &&
    item.status !== 'published';

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <Link
        href="/content"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-4"
      >
        <ArrowLeft size={16} /> Back to content
      </Link>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Player / preview — streams from Google Drive, not our VPS */}
        <div className="rounded-xl border border-gray-200 bg-black overflow-hidden aspect-square flex items-center justify-center">
          {!fileId ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-gray-400 p-6">
              <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => onPickMedia(e.target.files?.[0] ?? null)}
              />
              <p className="text-sm text-gray-300">Planned — no media yet</p>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="px-3 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {uploading && <Loader2 size={16} className="animate-spin" />}
                Upload media
              </button>
            </div>
          ) : playing || item.media_type === 'image' ? (
            item.media_type === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={driveThumbUrl(fileId, 1200)}
                alt={item.title}
                className="w-full h-full object-contain"
              />
            ) : (
              <iframe
                src={drivePreviewUrl(fileId)}
                className="w-full h-full"
                allow="autoplay"
                allowFullScreen
                title={item.title}
              />
            )
          ) : (
            <button
              onClick={startPlay}
              className="relative w-full h-full"
              aria-label="Play"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={driveThumbUrl(fileId, 1200)}
                alt={item.title}
                className="w-full h-full object-contain opacity-90"
              />
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="bg-black/60 rounded-full p-4">
                  <PlayIcon className="text-white" size={28} fill="white" />
                </span>
              </span>
            </button>
          )}
        </div>

        {/* Details + actions */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-xl font-semibold">{item.title}</h1>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${meta.cls}`}>
            {meta.label}
          </span>

          {item.caption && (
            <p className="mt-3 text-sm text-gray-700 whitespace-pre-wrap">
              {item.caption}
            </p>
          )}

          <dl className="mt-4 text-sm space-y-1 text-gray-600">
            <Row k="Type" v={item.media_type ?? 'not uploaded'} />
            {item.platform && <Row k="Platform" v={item.platform} />}
            <Row k="Uploaded" v={fmtDateTime(item.created_at)} />
            {item.reviewed_at && (
              <Row k="Reviewed" v={fmtDateTime(item.reviewed_at)} />
            )}
          </dl>

          {/* Assignee — managers can (re)assign; others see it read-only */}
          <div className="mt-4">
            <label className="text-xs font-medium text-gray-600">Assigned to</label>
            {canManage ? (
              <select
                value={item.assignee_user_id ?? ''}
                disabled={busy}
                onChange={(e) => changeAssignee(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Unassigned</option>
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role.replace('_', ' ')})
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 text-sm text-gray-700">
                {assignees.find((a) => a.id === item.assignee_user_id)?.name ??
                  (item.assignee_user_id ? `User #${item.assignee_user_id}` : 'Unassigned')}
              </p>
            )}
          </div>

          {/* Reference (the brief visual) — managers attach; everyone views */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">
                Reference {item.reference_media_type ? '' : '(optional)'}
              </label>
              {canManage && (
                <div className="flex items-center gap-2">
                  <input
                    ref={refFileRef}
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => onPickReference(e.target.files?.[0] ?? null)}
                  />
                  <button
                    onClick={() => refFileRef.current?.click()}
                    disabled={uploading}
                    className="text-xs text-violet-600 hover:text-violet-700 disabled:opacity-50"
                  >
                    {uploading ? 'Uploading…' : item.reference_drive_file_id ? 'Replace' : 'Add reference'}
                  </button>
                  {item.reference_drive_file_id && (
                    <button
                      onClick={dropReference}
                      disabled={busy}
                      className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
            {item.reference_drive_file_id ? (
              <div className="mt-1.5 rounded-lg border border-gray-200 overflow-hidden bg-black/5 aspect-video">
                {item.reference_media_type === 'video' ? (
                  <iframe
                    src={drivePreviewUrl(item.reference_drive_file_id)}
                    className="w-full h-full"
                    allow="autoplay"
                    allowFullScreen
                    title="Reference"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={driveThumbUrl(item.reference_drive_file_id, 800)}
                    alt="Reference"
                    className="w-full h-full object-contain"
                  />
                )}
              </div>
            ) : (
              <p className="mt-1 text-xs text-gray-400">
                No reference attached.
              </p>
            )}
          </div>

          {/* Review feedback (visible to everyone) */}
          {item.review_feedback && (
            <div className="mt-4 rounded-lg bg-orange-50 border border-orange-200 p-3 text-sm text-orange-800">
              <p className="font-medium mb-0.5">Reviewer feedback</p>
              <p className="whitespace-pre-wrap">{item.review_feedback}</p>
            </div>
          )}

          {/* Needs-changes revision: content manager uploads fresh media
              (replaces + deletes the old Drive file) → back to review. */}
          {item.status === 'needs_changes' && fileId && (
            <div className="mt-4 rounded-lg border border-orange-200 bg-white p-3">
              <input
                ref={replaceRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => onPickMedia(e.target.files?.[0] ?? null)}
              />
              <p className="text-sm text-gray-700 mb-2">
                Made the changes? Upload the fresh version — it replaces the old
                file in Drive and goes back for review.
              </p>
              <button
                onClick={() => replaceRef.current?.click()}
                disabled={uploading}
                className="px-3 py-1.5 text-sm rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1.5"
              >
                {uploading && <Loader2 size={15} className="animate-spin" />}
                Upload fresh content
              </button>
            </div>
          )}

          {/* Scheduling + deadline */}
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600">
                Planned publish date
              </label>
              <input
                type="datetime-local"
                defaultValue={scheduledLocal}
                onBlur={(e) => {
                  if (e.target.value !== scheduledLocal)
                    doSchedule({
                      scheduledPublishAt: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    });
                }}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">
                Deadline {isOverdue && <span className="text-red-600">(overdue)</span>}
              </label>
              <input
                type="datetime-local"
                defaultValue={deadlineLocal}
                onBlur={(e) => {
                  if (e.target.value !== deadlineLocal)
                    doSchedule({
                      deadline: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    });
                }}
                className={`mt-1 w-full border rounded-lg px-3 py-2 text-sm ${
                  isOverdue ? 'border-red-400' : 'border-gray-300'
                }`}
              />
            </div>
          </div>

          {/* Review actions (owner/admin only) */}
          {canReview && (
            <div className="mt-5 rounded-xl border border-gray-200 p-3">
              <p className="text-xs font-medium text-gray-600 mb-2">Review</p>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={2}
                placeholder="Feedback (required for 'Needs changes')"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => doReview('approved')}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Check size={15} /> Approve
                </button>
                <button
                  onClick={() => doReview('needs_changes')}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <MessageSquareWarning size={15} /> Needs changes
                </button>
                <button
                  onClick={() => doReview('rejected')}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <X size={15} /> Reject
                </button>
              </div>
            </div>
          )}

          {/* Publish + delete (managers only) */}
          {canManage && (
            <div className="mt-5 flex flex-wrap gap-2">
              {item.status === 'approved' && (
                <button
                  onClick={doPublish}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Rocket size={15} /> Mark published
                </button>
              )}
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 size={15} /> Delete
              </button>
            </div>
          )}

          {/* Activity timeline — complete workflow audit */}
          <div className="mt-6">
            <p className="text-xs font-medium text-gray-600 mb-2">Activity</p>
            {events.length === 0 ? (
              <p className="text-sm text-gray-400">No activity yet.</p>
            ) : (
              <ol className="space-y-2 border-l border-gray-200 pl-4">
                {events.map((ev) => (
                  <li key={ev.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-violet-400" />
                    <p className="text-sm text-gray-700">
                      <span className="font-medium">
                        {ev.actor_name ?? 'Someone'}
                      </span>{' '}
                      {EVENT_LABEL[ev.type] ?? ev.type}
                      {ev.detail && ev.type === 'needs_changes' && (
                        <span className="text-gray-500"> — “{ev.detail}”</span>
                      )}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {fmtDateTime(ev.created_at)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete content?"
        message="This removes the item and its file from Google Drive. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-400">{k}</dt>
      <dd className="text-gray-700 capitalize">{v}</dd>
    </div>
  );
}
