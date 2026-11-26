'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, MessageSquareText, RefreshCw, Reply } from 'lucide-react';
import { ApiError, isAbortError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, NoResults } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { StatusChips } from '@/components/ui/filter-bar';
import { commentsApi, type CommentList, type CommentStatus, type SocialComment } from '@/lib/social-comments';

const err = (e: unknown, fb: string) => (e instanceof ApiError ? e.userMessage : fb);

function CommentCard({ c, onChanged }: { c: SocialComment; onChanged: (row: SocialComment) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<SocialComment>, ok: string) => {
    setBusy(key);
    try {
      const row = await fn();
      onChanged({ ...c, ...row });
      toast.success(ok);
      if (key === 'reply') {
        setText('');
        setOpen(false);
      }
    } catch (e) {
      toast.error(err(e, 'That did not work'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral">TikTok</Badge>
        {c.ad_name && <span className="truncate font-semibold text-ink" title={c.ad_id ?? undefined}>Ad: {c.ad_name}</span>}
        {c.parent_external_id && <span>Reply in a thread</span>}
        {c.status === 'hidden' && <Badge tone="warn">Hidden</Badge>}
        <span className="ml-auto">{fmtDateTime(c.commented_at)}</span>
      </div>
      <p className="mt-2 text-sm text-ink">
        <span className="font-semibold">{c.author_name ?? 'TikTok user'}</span> <span className="whitespace-pre-wrap break-words">{c.text}</span>
      </p>
      {c.reply_text && (
        <p className="mt-2 rounded-lg bg-sunken px-3 py-2 text-sm text-ink">
          <span className="font-semibold">You replied:</span> {c.reply_text}
          {c.replied_at && <span className="ml-2 text-xs text-muted">{fmtDateTime(c.replied_at)}</span>}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={2} autoFocus
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" placeholder="Write a public reply…" />
          <div className="flex gap-2">
            <Button size="sm" loading={busy === 'reply'} disabled={!text.trim()} onClick={() => void act('reply', () => commentsApi.reply(c.id, text), 'Reply posted on TikTok')}>Post reply</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {!open && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Reply size={14} /> Reply</Button>
          {c.status === 'hidden' ? (
            <Button size="sm" variant="ghost" loading={busy === 'hide'} onClick={() => void act('hide', () => commentsApi.unhide(c.id), 'Comment visible again')}><Eye size={14} /> Unhide</Button>
          ) : (
            <Button size="sm" variant="ghost" loading={busy === 'hide'} onClick={() => void act('hide', () => commentsApi.hide(c.id), 'Comment hidden on TikTok')}><EyeOff size={14} /> Hide</Button>
          )}
        </div>
      )}
    </Card>
  );
}

export default function CommentsPage() {
  const toast = useToast();
  const { user } = useAuth();
  const { on, reconnectSeq } = useSocket();
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [status, setStatus] = useState<CommentStatus>('unreplied');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CommentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async (silent = false) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (!silent) setLoading(true);
    try {
      const r = await commentsApi.list({ status, q: q.trim() || undefined, page }, c.signal);
      if (ctrl.current === c) setData(r);
    } catch (e) {
      if (!isAbortError(e)) toast.error(err(e, 'Could not load comments'));
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [status, q, page, toast]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => on('comments.new', () => void load(true)), [on, load]);
  useEffect(() => {
    if (reconnectSeq) void load(true);
  }, [reconnectSeq, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await commentsApi.refresh();
      if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(r.created ? `${r.created} new comment${r.created === 1 ? '' : 's'}` : 'No new comments');
      await load(true);
    } catch (e) {
      toast.error(err(e, 'Could not check TikTok'));
    } finally {
      setRefreshing(false);
    }
  };

  const patch = (row: SocialComment) =>
    setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === row.id ? row : x)) } : d));

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-ink">Comments</h1>
        <span className="text-sm text-muted">Comments on your TikTok ads. New ones arrive every 10 minutes.</span>
        {canManage && (
          <Button size="sm" variant="secondary" className="ml-auto" loading={refreshing} onClick={() => void refresh()}><RefreshCw size={14} /> Check now</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <StatusChips<CommentStatus>
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[
            { value: 'unreplied', label: 'Needs reply', count: data?.unreplied ?? null },
            { value: 'all', label: 'All' },
            { value: 'visible', label: 'Visible' },
            { value: 'hidden', label: 'Hidden' },
          ]}
        />
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search comments, people, ads" className="w-full sm:w-64" />
      </div>

      {loading && !data ? (
        <SkeletonRows rows={5} />
      ) : data && !data.hasAccounts ? (
        <EmptyState icon={MessageSquareText} title="Connect a TikTok ad account"
          description="Comments come from the TikTok ad accounts connected in Growth."
          action={canManage ? <Link href="/growth/connections" className="text-sm font-semibold text-brand-600">Go to Connections</Link> : undefined} />
      ) : data && data.rows.length === 0 ? (
        q || status !== 'all' ? (
          <NoResults query={q} noun="comments" onClear={() => { setQ(''); setStatus('all'); setPage(1); }} />
        ) : (
          <EmptyState icon={MessageSquareText} title="No comments yet" description="New comments on your TikTok ads show up here." />
        )
      ) : (
        <div className="space-y-3">
          {data?.rows.map((c) => <CommentCard key={c.id} c={c} onChanged={patch} />)}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-sm">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="text-muted">Page {page} of {pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
