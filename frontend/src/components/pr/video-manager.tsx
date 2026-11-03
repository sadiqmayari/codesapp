'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Pencil, Plus, Trash2, Video, X } from 'lucide-react';
import type { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import {
  PrSubmission,
  PrVideo,
  VideoInput,
  VideoPlatform,
  VideoStatus,
  VIDEO_PLATFORMS,
  VIDEO_PLATFORM_META,
  VIDEO_STATUS_META,
  addVideo,
  deleteVideo,
  updateVideo,
} from '@/lib/pr';

/**
 * Manage the videos an influencer delivered for ONE submission (campaign
 * package). Supports many videos — the public form commits the influencer to
 * 2-3 (form_data.videosCount), shown here as a delivered-vs-promised bar.
 * Replaces the legacy single post_url + window.prompt.
 */
export function VideoManager({
  submission,
  toast,
  onChanged,
}: {
  submission: PrSubmission;
  toast: ReturnType<typeof useToast>;
  onChanged?: () => void;
}) {
  const [videos, setVideos] = useState<PrVideo[]>(submission.videos ?? []);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [delId, setDelId] = useState<number | null>(null);
  const [draft, setDraft] = useState<VideoInput>({ url: '', platform: 'instagram', status: 'posted' });

  // Re-seed when the parent reloads the submission.
  useEffect(() => {
    setVideos(submission.videos ?? []);
  }, [submission.videos]);

  const promised = Number(submission.form_data?.videosCount);
  const hasPromise = Number.isFinite(promised) && promised > 0;
  const pct = hasPromise ? Math.min(100, Math.round((videos.length / promised) * 100)) : 0;
  const complete = hasPromise && videos.length >= promised;

  const resetDraft = () =>
    setDraft({ url: '', platform: 'instagram', status: 'posted' });

  const submitAdd = async () => {
    if (!draft.url.trim()) return toast.error('Paste the video URL');
    setBusy(true);
    try {
      const v = await addVideo(submission.id, {
        url: draft.url.trim(),
        platform: draft.platform,
        status: draft.status,
      });
      setVideos((prev) => [...prev, v]);
      resetDraft();
      setAdding(false);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to add video');
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (id: number) => {
    if (!draft.url.trim()) return toast.error('URL is required');
    setBusy(true);
    try {
      const v = await updateVideo(id, {
        url: draft.url.trim(),
        platform: draft.platform,
        status: draft.status,
      });
      setVideos((prev) => prev.map((x) => (x.id === id ? v : x)));
      setEditId(null);
      resetDraft();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update video');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (delId == null) return;
    setBusy(true);
    try {
      await deleteVideo(delId);
      setVideos((prev) => prev.filter((x) => x.id !== delId));
      setDelId(null);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to delete video');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (v: PrVideo) => {
    setAdding(false);
    setEditId(v.id);
    setDraft({
      url: v.url,
      platform: v.platform ?? 'other',
      status: v.status,
    });
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60">
      {/* Header: delivered vs promised */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-200">
        <span className="text-xs font-medium text-gray-600 flex items-center gap-1.5">
          <Video size={13} /> Videos
        </span>
        {hasPromise ? (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-semibold ${
                complete ? 'text-emerald-600' : 'text-amber-600'
              }`}
            >
              {videos.length} of {promised}
            </span>
            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={complete ? 'h-full bg-emerald-500' : 'h-full bg-amber-500'}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-xs text-gray-400">{videos.length} added</span>
        )}
      </div>

      {/* List */}
      <div className="divide-y divide-gray-100">
        {videos.length === 0 && (
          <p className="px-3 py-2.5 text-xs text-gray-400">No videos recorded yet.</p>
        )}
        {videos.map((v) =>
          editId === v.id ? (
            <VideoForm
              key={v.id}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSave={() => submitEdit(v.id)}
              onCancel={() => {
                setEditId(null);
                resetDraft();
              }}
            />
          ) : (
            <div key={v.id} className="flex items-center gap-2 px-3 py-2">
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold w-16 text-center capitalize ${
                  VIDEO_PLATFORM_META[v.platform ?? 'other']
                }`}
              >
                {v.platform ?? 'other'}
              </span>
              <a
                href={v.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-pink-600 hover:underline truncate flex-1 inline-flex items-center gap-0.5"
              >
                <span className="truncate">{v.url}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                  VIDEO_STATUS_META[v.status].cls
                }`}
              >
                {VIDEO_STATUS_META[v.status].label}
              </span>
              <button
                onClick={() => startEdit(v)}
                className="text-gray-400 hover:text-gray-600 p-0.5"
                title="Edit"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setDelId(v.id)}
                className="text-gray-400 hover:text-red-600 p-0.5"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ),
        )}
      </div>

      {/* Add */}
      <div className="px-3 py-2 border-t border-gray-200">
        {adding ? (
          <VideoForm
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            addMode
            onSave={submitAdd}
            onCancel={() => {
              setAdding(false);
              resetDraft();
            }}
          />
        ) : (
          <button
            onClick={() => {
              setEditId(null);
              resetDraft();
              setAdding(true);
            }}
            className="text-xs font-medium text-pink-600 hover:text-pink-700 inline-flex items-center gap-1"
          >
            <Plus size={13} /> Add video
          </button>
        )}
      </div>

      <ConfirmDialog
        open={delId != null}
        title="Delete video?"
        message="This removes the recorded video from this submission."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDelId(null)}
      />
    </div>
  );
}

function VideoForm({
  draft,
  setDraft,
  busy,
  addMode = false,
  onSave,
  onCancel,
}: {
  draft: VideoInput;
  setDraft: (d: VideoInput) => void;
  busy: boolean;
  addMode?: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1">
      <select
        value={draft.platform ?? 'other'}
        onChange={(e) =>
          setDraft({ ...draft, platform: e.target.value as VideoPlatform })
        }
        className="text-xs border border-gray-300 rounded px-1.5 py-1.5 bg-white capitalize"
      >
        {VIDEO_PLATFORMS.map((p) => (
          <option key={p} value={p} className="capitalize">
            {p}
          </option>
        ))}
      </select>
      <input
        autoFocus
        value={draft.url}
        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) onSave();
        }}
        placeholder="Paste video URL…"
        className="text-xs border border-gray-300 rounded px-2 py-1.5 flex-1 min-w-[140px]"
      />
      <select
        value={draft.status ?? 'posted'}
        onChange={(e) =>
          setDraft({ ...draft, status: e.target.value as VideoStatus })
        }
        className="text-xs border border-gray-300 rounded px-1.5 py-1.5 bg-white"
      >
        <option value="posted">Posted</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
      <button
        onClick={onSave}
        disabled={busy}
        className="text-xs font-medium bg-pink-600 text-white rounded px-2.5 py-1.5 hover:bg-pink-700 disabled:opacity-50 inline-flex items-center gap-1"
      >
        {busy && <Loader2 size={12} className="animate-spin" />}
        {addMode ? 'Add' : 'Save'}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="text-gray-400 hover:text-gray-600 p-1"
        title="Cancel"
      >
        <X size={14} />
      </button>
    </div>
  );
}
