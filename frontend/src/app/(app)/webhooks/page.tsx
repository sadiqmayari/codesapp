'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Power, Send, Trash2, Pencil, RefreshCw } from 'lucide-react';
import { apiFetch, apiFetchEnvelope, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { cn, fmtDateTime } from '@/lib/utils';
import type {
  WebhookEndpoint,
  WebhookLog,
  WebhookStatus,
} from '@/lib/crm-types';

// Events the dispatcher fires (ARCHITECTURE.md — Webhook delivery contract).
const EVENTS = [
  'message.sent',
  'message.received',
  'message.delivered',
  'message.read',
  'message.failed',
  'keyword.triggered',
  'contact.created',
  'contact.updated',
  'template.approved',
  'template.rejected',
  'subscription.limit.warning',
];

const LIMIT = 20;
type Tab = 'endpoints' | 'logs';

interface EndpointForm {
  id?: number;
  endpointUrl: string;
  secret: string;
  events: string[];
  status: WebhookStatus;
}

export default function WebhooksPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('endpoints');
  // Plan gate: webhooks are a paid feature (subscriptions.webhook_enabled).
  // `null` = still loading → render normally (fail-open so we never hide the
  // page from a tenant who actually has the feature).
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch<{ features?: { webhookEnabled?: boolean } }>(
      '/billing/subscription',
    )
      .then((d) => setEnabled(d.features?.webhookEnabled ?? true))
      .catch(() => setEnabled(true));
  }, []);

  if (enabled === false) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Webhooks</h1>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-amber-800 font-medium">
            Webhooks aren&apos;t included in your current plan.
          </p>
          <p className="text-amber-700 text-sm mt-1">
            Contact support to upgrade and start sending outbound webhooks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Webhooks</h1>
      <div className="flex gap-2 mb-5 border-b border-gray-200">
        {(['endpoints', 'logs'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm capitalize -mb-px border-b-2',
              tab === t
                ? 'border-green-600 text-green-700 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {t === 'endpoints' ? 'Endpoints' : 'Delivery logs'}
          </button>
        ))}
      </div>
      {tab === 'endpoints' ? (
        <Endpoints toast={toast} />
      ) : (
        <Logs toast={toast} />
      )}
    </div>
  );
}

/* ------------------------------- Endpoints ------------------------------- */

