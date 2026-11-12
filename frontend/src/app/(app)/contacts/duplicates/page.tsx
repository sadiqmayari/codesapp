'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, GitMerge } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCards } from '@/components/ui/skeleton';
import { cn, fmtDate, fmtListTime } from '@/lib/utils';
import {
  DuplicateGroup,
  formatPhone,
  isManagerRole,
  listDuplicates,
  mergeContacts,
} from '@/lib/contacts';

/**
 * Contacts 360 — duplicate review. A group = live contacts that are the same
 * number saved in different forms (e.g. 92300… and +92300…). Merging moves
 * every chat, ticket, call and shipment to the primary and keeps the union of
 * tags/fields; the others are soft-deleted.
 */
export default function DuplicatesPage() {
  const toast = useToast();
  const router = useRouter();
  const { user } = useAuth();
  const canManage = isManagerRole(user?.role);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [primary, setPrimary] = useState<Record<string, number>>({});
  const [merging, setMerging] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await listDuplicates();
      setGroups(d.groups);
      setPrimary(Object.fromEntries(d.groups.map((g) => [g.phone, g.suggestedPrimaryId])));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not load duplicates');
      setGroups([]);
    }
  }, [toast]);

  useEffect(() => {
    if (user && !canManage) {
      router.replace('/contacts');
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, canManage, user]);

  const mergeGroup = async (g: DuplicateGroup, quiet = false) => {
    const p = primary[g.phone] ?? g.suggestedPrimaryId;
    const others = g.contacts.map((c) => c.id).filter((id) => id !== p);
    const res = await mergeContacts(p, others);
    if (!quiet) {
      const m = res.moved;
      toast.success(
        `Merged ${others.length} into one contact · moved ${m.conversations} chat${m.conversations === 1 ? '' : 's'}, ${m.calls} call${m.calls === 1 ? '' : 's'}`,
      );
    }
    setGroups((cur) => (cur ?? []).filter((x) => x.phone !== g.phone));
  };

  const mergeOne = async (g: DuplicateGroup) => {
    setMerging(g.phone);
    try {
      await mergeGroup(g);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Merge failed');
    } finally {
      setMerging(null);
    }
  };

  const mergeAll = async () => {
    if (!groups?.length) return;
    setConfirmAll(false);
    const list = [...groups];
    setBulkProgress({ done: 0, total: list.length });
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        await mergeGroup(list[i], true);
      } catch {
        failed++;
      }
      setBulkProgress({ done: i + 1, total: list.length });
    }
    setBulkProgress(null);
    if (failed) toast.error(`${list.length - failed} merged, ${failed} failed — try those individually`);
    else toast.success(`Merged ${list.length} duplicate groups`);
    void load();
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="mr-auto">
          <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
            <ArrowLeft size={14} /> Contacts
          </Link>
          <h1 className="text-2xl font-bold text-ink">Duplicates</h1>
          <p className="text-sm text-muted">
            The same number saved more than once. Merging moves all history onto the primary contact.
          </p>
        </div>
        {!!groups?.length && (
          <Button onClick={() => setConfirmAll(true)} loading={!!bulkProgress}>
            <GitMerge size={15} />
            {bulkProgress ? `Merging ${bulkProgress.done}/${bulkProgress.total}` : `Merge all ${groups.length} (suggested primary)`}
          </Button>
        )}
      </div>

      {groups === null ? (
        <SkeletonCards count={3} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No duplicates"
          description="Every number belongs to exactly one contact."
          action={
            <Link href="/contacts" className="text-sm font-semibold text-brand-700 hover:underline">
              Back to contacts
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const p = primary[g.phone] ?? g.suggestedPrimaryId;
            const others = g.contacts.filter((c) => c.id !== p);
            const moveChats = others.reduce((s, c) => s + c.conversations, 0);
            const moveCalls = others.reduce((s, c) => s + c.calls, 0);
            const moveTickets = others.reduce((s, c) => s + c.tickets, 0);
            return (
              <Card key={g.phone} className="p-4">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="font-semibold text-ink tabular-nums">{formatPhone(g.phone)}</span>
                  <Badge tone="warn">{g.contacts.length} contacts</Badge>
                </div>
                <div
                  role="radiogroup"
                  aria-label={`Primary contact for ${formatPhone(g.phone)}`}
                  className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                >
                  {g.contacts.map((c) => {
                    const isP = c.id === p;
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          'relative cursor-pointer rounded-xl border p-3 transition-colors',
                          isP ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-line hover:bg-sunken',
                        )}
                      >
                        <input
                          type="radio"
                          name={`primary-${g.phone}`}
                          checked={isP}
                          onChange={() => setPrimary((cur) => ({ ...cur, [g.phone]: c.id }))}
                          className="sr-only"
                        />
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block font-semibold text-ink truncate">{c.name}</span>
                            <span className="block text-xs text-muted tabular-nums">saved as {c.phone}</span>
                          </span>
                          {isP ? <Badge tone="brand">Primary</Badge> : <span className="text-xs font-semibold text-muted">Make primary</span>}
                        </span>
                        <span className="mt-2 block text-xs text-muted">
                          {c.conversations} chat{c.conversations === 1 ? '' : 's'} · {c.calls} call{c.calls === 1 ? '' : 's'}
                          {c.tickets ? ` · ${c.tickets} ticket${c.tickets === 1 ? '' : 's'}` : ''}
                        </span>
                        <span className="block text-xs text-muted">
                          {c.last_message_at ? `Last message ${fmtListTime(c.last_message_at)}` : 'No messages'} · added {fmtDate(c.created_at)}
                        </span>
                        {Array.isArray(c.tags) && c.tags.length > 0 && (
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            {c.tags.slice(0, 4).map((t) => (
                              <span key={t} className="rounded-full border border-line bg-surface px-1.5 text-xs text-ink">
                                {t}
                              </span>
                            ))}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted">
                    Moves <strong className="text-ink">{moveChats}</strong> chat{moveChats === 1 ? '' : 's'},{' '}
                    <strong className="text-ink">{moveCalls}</strong> call{moveCalls === 1 ? '' : 's'}
                    {moveTickets ? (
                      <>
                        , <strong className="text-ink">{moveTickets}</strong> ticket{moveTickets === 1 ? '' : 's'}
                      </>
                    ) : null}{' '}
                    and all tags into the primary.
                  </p>
                  <Button size="sm" onClick={() => void mergeOne(g)} loading={merging === g.phone} disabled={!!bulkProgress}>
                    <GitMerge size={14} /> Merge
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmAll}
        title={`Merge all ${groups?.length ?? 0} groups?`}
        message="Each group is merged into its highlighted primary contact (the one with the most chats unless you changed it). This can’t be undone automatically."
        confirmLabel="Merge all"
        onConfirm={() => void mergeAll()}
        onCancel={() => setConfirmAll(false)}
      />
    </div>
  );
}
