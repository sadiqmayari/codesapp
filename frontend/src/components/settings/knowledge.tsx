'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, RefreshCw, Pencil, BookOpen, CheckCircle2, Globe, FileUp, Search } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import {
  getKnowledgeIndex,
  getStoreProfiles,
  importKnowledgeFile,
  importKnowledgeUrl,
  syncStoreKnowledge,
  testKnowledge,
  type KnowledgeIndexStatus,
  type StoreAiProfile,
} from '@/lib/ai-agent';
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
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [index, setIndex] = useState<KnowledgeIndexStatus | null>(null);
  const [stores, setStores] = useState<StoreAiProfile[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [question, setQuestion] = useState('');
  const [testing, setTesting] = useState(false);
  const [hits, setHits] = useState<Awaited<ReturnType<typeof testKnowledge>>['hits'] | null>(null);
  const [storeSyncing, setStoreSyncing] = useState<number | 'all' | null>(null);
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
      const ix = await getKnowledgeIndex();
      setIndex(ix);
      setKbStatus(ix);
    } catch {
      /* hide the status card */
    }
    if (canManage) getStoreProfiles().then(setStores).catch(() => setStores([]));
  }, [canManage]);

  const syncStore = async (target: number | 'all') => {
    setStoreSyncing(target);
    try {
      await syncStoreKnowledge(target === 'all' ? { all: true } : { storeId: target });
      toast.success('Sync started — products are indexed in the background (a minute or two for a large catalogue).');
      setTimeout(() => {
        loadStatus();
        setStoreSyncing(null);
      }, 45000);
    } catch (e) {
      setStoreSyncing(null);
      toast.error(e instanceof ApiError ? e.userMessage : 'Sync failed');
    }
  };

  const doImportUrl = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      const r = await importKnowledgeUrl(importUrl.trim());
      toast.success(`Imported ${r.imported} page${r.imported === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} skipped` : ''}`);
      setImportOpen(false);
      setImportUrl('');
      await load();
      await loadStatus();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const doImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const r = await importKnowledgeFile(file);
      toast.success(`Imported “${r.title}” (${r.chars.toLocaleString()} characters)`);
      await load();
      await loadStatus();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setImporting(false);
    }
  };

  const doTest = async () => {
    if (!question.trim()) return;
    setTesting(true);
    try {
      setHits((await testKnowledge(question.trim())).hits);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

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
          {canManage && stores.length <= 1 && (
            <Button variant="secondary" loading={syncing} onClick={syncShopify} title="Pull your store's products and policies into the knowledge base">
              {!syncing && <RefreshCw size={14} />}
              {syncing ? 'Syncing…' : 'Sync from store'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            <Globe size={14} /> Import website
          </Button>
          <label className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-sunken', importing && 'pointer-events-none opacity-60')}>
            <FileUp size={14} /> Upload PDF / text
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/csv,text/markdown"
              className="sr-only"
              onChange={(e) => {
                doImportFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          <Button onClick={openNew}>
            <Plus size={15} /> Add entry
          </Button>
        </>
      }
    >
      {canManage && stores.length > 1 && (
        <SettingsCard
          title="Products & policies by store"
          description="Each store keeps its own catalogue knowledge — syncing one never removes another. Product changes re-sync automatically within ~10 minutes, plus a nightly refresh."
          action={
            <Button size="sm" variant="secondary" loading={storeSyncing === 'all'} onClick={() => syncStore('all')}>
              <RefreshCw size={13} /> Sync all stores
            </Button>
          }
          flush
        >
          <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-2">Store</th>
                <th className="px-3 py-2 text-right">Products</th>
                <th className="px-3 py-2 text-right">Policies</th>
                <th className="px-3 py-2">Last sync</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {stores.map((st) => {
                const s2 = index?.byStore.find((b) => b.storeId === st.storeId);
                return (
                  <tr key={st.storeId} className="border-b border-line last:border-0">
                    <td className="px-5 py-2.5 font-semibold text-ink">
                      {st.label} <span className="text-xs font-normal text-muted">· {st.provider}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s2?.products ?? 0}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s2?.policies ?? 0}</td>
                    <td className="px-3 py-2.5 text-muted">{s2?.lastSyncedAt ? fmtDateTime(s2.lastSyncedAt) : 'never'}</td>
                    <td className="px-5 py-2.5 text-right">
                      <Button size="sm" variant="ghost" loading={storeSyncing === st.storeId} onClick={() => syncStore(st.storeId)}>
                        Sync
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Test a question" description="See exactly which knowledge the AI would read for a customer question.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); doTest(); }}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. what is your return policy?" className={inputCls} aria-label="Test question" />
          <Button type="submit" variant="secondary" loading={testing}><Search size={14} /> Test</Button>
        </form>
        {hits && (
          hits.length === 0 ? (
            <p className="text-sm text-muted">Nothing relevant found — add an entry that answers this.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {hits.map((h, i) => (
                <li key={i} className="rounded-lg border border-line px-3 py-2">
                  <p className="flex items-center justify-between gap-2 text-sm font-semibold text-ink">
                    <span className="truncate">{h.title}</span>
                    <span className="shrink-0 text-xs font-normal text-muted">{h.sourceType} · {h.score.toFixed(2)}</span>
                  </p>
                  <p className="line-clamp-2 text-xs text-muted">{h.preview}</p>
                </li>
              ))}
            </ul>
          )
        )}
      </SettingsCard>
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
        description="Searched by meaning — the AI reads the parts relevant to each question. One topic per entry works best."
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

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import from your website"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button loading={importing} onClick={doImportUrl}>Import</Button>
          </div>
        }
      >
        <div className="space-y-2">
          <label htmlFor="kb-url" className="block text-[13px] font-semibold text-ink">Page or sitemap URL</label>
          <input id="kb-url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://yourshop.com/pages/faq  or  …/sitemap.xml" className={inputCls} />
          <p className="text-xs text-muted">A single page, or a sitemap.xml (up to 25 pages). Each page becomes an entry you can edit or switch off.</p>
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