function Endpoints({
  toast,
}: {
  toast: ReturnType<typeof useToast>;
}) {
  const [rows, setRows] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<EndpointForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [delTarget, setDelTarget] = useState<WebhookEndpoint | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<WebhookEndpoint[]>(
        '/webhooks/endpoints',
        { params: { page: 1, limit: 100 } },
      );
      setRows(env.data);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load endpoints',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    if (!/^https:\/\//i.test(form.endpointUrl)) {
      toast.error('Endpoint URL must start with https://');
      return;
    }
    if (form.events.length === 0) {
      toast.error('Select at least one event');
      return;
    }
    if (!form.id && form.secret.length < 16) {
      toast.error('Secret must be at least 16 characters');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        endpointUrl: form.endpointUrl,
        events: form.events,
        status: form.status,
      };
      if (form.secret) body.secret = form.secret;
      if (form.id) {
        await apiFetch(`/webhooks/endpoints/${form.id}`, {
          method: 'PATCH',
          body,
        });
        toast.success('Endpoint updated');
      } else {
        await apiFetch('/webhooks/endpoints', { method: 'POST', body });
        toast.success('Endpoint created');
      }
      setForm(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (ep: WebhookEndpoint) => {
    setBusyId(ep.id);
    try {
      await apiFetch(`/webhooks/endpoints/${ep.id}/toggle`, {
        method: 'PATCH',
      });
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Toggle failed');
    } finally {
      setBusyId(null);
    }
  };

  const test = async (ep: WebhookEndpoint) => {
    setBusyId(ep.id);
    try {
      await apiFetch(`/webhooks/endpoints/${ep.id}/test`, { method: 'POST' });
      toast.success('Test event enqueued');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Test failed');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!delTarget) return;
    setBusyId(delTarget.id);
    try {
      await apiFetch(`/webhooks/endpoints/${delTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('Endpoint deleted');
      setDelTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() =>
            setForm({
              endpointUrl: '',
              secret: '',
              events: [],
              status: 'active',
            })
          }
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg"
        >
          <Plus size={16} /> New endpoint
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {loading ? (
          <div className="p-10 flex justify-center">
            <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-gray-400">
            No webhook endpoints. Create one to receive events.
          </p>
        ) : (
          rows.map((ep) => (
            <div
              key={ep.id}
              className="p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900 truncate">
                    {ep.endpoint_url}
                  </span>
                  <span
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-full',
                      ep.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-500',
                    )}
                  >
                    {ep.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {(ep.events || []).map((ev) => (
                    <span
                      key={ev}
                      className="text-[11px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5"
                    >
                      {ev}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <IconBtn
                  title="Send test"
                  onClick={() => test(ep)}
                  disabled={busyId === ep.id}
                >
                  <Send size={16} />
                </IconBtn>
                <IconBtn
                  title={ep.status === 'active' ? 'Disable' : 'Enable'}
                  onClick={() => toggle(ep)}
                  disabled={busyId === ep.id}
                >
                  <Power size={16} />
                </IconBtn>
                <IconBtn
                  title="Edit"
                  onClick={() =>
                    setForm({
                      id: ep.id,
                      endpointUrl: ep.endpoint_url,
                      secret: '',
                      events: ep.events || [],
                      status: ep.status,
                    })
                  }
                >
                  <Pencil size={16} />
                </IconBtn>
                <IconBtn
                  title="Delete"
                  danger
                  onClick={() => setDelTarget(ep)}
                  disabled={busyId === ep.id}
                >
                  <Trash2 size={16} />
                </IconBtn>
              </div>
            </div>
          ))
        )}
      </div>

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit endpoint' : 'New endpoint'}
        footer={
          <>
            <button
              onClick={() => setForm(null)}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Endpoint URL (https)
              </label>
              <input
                value={form.endpointUrl}
                onChange={(e) =>
                  setForm({ ...form, endpointUrl: e.target.value })
                }
                placeholder="https://example.com/webhook"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Secret{' '}
                {form.id && (
                  <span className="text-gray-400">
                    (leave blank to keep current)
                  </span>
                )}
              </label>
              <input
                value={form.secret}
                onChange={(e) =>
                  setForm({ ...form, secret: e.target.value })
                }
                placeholder="≥ 16 characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">
                Used to sign the X-CodesApp-Signature HMAC. Never shown again
                after saving.
              </p>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-2">
                Events
              </label>
              <div className="grid grid-cols-2 gap-2">
                {EVENTS.map((ev) => {
                  const on = form.events.includes(ev);
                  return (
                    <label
                      key={ev}
                      className="flex items-center gap-2 text-sm text-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setForm({
                            ...form,
                            events: on
                              ? form.events.filter((x) => x !== ev)
                              : [...form.events, ev],
                          })
                        }
                      />
                      {ev}
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Status
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value as WebhookStatus,
                  })
                }
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </select>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!delTarget}
        title="Delete endpoint?"
        message={`This permanently removes ${delTarget?.endpoint_url}. Delivery logs are kept.`}
        danger
        confirmLabel="Delete"
        busy={busyId === delTarget?.id}
        onConfirm={remove}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  );
}

/* --------------------------------- Logs ---------------------------------- */

function Logs({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [rows, setRows] = useState<WebhookLog[]>([]);
  const [status, setStatus] = useState<'all' | 'pending' | 'success' | 'failed'>(
    'all',
  );
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<WebhookLog[]>('/webhooks/logs', {
        params: {
          status: status === 'all' ? undefined : status,
          page,
          limit: LIMIT,
        },
      });
      setRows(env.data);
      setTotal((env.meta?.total as number) ?? env.data.length);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load logs',
      );
    } finally {
      setLoading(false);
    }
  }, [status, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = async (id: number) => {
    setBusyId(id);
    try {
      await apiFetch(`/webhooks/logs/${id}/retry`, { method: 'POST' });
      toast.success('Re-enqueued');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Retry failed');
    } finally {
      setBusyId(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div>
      <div className="flex gap-1 flex-wrap mb-3">
        {(['all', 'pending', 'success', 'failed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={cn(
              'px-3 py-1 text-xs rounded-full capitalize',
              status === s
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">HTTP</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-gray-400"
                  >
                    No delivery logs.
                  </td>
                </tr>
              ) : (
                rows.map((lg) => (
                  <tr
                    key={lg.id}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {lg.event_name}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'text-xs px-2 py-0.5 rounded-full capitalize',
                          lg.delivery_status === 'success'
                            ? 'bg-green-100 text-green-700'
                            : lg.delivery_status === 'failed'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-yellow-100 text-yellow-700',
                        )}
                      >
                        {lg.delivery_status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {lg.http_status ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{lg.attempts}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {fmtDateTime(lg.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {lg.delivery_status === 'failed' && (
                        <button
                          onClick={() => retry(lg.id)}
                          disabled={busyId === lg.id}
                          className="inline-flex items-center gap-1 text-green-600 hover:underline text-xs disabled:opacity-40"
                        >
                          <RefreshCw size={13} /> Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm">
            <span className="text-gray-500">
              Page {page} of {pages} · {total} total
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'p-2 rounded-lg hover:bg-gray-100 disabled:opacity-40',
        danger ? 'text-red-500' : 'text-gray-500',
      )}
    >
      {children}
    </button>
  );
}
