'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Plus, RotateCcw, Send } from 'lucide-react';
import { ApiError, isAbortError } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { useSocket } from '@/context/socket-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChips } from '@/components/ui/filter-bar';
import { ConfirmDialog } from '@/components/ui/modal';
import { BrandMark } from '@/components/icons/brand-logo';
import { PostComposer, type ComposerMode } from '@/components/social/post-composer';
import { socialPostsApi, type PostList, type SocialPost } from '@/lib/social-posts';

type Tab = 'scheduled' | 'published' | 'failed' | 'all';

const STATUS: Record<SocialPost['status'], { label: string; tone: 'neutral' | 'success' | 'warn' | 'danger' | 'info' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  publishing: { label: 'Publishing…', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  partial: { label: 'Partly published', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Posts: publish and schedule to Facebook Pages + Instagram (own Meta app). */
export default function PostsPage() {
  const toast = useToast();
  const { on } = useSocket();
  const [tab, setTab] = useState<Tab>('scheduled');
  const [data, setData] = useState<PostList | null>(null);
  const [loading, setLoading] = useState(true);
  const [composer, setComposer] = useState<ComposerMode | null>(null);
  const [cancelId, setCancelId] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(
    async (silent = false) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      if (!silent) setLoading(true);
      try {
        const r = await socialPostsApi.list(tab, 1, c.signal);
        if (ctrl.current === c) setData(r);
      } catch (e) {
        if (!isAbortError(e)) toast.error(e instanceof ApiError ? e.userMessage : 'Could not load posts');
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    },
    [tab, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => on('social_posts.updated', () => void load(true)), [on, load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      void load(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'That did not work');
    }
  };

  const tabs = useMemo(
    () => [
      { value: 'scheduled' as Tab, label: 'Scheduled', count: data?.counts.scheduled ?? null },
      { value: 'published' as Tab, label: 'Published', count: data?.counts.published ?? null },
      { value: 'failed' as Tab, label: 'Failed', count: data?.counts.failed ?? null },
      { value: 'all' as Tab, label: 'All' },
    ],
    [data],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-ink">Posts</h1>
          <p className="text-sm text-muted">Publish and schedule to your Facebook Pages and Instagram accounts.</p>
        </div>
        <Button onClick={() => setComposer({ kind: 'new' })}>
          <Plus size={16} /> New post
        </Button>
      </div>

      <StatusChips<Tab> value={tab} onChange={setTab} options={tabs} />

      {loading && !data ? (
        <SkeletonRows rows={5} />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          icon={Send}
          title={tab === 'scheduled' ? 'Nothing scheduled' : tab === 'failed' ? 'No failed posts' : 'No posts yet'}
          description="Create a post, or publish an approved item from Content."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          {data.rows.map((p) => {
            const st = STATUS[p.status];
            const first = p.media[0];
            const platforms = Array.from(new Set(p.targets.map((t) => t.platform)));
            const links = p.results.filter((r) => r.permalink);
            const errors = p.results.filter((r) => r.error);
            return (
              <div key={p.id} className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-0">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-sunken">
                  {first &&
                    (first.type === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`${first.webPath.replace(/(\.\w+)$/, '.thumb.jpg')}`} onError={(e) => ((e.currentTarget as HTMLImageElement).src = first.webPath)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <video src={first.webPath} className="h-full w-full object-cover" muted />
                    ))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{p.caption.split('\n')[0] || '(no caption)'}</p>
                  <p className="text-xs text-muted">
                    {p.status === 'scheduled' && p.scheduledAt
                      ? `Scheduled · ${fmtDateTime(p.scheduledAt)}`
                      : p.publishedAt
                        ? `Published · ${fmtDateTime(p.publishedAt)}`
                        : `Created · ${fmtDateTime(p.createdAt)}`}
                    {p.contentItemId ? ' · from Content' : ''}
                  </p>
                  {errors.length > 0 && <p className="mt-1 text-xs text-red-600">{errors.map((e) => e.error).join(' · ')}</p>}
                  {links.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-3">
                      {links.map((l) => (
                        <a key={`${l.metaPageId}:${l.platform}`} href={l.permalink ?? '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
                          View on {l.platform === 'instagram' ? 'Instagram' : 'Facebook'} <ExternalLink size={11} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {platforms.map((pl) => (
                    <BrandMark key={pl} brand={pl === 'instagram' ? 'instagram' : 'facebook'} size="sm" className="!h-5 !w-5 !rounded-md [&>svg]:!h-3 [&>svg]:!w-3" />
                  ))}
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
                <div className={cn('flex gap-1')}>
                  {p.status === 'scheduled' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setComposer({ kind: 'edit', post: p })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setCancelId(p.id)}>Cancel</Button>
                    </>
                  )}
                  {(p.status === 'failed' || p.status === 'partial') && (
                    <Button size="sm" variant="ghost" onClick={() => void act(() => socialPostsApi.retry(p.id), 'Retrying')}>
                      <RotateCcw size={14} /> Retry
                    </Button>
                  )}
                  {(p.status === 'failed' || p.status === 'cancelled') && (
                    <Button size="sm" variant="ghost" onClick={() => setComposer({ kind: 'edit', post: p })}>Edit</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {composer && (
        <PostComposer
          open
          mode={composer}
          onClose={() => setComposer(null)}
          onDone={(post) => {
            setComposer(null);
            setTab(post.status === 'scheduled' ? 'scheduled' : 'all');
            void load(true);
          }}
        />
      )}
      <ConfirmDialog
        open={cancelId != null}
        title="Cancel this scheduled post?"
        message="It won't be published. You can edit and schedule it again later."
        confirmLabel="Cancel post"
        onCancel={() => setCancelId(null)}
        onConfirm={() => {
          const id = cancelId;
          setCancelId(null);
          if (id != null) void act(() => socialPostsApi.cancel(id), 'Post cancelled');
        }}
      />
    </div>
  );
}
