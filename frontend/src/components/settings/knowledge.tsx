'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, RefreshCw, Pencil, BookOpen, CheckCircle2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { aiListKnowledge, aiCreateKnowledge, aiUpdateKnowledge, aiDeleteKnowledge, type AiKnowledgeEntry } from '@/lib/ai';
import { useToast } from '@/components/toast';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { SearchInput } from '@/components/ui/search-input';
import { NoResults } from '@/components/ui/empty-state';
import { cn, fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Callout, SettingsCard, SettingsPage, inputCls } from './shared';

/**
 * Settings → Knowledge base (owner/admin + agents). The manual KB entries the
 * AI always sees, plus the store catalogue/policy sync status (RAG).
 */
export function KnowledgeSection() {
  const toast = useToast();
  const [rows, setRows] = useState<AiKnowledgeEntry[]>([]);
  const [kbQuery, setKbQuery] = useState('');
  const shownKb = rows.filter((e) => {
    const q = kbQuery.trim().toLowerCase();
    return !q || JSON.stringify(e).toLowerCase().includes(q);
  });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AiKnowledgeEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiKnowledgeEntry | null>(null);
  const [kbStatus, setKbStatus] = useState<{
    configured: boolean;
    products: number;
    policies: number;
    total: number;
    lastSyncedAt: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await aiListKnowledge());
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setKbStatus(
        await apiFetch<{
          configured: boolean;
          products: number;
          policies: number;
          total: number;
          lastSyncedAt: string | null;
        }>('/shopify/knowledge-status'),
      );
    } catch {
      /* Shopify not connected / no permission — just hide the status card */
    }
  }, []);

  const syncShopify = async () => {
    setSyncing(true);
    try {
      await apiFetch<{ started: boolean }>('/shopify/sync-knowledge', {
        method: 'POST',
      });
      toast.success(
        'Shopify sync started. Your products are being indexed in the ' +
          'background — this can take a minute for a large catalogue.',
      );
      // Poll the status for ~90s so the counts update once the job finishes.
      const startTotal = kbStatus?.total ?? -1;
      let tries = 0;
      const poll = async () => {
        tries++;
        await loadStatus();
        setKbStatus((s) => {
          // stop spinning once the indexed total changed or we've waited enough
          if ((s && s.total !== startTotal) || tries >= 18) setSyncing(false);
          return s;
        });
        if (tries < 18) setTimeout(poll, 5000);
      };
      setTimeout(poll, 5000);
    } catch (e) {
      setSyncing(false);
      toast.error(
        e instanceof ApiError
          ? e.userMessage
          : 'Shopify sync failed. Make sure Shopify is connected with read_products.',
      );
    }
  };

  useEffect(() => {
    load();
    loadStatus();
  }, [load, loadStatus]);

  const openNew = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setShowForm(true);
  };
  const openEdit = (e: AiKnowledgeEntry) => {
    setEditing(e);
    setTitle(e.title);
    setContent(e.content);
    setShowForm(true);
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are required.');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await aiUpdateKnowledge(editing.id, { title, content });
      } else {
        await aiCreateKnowledge({ title, content });
      }
      setShowForm(false);
      await load();
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (e: AiKnowledgeEntry) => {
    try {
      await aiUpdateKnowledge(e.id, { enabled: !e.enabled });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.userMessage : 'Failed');
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await aiDeleteKnowledge(deleteTarget.id);
      setDeleteTarget(null);
      await load();
      toast.success('Deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    }
  };

  return (
    <SettingsPage
      title="Knowledge base"
      description="Facts the AI uses to answer customers. Products and store policies sync from your store; add FAQs and anything else yourself."
      actions={
        <>
          <Button variant="secondary" loading={syncing} onClick={syncShopify} title="Pull your store's products and policies into the knowledge base">
            {!syncing && <RefreshCw size={14} />}
            {syncing ? 'Syncing…' : 'Sync from store'}
          </Button>
          <Button onClick={openNew}>
            <Plus size={15} /> Add entry
          </Button>
        </>
      }
    >
      {kbStatus && (kbStatus.total > 0 || syncing) && (
        <Callout tone="brand" icon={syncing ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={15} className="text-brand-600" />}>
          {syncing ? (
            <>
              <b>Syncing your catalogue…</b> indexed so far: {kbStatus.products} products, {kbStatus.policies} policies.
            </>
          ) : (
            <>
              <b>
                {kbStatus.products} product{kbStatus.products === 1 ? '' : 's'} and {kbStatus.policies} polic
                {kbStatus.policies === 1 ? 'y' : 'ies'} synced
              </b>{' '}
              for AI search
              {kbStatus.lastSyncedAt ? ` · last synced ${fmtDateTime(kbStatus.lastSyncedAt)}` : ''}.
            </>
          )}
        </Callout>
      )}

      <SettingsCard
        title="Your entries"
        description="Always given to the AI in full — keep each one short and factual."
        action={
          rows.length > 5 ? (
            <SearchInput value={kbQuery} onChange={setKbQuery} placeholder="Search entries" size="sm" className="w-full sm:w-60" />
          ) : undefined
        }
      >
        {loading ? (
          <SkeletonRows rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={BookOpen}
            title="No entries yet"
            description="Add your delivery times, exchange policy, COD rules — anything customers often ask."
            action={
              <Button size="sm" onClick={openNew}>
                <Plus size={14} /> Add entry
              </Button>
            }
          />
        ) : shownKb.length === 0 ? (
          <NoResults compact query={kbQuery} noun="entries" onClear={() => setKbQuery('')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shownKb.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <button type="button" onClick={() => openEdit(e)} className="min-w-0 flex-1 text-left">
                  <p className={cn('truncate text-sm font-semibold', e.enabled ? 'text-ink' : 'text-muted')}>{e.title}</p>
                  <p className="truncate text-[13px] text-muted">{e.content}</p>
                </button>
                <Switch size="sm" checked={e.enabled} onChange={() => toggle(e)} label={`Use “${e.title}”`} />
                <button
                  type="button"
                  onClick={() => openEdit(e)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
                  aria-label={`Edit ${e.title}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(e)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                  aria-label={`Delete ${e.title}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? 'Edit entry' : 'New entry'}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm rounded-lg border border-line bg-surface hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="kb-title" className="mb-1 block text-[13px] font-semibold text-ink">Title</label>
            <input
              id="kb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="e.g. Return policy"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="kb-content" className="mb-1 block text-[13px] font-semibold text-ink">Content</label>
            <textarea
              id="kb-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              maxLength={20000}
              placeholder="Write the facts the assistant should know…"
              className={inputCls}
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete entry"
        message={`Delete "${deleteTarget?.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </SettingsPage>
  );
}
