'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/icons/brand-logo';
import {
  IG_CAPTION_MAX,
  IG_HASHTAG_MAX,
  countHashtags,
  postProblems,
  socialPostsApi,
  type PostAccount,
  type PostMediaItem,
  type PostTarget,
  type SocialPost,
} from '@/lib/social-posts';

/** What the composer is for: a new post, editing one, or publishing a Content item. */
export type ComposerMode =
  | { kind: 'new' }
  | { kind: 'edit'; post: SocialPost }
  | { kind: 'content'; contentId: number; caption: string; previewUrl: string | null; mediaType: 'image' | 'video' | null };

const keyOf = (t: PostTarget) => `${t.metaPageId}:${t.platform}`;

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Shared Facebook / Instagram post composer: pick accounts, caption with
 * Instagram limits, media upload (photos or one video), live preview, publish
 * now or schedule. Validation mirrors backend publish-plan.validatePost.
 */
export function PostComposer({
  open,
  mode,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: ComposerMode;
  onClose: () => void;
  onDone: (post: SocialPost) => void;
}) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<PostAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<PostMediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [when, setWhen] = useState<'now' | 'schedule'>('now');
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [preview, setPreview] = useState<'facebook' | 'instagram'>('facebook');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const modeKey = mode.kind === 'edit' ? `e${mode.post.id}` : mode.kind === 'content' ? `c${mode.contentId}` : 'n';
  useEffect(() => {
    if (!open) return;
    socialPostsApi
      .accounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    if (mode.kind === 'edit') {
      setCaption(mode.post.caption);
      setMedia(mode.post.media);
      setSelected(new Set(mode.post.targets.map(keyOf)));
      if (mode.post.scheduledAt && new Date(mode.post.scheduledAt).getTime() > Date.now()) {
        setWhen('schedule');
        setAt(toLocalInput(new Date(mode.post.scheduledAt)));
      } else setWhen('now');
    } else if (mode.kind === 'content') {
      setCaption(mode.caption);
      setMedia([]);
      setSelected(new Set());
      setWhen('now');
    } else {
      setCaption('');
      setMedia([]);
      setSelected(new Set());
      setWhen('now');
    }
    // Reset only when opened / switched to another post (mode is a fresh object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modeKey]);

  const targets: PostTarget[] = useMemo(
    () => (accounts ?? []).filter((a) => selected.has(keyOf(a))).map((a) => ({ metaPageId: a.metaPageId, platform: a.platform })),
    [accounts, selected],
  );
  // Content items bring their own media (fetched from Drive by the server).
  const effectiveMedia: PostMediaItem[] =
    mode.kind === 'content' && mode.mediaType ? [{ webPath: '/storage/media/content', type: mode.mediaType }] : media;
  const problems = postProblems(targets, caption, effectiveMedia);
  const tags = countHashtags(caption);
  const anyIg = targets.some((t) => t.platform === 'instagram');

  const toggle = (a: PostAccount) =>
    setSelected((s) => {
      const n = new Set(s);
      const k = keyOf(a);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const next = [...media];
      for (const f of Array.from(files).slice(0, 10 - next.length)) {
        const up = await socialPostsApi.upload(f);
        next.push(up);
      }
      setMedia(next);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const scheduledAt = when === 'schedule' ? new Date(at).toISOString() : null;

  const submit = async () => {
    if (problems.length) return;
    if (when === 'schedule' && new Date(at).getTime() < Date.now() + 60_000) {
      toast.error('Pick a time at least a minute from now');
      return;
    }
    setBusy(true);
    try {
      let post: SocialPost;
      if (mode.kind === 'content') {
        post = await socialPostsApi.fromContent(mode.contentId, { caption, targets, scheduledAt });
      } else {
        const body = { caption, media, targets, scheduledAt };
        post = mode.kind === 'edit' ? await socialPostsApi.update(mode.post.id, body) : await socialPostsApi.create(body);
      }
      toast.success(when === 'schedule' ? 'Post scheduled' : 'Publishing now…');
      onDone(post);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save the post');
    } finally {
      setBusy(false);
    }
  };

  const firstUrl =
    mode.kind === 'content' ? mode.previewUrl : media[0]?.url ?? (media[0] ? `${typeof window !== 'undefined' ? window.location.origin : ''}${media[0].webPath}` : null);
  const firstType = mode.kind === 'content' ? mode.mediaType : media[0]?.type;
  const previewAccount =
    (accounts ?? []).find((a) => selected.has(keyOf(a)) && a.platform === preview) ??
    (accounts ?? []).find((a) => a.platform === preview);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={mode.kind === 'edit' ? 'Edit post' : mode.kind === 'content' ? 'Publish to Facebook & Instagram' : 'New post'}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-sunken p-0.5" role="group" aria-label="When">
            {(['now', 'schedule'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWhen(w)}
                aria-pressed={when === w}
                className={cn('h-8 rounded-md px-3 text-sm font-semibold', when === w ? 'bg-surface text-ink shadow-sm' : 'text-muted')}
              >
                {w === 'now' ? 'Publish now' : 'Schedule'}
              </button>
            ))}
          </div>
          {when === 'schedule' && (
            <input
              type="datetime-local"
              aria-label="Publish at"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
            />
          )}
          <Button className="ml-auto" onClick={submit} loading={busy} disabled={!!problems.length || uploading}>
            {when === 'schedule' ? 'Schedule post' : `Publish to ${targets.length || ''} account${targets.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <p className="mb-1.5 text-xs font-bold text-muted">Post to</p>
            {accounts === null ? (
              <p className="text-sm text-muted">Loading accounts…</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-muted">No Pages connected. Connect them in Settings → Facebook &amp; Instagram.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accounts.map((a) => {
                  const on = selected.has(keyOf(a));
                  return (
                    <button
                      key={keyOf(a)}
                      type="button"
                      onClick={() => toggle(a)}
                      aria-pressed={on}
                      className={cn(
                        'flex h-10 items-center gap-2 rounded-lg border-[1.5px] px-3 text-sm font-semibold',
                        on ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : 'border-line text-ink',
                      )}
                    >
                      <BrandMark brand={a.platform === 'instagram' ? 'instagram' : 'facebook'} size="sm" className="!h-5 !w-5 !rounded-md [&>svg]:!h-3 [&>svg]:!w-3" />
                      {a.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="post-caption" className="mb-1.5 block text-xs font-bold text-muted">
              Caption
            </label>
            <textarea
              id="post-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none"
              placeholder="Write your post…"
            />
            <div className="mt-1 flex justify-between text-xs text-muted">
              <span className={cn(anyIg && tags > IG_HASHTAG_MAX && 'font-semibold text-red-600')}>
                {tags} / {IG_HASHTAG_MAX} hashtags
              </span>
              <span className={cn(anyIg && caption.length > IG_CAPTION_MAX && 'font-semibold text-red-600')}>
                {caption.length} / {IG_CAPTION_MAX.toLocaleString()}
              </span>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold text-muted">Media</p>
            {mode.kind === 'content' ? (
              <p className="text-sm text-muted">
                The item&apos;s {mode.mediaType ?? 'media'} from Google Drive is attached automatically.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {media.map((m, i) => (
                  <div key={m.webPath} className="relative h-24 w-24 overflow-hidden rounded-lg border border-line bg-sunken">
                    {m.type === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.webPath} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <video src={m.webPath} className="h-full w-full object-cover" muted />
                    )}
                    <button
                      type="button"
                      onClick={() => setMedia(media.filter((_, j) => j !== i))}
                      aria-label="Remove"
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {media.length < 10 && !media.some((m) => m.type === 'video') && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line text-xs text-muted hover:text-ink"
                  >
                    {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                    {uploading ? 'Uploading' : 'Add photo / video'}
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,video/mp4,video/quicktime"
                  multiple
                  hidden
                  onChange={(e) => void addFiles(e.target.files)}
                />
              </div>
            )}
            {media.length > 1 && <p className="mt-1 text-xs text-muted">{media.length} photos: Instagram carousel · Facebook album post</p>}
          </div>

          {problems.length > 0 && (selected.size > 0 || caption || media.length > 0) && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/25 dark:text-amber-100">
              {problems.join(' · ')}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-sunken p-3">
          <div className="flex items-center">
            <span className="flex-1 text-xs font-bold text-muted">Preview</span>
            <div className="flex rounded-md bg-surface p-0.5">
              {(['facebook', 'instagram'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPreview(p)}
                  className={cn('h-7 rounded px-2 text-xs font-semibold', preview === p ? 'bg-sunken text-ink' : 'text-muted')}
                >
                  {p === 'facebook' ? 'Facebook' : 'Instagram'}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-2 px-3 py-2">
              {previewAccount?.pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewAccount.pictureUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <span className="h-8 w-8 rounded-full bg-sunken" />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{previewAccount?.name ?? 'Your Page'}</p>
                <p className="text-[11px] text-muted">{preview === 'facebook' ? 'Just now' : 'Instagram'}</p>
              </div>
            </div>
            {preview === 'facebook' && caption && <p className="whitespace-pre-wrap px-3 pb-2 text-sm text-ink">{caption}</p>}
            <div className="aspect-square w-full bg-sunken">
              {firstUrl &&
                (firstType === 'video' ? (
                  <video src={firstUrl} className="h-full w-full object-cover" muted />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={firstUrl} alt="" className="h-full w-full object-cover" />
                ))}
            </div>
            {preview === 'instagram' && (
              <p className="whitespace-pre-wrap px-3 py-2 text-sm text-ink">
                <b>{previewAccount?.name?.replace(/^@/, '') ?? 'account'}</b> {caption}
              </p>
            )}
          </div>
          <p className="text-xs text-muted">
            Instagram: photo or video required, ≤2,200 characters, ≤30 hashtags, carousel 2–10 items. JPG/PNG photos, MP4/MOV video up to 100 MB.
          </p>
        </div>
      </div>
    </Modal>
  );
}
