'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  CheckCircle2,
  Ban,
  LogIn,
  Trash2,
  AlertTriangle,
  Copy,
  Users,
  MessageSquare,
  FileText,
  Receipt,
  CircleDollarSign,
  Activity,
  Send,
  ShieldAlert,
  Plus,
  Store,
  Phone,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { cn, fmtDate, fmtDateTime, mediaUrl } from '@/lib/utils';
import type {
  ActivationStatus,
  Invoice,
  InvoiceStatus,
  Subscription,
  UsageLimitAction,
} from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Local types for the expanded payload returned by GET /super-admin/clients/:id/detail
// ---------------------------------------------------------------------------

interface ClientDetail {
  company: {
    id: number;
    name: string;
    address: string | null;
    activation_status: ActivationStatus;
    activated_at: string | null;
    suspended_at: string | null;
    grace_until: string | null;
    usage_limit_action: UsageLimitAction | null;
    effective_usage_limit_action: UsageLimitAction;
    // Phase 4 — per-client limit overrides + the resolved effective caps
    contact_limit_override: number | null;
    template_limit_override: number | null;
    user_limit_override: number | null;
    effective_limits: {
      contact_limit: number;
      template_limit: number;
      user_limit: number;
    } | null;
    logo_url: string | null;
    created_at: string;
    waba_id: string | null;
    phone_number_id: string | null;
    webhook_key: string | null;
    has_webhook_app_secret: boolean;
    shopify_webhook_key: string | null;
    has_shopify_webhook_secret: boolean;
    has_shopify_admin_token: boolean;
    default_country_code: string | null;
    onboarding_status: Record<string, unknown> | null;
  };
  subscription: Subscription | null;
  users: Array<{
    id: number;
    name: string;
    email: string;
    role: string;
    status: string;
    created_at: string;
  }>;
  snapshot: {
    period: string;
    mrrUsd: number;
    activeContacts: number;
    totalContacts: number;
    templates: number;
    activeUsers: number;
    openInvoices: number;
    outstandingUsd: number;
    windowOpenChats: number;
    messagesThisMonth: number;
    conversationsThisMonth: number;
  };
  usage: {
    period: string;
    messages_sent: number;
    contacts_stored: number;
    templates_used: number;
    webhook_calls: number;
    conversations_opened: number;
  } | null;
  invoices: Array<Invoice>;
  shopify: {
    id: number;
    shop_domain: string;
    status: string;
    active_events: unknown;
    created_at: string;
  } | null;
  audit: Array<{
    id: number;
    action: string;
    entity: string;
    entity_id: number | null;
    ip_address: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    user: { id: number; name: string; email: string } | null;
  }>;
}

// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: ActivationStatus }) {
  const map = {
    active: 'bg-green-50 text-green-700 border-green-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    suspended: 'bg-red-50 text-red-700 border-red-200',
  } as const;
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize border',
        map[status],
      )}
    >
      {status}
    </span>
  );
}

function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize border',
        status === 'paid' && 'bg-green-50 text-green-700 border-green-200',
        status === 'pending' && 'bg-amber-50 text-amber-700 border-amber-200',
        status === 'overdue' && 'bg-red-50 text-red-700 border-red-200',
        status === 'cancelled' && 'bg-gray-100 text-gray-600 border-gray-200',
      )}
    >
      {status}
    </span>
  );
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
  );
}

// ---------------------------------------------------------------------------

export default function SuperAdminClientProfilePage() {
  const router = useRouter();
  const toast = useToast();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);

  const [data, setData] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // mutating action flags
  const [statusBusy, setStatusBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [markBusyId, setMarkBusyId] = useState<number | null>(null);

  // local form state
  const [graceDate, setGraceDate] = useState('');

  // confirm dialogs
  const [confirmStatus, setConfirmStatus] = useState<
    'activate' | 'suspend' | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTypeName, setDeleteTypeName] = useState('');

  // per-client limit overrides (Phase 4)
  const [overrideEdit, setOverrideEdit] = useState<{
    contact: string;
    template: string;
    user: string;
  } | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);

  // one-off invoice modal (Phase 3)
  const [oneOffOpen, setOneOffOpen] = useState(false);
  const [oneOffAmount, setOneOffAmount] = useState('');
  const [oneOffDescription, setOneOffDescription] = useState('');
  const [oneOffDueDate, setOneOffDueDate] = useState('');
  const [oneOffBusy, setOneOffBusy] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(id)) return;
    setLoading(true);
    setError('');
    try {
      const d = await apiFetch<ClientDetail>(
        `/super-admin/clients/${id}/detail`,
        { noOnboardingRedirect: true },
      );
      setData(d);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load client',
      );
    } finally {
      setLoading(false);
    }
    // `router` deliberately omitted (unstable identity in Next 14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // ---------- actions ----------

  const setStatus = async () => {
    if (!confirmStatus || !data) return;
    setStatusBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}/${confirmStatus}`, {
        method: 'PATCH',
        noOnboardingRedirect: true,
      });
      toast.success(
        confirmStatus === 'activate' ? 'Client activated' : 'Client suspended',
      );
      setConfirmStatus(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
    } finally {
      setStatusBusy(false);
    }
  };

  const setUsagePolicy = async (action: UsageLimitAction | null) => {
    setPolicyBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}/usage-limit-action`, {
        method: 'PATCH',
        body: { action },
        noOnboardingRedirect: true,
      });
      toast.success('Usage-limit policy saved');
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to save policy',
      );
    } finally {
      setPolicyBusy(false);
    }
  };

  const grantGrace = async (until: string | null) => {
    setPolicyBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}/grace`, {
        method: 'PATCH',
        body: { until },
        noOnboardingRedirect: true,
      });
      toast.success(until ? 'Grace period granted' : 'Grace cleared');
      setGraceDate('');
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to set grace',
      );
    } finally {
      setPolicyBusy(false);
    }
  };

  const impersonate = async () => {
    setActionBusy(true);
    try {
      const res = await apiFetch<{ impersonationToken: string }>(
        `/super-admin/impersonate/${id}`,
        { method: 'POST', noOnboardingRedirect: true },
      );
      window.localStorage.setItem(
        'ca_impersonation_token',
        res.impersonationToken,
      );
      document.cookie =
        'ca_impersonation_handoff=1; path=/; max-age=30; samesite=lax';
      window.open('/dashboard', '_blank');
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Impersonation failed',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const openOverrideEditor = () => {
    if (!data) return;
    setOverrideEdit({
      contact:
        data.company.contact_limit_override === null
          ? ''
          : String(data.company.contact_limit_override),
      template:
        data.company.template_limit_override === null
          ? ''
          : String(data.company.template_limit_override),
      user:
        data.company.user_limit_override === null
          ? ''
          : String(data.company.user_limit_override),
    });
  };

  const parseOverride = (v: string): number | null | undefined => {
    const trimmed = v.trim();
    if (trimmed === '') return null; // explicit clear
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return undefined; // invalid → skip
    return Math.floor(n);
  };

  const saveOverrides = async () => {
    if (!overrideEdit) return;
    const body: Record<string, number | null> = {};
    const c = parseOverride(overrideEdit.contact);
    const t = parseOverride(overrideEdit.template);
    const u = parseOverride(overrideEdit.user);
    if (c === undefined && overrideEdit.contact.trim() !== '') {
      toast.error('Contacts override must be a non-negative number');
      return;
    }
    if (t === undefined && overrideEdit.template.trim() !== '') {
      toast.error('Templates override must be a non-negative number');
      return;
    }
    if (u === undefined && overrideEdit.user.trim() !== '') {
      toast.error('Users override must be a non-negative number');
      return;
    }
    if (c !== undefined) body.contact_limit = c;
    if (t !== undefined) body.template_limit = t;
    if (u !== undefined) body.user_limit = u;

    setOverrideBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}/limits`, {
        method: 'PATCH',
        body,
        noOnboardingRedirect: true,
      });
      toast.success('Limit overrides saved');
      setOverrideEdit(null);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to save overrides',
      );
    } finally {
      setOverrideBusy(false);
    }
  };

  const createOneOff = async () => {
    const amt = Number(oneOffAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Amount must be greater than 0');
      return;
    }
    setOneOffBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}/invoices`, {
        method: 'POST',
        body: {
          amount: amt,
          description: oneOffDescription.trim() || undefined,
          dueDate: oneOffDueDate
            ? new Date(oneOffDueDate + 'T23:59:59').toISOString()
            : undefined,
        },
        noOnboardingRedirect: true,
      });
      toast.success('Invoice created');
      setOneOffOpen(false);
      setOneOffAmount('');
      setOneOffDescription('');
      setOneOffDueDate('');
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to create invoice',
      );
    } finally {
      setOneOffBusy(false);
    }
  };

  const markPaid = async (invoiceId: number) => {
    setMarkBusyId(invoiceId);
    try {
      await apiFetch(`/super-admin/billing/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        noOnboardingRedirect: true,
      });
      toast.success('Invoice marked paid');
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Mark-paid failed',
      );
    } finally {
      setMarkBusyId(null);
    }
  };

  const runDelete = async () => {
    if (!data) return;
    setActionBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${id}`, {
        method: 'DELETE',
        noOnboardingRedirect: true,
      });
      toast.success('Client deleted');
      router.replace('/super-admin/clients');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
      setActionBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Copy failed');
    }
  };

  // ---------- derived ----------

  const callbackUrl = useMemo(() => {
    if (!data?.company.webhook_key) return null;
    if (typeof window === 'undefined') return null;
    return `${window.location.origin}/webhooks/meta/${data.company.webhook_key}`;
  }, [data]);

  const shopifyCallbackUrl = useMemo(() => {
    if (!data?.company.shopify_webhook_key) return null;
    if (typeof window === 'undefined') return null;
    return `${window.location.origin}/webhooks/shopify/${data.company.shopify_webhook_key}`;
  }, [data]);

  // ---------- render ----------

  if (loading && !data) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error || 'Client not found.'}
        </div>
        <Link
          href="/super-admin/clients"
          className="mt-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={14} /> Back to clients
        </Link>
      </div>
    );
  }

  const c = data.company;
  const sub = data.subscription;
  const s = data.snapshot;
  const u = data.usage;
  const overdueBadge =
    c.activation_status === 'suspended' && c.suspended_at
      ? daysSince(c.suspended_at)
      : 0;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Breadcrumb */}
      <Link
        href="/super-admin/clients"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={14} /> All clients
      </Link>

      {/* Header strip */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col lg:flex-row gap-5 lg:items-center">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {c.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(c.logo_url) ?? c.logo_url}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-gray-200 shrink-0"
            />
          ) : (
            <span className="w-16 h-16 rounded-xl bg-gradient-to-br from-green-100 to-emerald-100 text-green-700 flex items-center justify-center text-2xl font-semibold shrink-0">
              {c.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">
              {c.name}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <StatusPill status={c.activation_status} />
              {sub && (
                <span className="inline-block rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-0.5 text-xs font-medium capitalize">
                  {sub.plan_name}
                </span>
              )}
              <span className="text-xs text-gray-500">
                #{c.id} · created {fmtDate(c.created_at)} ·{' '}
                {daysSince(c.created_at)}d ago
              </span>
              {overdueBadge > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 text-[11px] font-medium">
                  <AlertTriangle size={11} /> Suspended {overdueBadge}d
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-right mr-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-400">
              MRR
            </div>
            <div className="text-xl font-bold text-green-700 tabular-nums">
              ${s.mrrUsd.toLocaleString()}
            </div>
          </div>
          {c.activation_status === 'pending' && (
            <button
              onClick={() => setConfirmStatus('activate')}
              disabled={statusBusy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              <CheckCircle2 size={15} /> Activate
            </button>
          )}
          {c.activation_status === 'active' && (
            <button
              onClick={() => setConfirmStatus('suspend')}
              disabled={statusBusy}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              <Ban size={15} /> Suspend
            </button>
          )}
          {c.activation_status === 'suspended' && (
            <button
              onClick={() => setConfirmStatus('activate')}
              disabled={statusBusy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              <CheckCircle2 size={15} /> Reactivate
            </button>
          )}
          <button
            onClick={impersonate}
            disabled={actionBusy}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm px-3 py-2 disabled:opacity-50"
          >
            <LogIn size={15} /> Impersonate
          </button>
        </div>
      </div>

      {/* Snapshot tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <Tile
          label="Active contacts"
          value={s.activeContacts.toLocaleString()}
          sub={`${s.totalContacts.toLocaleString()} total`}
          icon={Users}
          tone="green"
        />
        <Tile
          label="Templates"
          value={s.templates.toLocaleString()}
          icon={FileText}
          tone="blue"
        />
        <Tile
          label="Active users"
          value={s.activeUsers.toLocaleString()}
          sub={`${data.users.length} on record`}
          icon={Users}
          tone="slate"
        />
        <Tile
          label="Messages (mo)"
          value={s.messagesThisMonth.toLocaleString()}
          icon={Send}
          tone="purple"
        />
        <Tile
          label="Convos (mo)"
          value={s.conversationsThisMonth.toLocaleString()}
          icon={MessageSquare}
          tone="blue"
        />
        <Tile
          label="Window-open"
          value={s.windowOpenChats.toLocaleString()}
          sub="24hr WhatsApp window"
          icon={MessageSquare}
          tone="amber"
        />
        <Tile
          label="Open invoices"
          value={s.openInvoices.toLocaleString()}
          icon={Receipt}
          tone={s.openInvoices > 0 ? 'amber' : 'slate'}
        />
        <Tile
          label="Outstanding"
          value={`$${s.outstandingUsd.toLocaleString()}`}
          icon={CircleDollarSign}
          tone={s.outstandingUsd > 0 ? 'red' : 'slate'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Users */}
        <Card title={`Owner & users (${data.users.length})`} className="lg:col-span-2">
          <div className="overflow-x-auto -mx-5">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2 font-medium">Name</th>
                  <th className="text-left px-5 py-2 font-medium">Email</th>
                  <th className="text-left px-5 py-2 font-medium">Role</th>
                  <th className="text-left px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.users.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-5 py-4 text-center text-gray-400"
                    >
                      No users on record.
                    </td>
                  </tr>
                ) : (
                  data.users.map((user) => (
                    <tr key={user.id}>
                      <td className="px-5 py-2 text-gray-900 font-medium">
                        {user.name}
                      </td>
                      <td className="px-5 py-2 text-gray-600">{user.email}</td>
                      <td className="px-5 py-2 text-gray-600">
                        <span className="inline-block rounded-full bg-slate-100 text-slate-700 px-2 py-0.5 text-[11px] font-medium capitalize">
                          {user.role}
                        </span>
                      </td>
                      <td className="px-5 py-2">
                        <span
                          className={cn(
                            'inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
                            user.status === 'active'
                              ? 'bg-green-50 text-green-700'
                              : user.status === 'pending'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-gray-100 text-gray-500',
                          )}
                        >
                          {user.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Integrations */}
        <Card title="Integrations">
          <div className="space-y-3">
            <IntegrationRow
              icon={Phone}
              tone="green"
              label="WhatsApp Cloud API"
              connected={!!c.waba_id && !!c.phone_number_id}
              detail={
                c.waba_id && c.phone_number_id
                  ? `WABA ${c.waba_id} · phone ${c.phone_number_id}`
                  : 'Not onboarded'
              }
            />
            <IntegrationRow
              icon={ShieldAlert}
              tone="purple"
              label="Meta webhook"
              connected={!!c.webhook_key}
              detail={
                c.webhook_key
                  ? c.has_webhook_app_secret
                    ? 'Per-tenant app secret set'
                    : 'Using platform fallback'
                  : 'Not configured'
              }
            />
            <IntegrationRow
              icon={Store}
              tone="emerald"
              label="Shopify"
              connected={c.has_shopify_admin_token || !!data.shopify}
              detail={
                data.shopify
                  ? `${data.shopify.shop_domain} · ${data.shopify.status}`
                  : c.has_shopify_admin_token
                    ? 'Admin token set (custom app)'
                    : 'Not connected'
              }
            />
          </div>
        </Card>
      </div>

      {/* WhatsApp + Shopify webhook URLs (copy chips) */}
      {(callbackUrl || shopifyCallbackUrl) && (
        <Card title="Webhook callbacks">
          <div className="space-y-2">
            {callbackUrl && (
              <CopyChip
                label="Meta callback URL"
                value={callbackUrl}
                onCopy={() => copy(callbackUrl, 'Meta callback URL')}
              />
            )}
            {shopifyCallbackUrl && (
              <CopyChip
                label="Shopify webhook URL"
                value={shopifyCallbackUrl}
                onCopy={() =>
                  copy(shopifyCallbackUrl, 'Shopify webhook URL')
                }
              />
            )}
          </div>
        </Card>
      )}

      {/* Plan & limits */}
      <Card title="Plan & limits" right={sub?.plan_name ?? '—'}>
        {!sub ? (
          <p className="text-sm text-gray-400">No subscription assigned.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <LimitBar
                label="Contacts"
                value={u?.contacts_stored ?? 0}
                limit={c.effective_limits?.contact_limit ?? sub.contact_limit}
                override={c.contact_limit_override}
                planDefault={sub.contact_limit}
              />
              <LimitBar
                label="Templates"
                value={u?.templates_used ?? 0}
                limit={c.effective_limits?.template_limit ?? sub.template_limit}
                override={c.template_limit_override}
                planDefault={sub.template_limit}
              />
              <LimitBar
                label="Users"
                value={s.activeUsers}
                limit={c.effective_limits?.user_limit ?? sub.user_limit}
                override={c.user_limit_override}
                planDefault={sub.user_limit}
              />
            </div>
            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs">
              <span className="text-gray-500">
                Effective limit = override ?? plan default. Empty input on
                save = clear override.
              </span>
              <button
                onClick={openOverrideEditor}
                className="rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-medium px-2.5 py-1"
              >
                Edit overrides
              </button>
            </div>
          </>
        )}
        {sub && (
          <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <KV label="Monthly price" value={`$${num(sub.monthly_price).toFixed(2)}`} />
            <KV label="Webhook calls (mo)" value={(u?.webhook_calls ?? 0).toLocaleString()} />
            <KV label="Messages sent (mo)" value={(u?.messages_sent ?? 0).toLocaleString()} />
            <KV label="Convos opened (mo)" value={(u?.conversations_opened ?? 0).toLocaleString()} />
          </div>
        )}
      </Card>

      {/* Billing & lifecycle */}
      <Card title="Billing & lifecycle">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs mb-4">
          <KV
            label="Activated"
            value={c.activated_at ? fmtDate(c.activated_at) : 'Not yet'}
          />
          <KV
            label="Suspended"
            value={c.suspended_at ? fmtDate(c.suspended_at) : '—'}
          />
          <KV
            label="Grace until"
            value={c.grace_until ? fmtDate(c.grace_until) : '—'}
          />
          <KV
            label="Usage-limit policy"
            value={
              <span>
                <span className="capitalize">
                  {c.effective_usage_limit_action.replace('_', ' ')}
                </span>
                {c.usage_limit_action !== null && (
                  <span className="text-[10px] text-gray-400">
                    {' '}
                    (override)
                  </span>
                )}
              </span>
            }
          />
        </div>

        {/* Usage policy + grace controls */}
        <div className="bg-gray-50/60 rounded-lg border border-gray-200 p-4 mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Override usage-limit policy
            </label>
            <select
              value={c.usage_limit_action ?? ''}
              disabled={policyBusy}
              onChange={(e) =>
                setUsagePolicy(
                  e.target.value === ''
                    ? null
                    : (e.target.value as UsageLimitAction),
                )
              }
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-600"
            >
              <option value="">Use platform default</option>
              <option value="block">Block (hard limit)</option>
              <option value="warn_only">Warn only (soft)</option>
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              Override beats the platform-wide default.
            </p>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Grant extra time (skip auto-suspend until)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={graceDate}
                disabled={policyBusy}
                onChange={(e) => setGraceDate(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-600"
              />
              <button
                onClick={() =>
                  graceDate &&
                  grantGrace(
                    new Date(graceDate + 'T23:59:59').toISOString(),
                  )
                }
                disabled={policyBusy || !graceDate}
                className="rounded-lg bg-green-600 hover:bg-green-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              >
                Grant
              </button>
              {c.grace_until && (
                <button
                  onClick={() => grantGrace(null)}
                  disabled={policyBusy}
                  className="rounded-lg border border-gray-300 hover:bg-white px-3 py-2 text-xs font-medium text-gray-700 disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Invoices */}
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <Receipt size={12} /> Invoices ({data.invoices.length})
          </h4>
          <button
            onClick={() => setOneOffOpen(true)}
            className="flex items-center gap-1 rounded-lg border border-green-200 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium px-2.5 py-1"
            title="Create a one-off invoice (off-cycle)"
          >
            <Plus size={12} /> New invoice
          </button>
        </div>
        <div className="overflow-x-auto -mx-5">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-2 font-medium">Invoice</th>
                <th className="text-left px-5 py-2 font-medium">Period</th>
                <th className="text-right px-5 py-2 font-medium">Amount</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Due</th>
                <th className="text-left px-5 py-2 font-medium">Paid</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.invoices.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-5 py-4 text-center text-gray-400"
                  >
                    No invoices yet.
                  </td>
                </tr>
              ) : (
                data.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-5 py-2 font-mono text-xs text-gray-600">
                      {inv.invoice_number ?? `#${inv.id}`}
                    </td>
                    <td className="px-5 py-2 text-gray-500">
                      {inv.period ?? '—'}
                    </td>
                    <td className="px-5 py-2 text-right text-gray-800 tabular-nums font-medium">
                      ${num(inv.amount).toFixed(2)}
                    </td>
                    <td className="px-5 py-2">
                      <InvoiceStatusPill status={inv.status} />
                    </td>
                    <td className="px-5 py-2 text-gray-500">
                      {fmtDate(inv.due_date)}
                    </td>
                    <td className="px-5 py-2 text-gray-500">
                      {inv.paid_at ? fmtDate(inv.paid_at) : '—'}
                    </td>
                    <td className="px-5 py-2 text-right">
                      {(inv.status === 'pending' ||
                        inv.status === 'overdue') && (
                        <button
                          onClick={() => markPaid(inv.id)}
                          disabled={markBusyId === inv.id}
                          className="rounded-lg bg-green-600 hover:bg-green-700 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          {markBusyId === inv.id ? '…' : 'Mark paid'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Activity */}
      <Card
        title="Activity log"
        right={`Last ${data.audit.length}`}
      >
        {data.audit.length === 0 ? (
          <p className="text-sm text-gray-400 py-2">No activity yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.audit.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-2 py-1.5 border-b border-gray-50 last:border-b-0"
              >
                <Activity size={12} className="mt-1 text-green-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700">
                    <span className="font-medium text-gray-900">
                      {a.user?.name ?? 'system'}
                    </span>{' '}
                    ·{' '}
                    <code className="font-mono text-[11px] bg-green-50 border border-green-200 text-green-700 rounded px-1.5 py-0.5">
                      {a.action}
                    </code>
                    {a.entity && (
                      <span className="text-gray-500"> on {a.entity}</span>
                    )}
                    {a.entity_id != null && (
                      <span className="text-gray-400"> #{a.entity_id}</span>
                    )}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {fmtDateTime(a.created_at)}
                    {a.ip_address && (
                      <span className="font-mono"> · {a.ip_address}</span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Danger zone — Minimal: Delete only (see PROGRESS.md "Phase 2 Danger-zone DEFERRED") */}
      <div className="rounded-xl border-2 border-red-200 bg-red-50/40 p-5">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={16} className="text-red-600" />
          <h3 className="text-sm font-semibold text-red-700">Danger zone</h3>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Delete this client</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Permanently deletes <strong>{c.name}</strong> and ALL of its data —
              contacts, conversations, messages, templates, bots, broadcasts,
              invoices, users. This cannot be undone.
            </p>
          </div>
          <button
            onClick={() => {
              setDeleteTypeName('');
              setConfirmDelete(true);
            }}
            disabled={actionBusy}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm px-3 py-2 disabled:opacity-50 shrink-0"
          >
            <Trash2 size={15} /> Delete client
          </button>
        </div>
      </div>

      {/* Confirm: status change */}
      <ConfirmDialog
        open={!!confirmStatus}
        title={
          confirmStatus === 'suspend' ? 'Suspend client' : 'Activate client'
        }
        message={
          confirmStatus === 'suspend'
            ? `Suspend "${c.name}"? The tenant owner will be unable to sign in until reactivated.`
            : `Activate "${c.name}"? The tenant owner will be able to sign in immediately.`
        }
        confirmLabel={confirmStatus === 'suspend' ? 'Suspend' : 'Activate'}
        danger={confirmStatus === 'suspend'}
        busy={statusBusy}
        onConfirm={setStatus}
        onCancel={() => !statusBusy && setConfirmStatus(null)}
      />

      {/* Per-client limit-override editor (Phase 4) */}
      {overrideEdit && sub && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !overrideBusy && setOverrideEdit(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              Edit limit overrides
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              For <strong>{c.name}</strong>. Leave a field blank to clear that
              override and use the plan default ({sub.plan_name}).
            </p>

            <div className="mt-4 space-y-3">
              {[
                {
                  key: 'contact' as const,
                  label: 'Contacts',
                  def: sub.contact_limit,
                },
                {
                  key: 'template' as const,
                  label: 'Templates',
                  def: sub.template_limit,
                },
                {
                  key: 'user' as const,
                  label: 'Users',
                  def: sub.user_limit,
                },
              ].map(({ key, label, def }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-600 mb-1 flex items-center justify-between">
                    <span>{label}</span>
                    <span className="text-gray-400">
                      Plan default: {def.toLocaleString()}
                    </span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={overrideEdit[key]}
                    onChange={(e) =>
                      setOverrideEdit({
                        ...overrideEdit,
                        [key]: e.target.value,
                      })
                    }
                    placeholder={`(blank = use ${def.toLocaleString()})`}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => !overrideBusy && setOverrideEdit(null)}
                disabled={overrideBusy}
                className="rounded-lg border border-gray-300 hover:bg-gray-50 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveOverrides}
                disabled={overrideBusy}
                className="rounded-lg bg-green-600 hover:bg-green-700 text-white px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {overrideBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* One-off invoice modal (Phase 3) */}
      {oneOffOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !oneOffBusy && setOneOffOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Receipt size={18} className="text-green-600" /> New one-off
              invoice
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              For <strong>{c.name}</strong>. Off-cycle — distinct from the
              activation-anchored 30-day cycle invoices the cron raises.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Amount (USD)
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  autoFocus
                  value={oneOffAmount}
                  onChange={(e) => setOneOffAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Description{' '}
                  <span className="text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={oneOffDescription}
                  onChange={(e) => setOneOffDescription(e.target.value)}
                  rows={2}
                  placeholder="e.g. Custom setup work · April"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 resize-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Due date{' '}
                  <span className="text-gray-400">
                    (optional — defaults to +7 days)
                  </span>
                </label>
                <input
                  type="date"
                  value={oneOffDueDate}
                  onChange={(e) => setOneOffDueDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => !oneOffBusy && setOneOffOpen(false)}
                disabled={oneOffBusy}
                className="rounded-lg border border-gray-300 hover:bg-gray-50 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={createOneOff}
                disabled={oneOffBusy || !oneOffAmount}
                className="rounded-lg bg-green-600 hover:bg-green-700 text-white px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {oneOffBusy ? 'Creating…' : 'Create invoice'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm: delete (type-the-name) */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !actionBusy && setConfirmDelete(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-red-700 flex items-center gap-2">
              <AlertTriangle size={18} /> Delete client permanently
            </h3>
            <p className="text-sm text-gray-700 mt-2">
              This will delete <strong>{c.name}</strong> and every contact,
              conversation, message, template, bot, broadcast, invoice, and
              user that belongs to it. <strong>This cannot be undone.</strong>
            </p>
            <label className="block text-xs text-gray-600 mt-4 mb-1">
              Type{' '}
              <code className="bg-gray-100 px-1 py-0.5 rounded">{c.name}</code>{' '}
              to confirm
            </label>
            <input
              autoFocus
              value={deleteTypeName}
              onChange={(e) => setDeleteTypeName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => !actionBusy && setConfirmDelete(false)}
                disabled={actionBusy}
                className="rounded-lg border border-gray-300 hover:bg-gray-50 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runDelete}
                disabled={actionBusy || deleteTypeName !== c.name}
                className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Card({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-white rounded-xl border border-gray-200 p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {right && (
          <span className="text-xs text-gray-400 capitalize">{right}</span>
        )}
      </div>
      {children}
    </div>
  );
}

const TILE_TONE: Record<
  string,
  { bg: string; ic: string; text: string }
> = {
  slate: {
    bg: 'from-slate-50 to-slate-50/20 border-slate-200',
    ic: 'bg-slate-100 text-slate-600',
    text: 'text-slate-800',
  },
  green: {
    bg: 'from-green-50 to-green-50/20 border-green-100',
    ic: 'bg-green-100 text-green-700',
    text: 'text-green-800',
  },
  amber: {
    bg: 'from-amber-50 to-amber-50/20 border-amber-100',
    ic: 'bg-amber-100 text-amber-700',
    text: 'text-amber-800',
  },
  red: {
    bg: 'from-red-50 to-red-50/20 border-red-100',
    ic: 'bg-red-100 text-red-700',
    text: 'text-red-800',
  },
  blue: {
    bg: 'from-blue-50 to-blue-50/20 border-blue-100',
    ic: 'bg-blue-100 text-blue-700',
    text: 'text-blue-800',
  },
  purple: {
    bg: 'from-purple-50 to-purple-50/20 border-purple-100',
    ic: 'bg-purple-100 text-purple-700',
    text: 'text-purple-800',
  },
  emerald: {
    bg: 'from-emerald-50 to-emerald-50/20 border-emerald-100',
    ic: 'bg-emerald-100 text-emerald-700',
    text: 'text-emerald-800',
  },
};

function Tile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  tone: keyof typeof TILE_TONE;
}) {
  const t = TILE_TONE[tone];
  return (
    <div
      className={cn(
        'rounded-xl border bg-gradient-to-br p-4 transition-transform hover:-translate-y-0.5',
        t.bg,
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </p>
        <span
          className={cn(
            'w-6 h-6 rounded-md flex items-center justify-center',
            t.ic,
          )}
        >
          <Icon size={12} />
        </span>
      </div>
      <p className={cn('text-xl font-bold mt-1.5', t.text)}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function KV({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="text-sm text-gray-900 mt-0.5">{value}</div>
    </div>
  );
}

function LimitBar({
  label,
  value,
  limit,
  override,
  planDefault,
}: {
  label: string;
  value: number;
  limit: number;
  override?: number | null;
  planDefault?: number;
}) {
  const pct =
    limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 0;
  const over = limit > 0 && value >= limit;
  const near = !over && limit > 0 && value >= limit * 0.8;
  const hasOverride = override !== null && override !== undefined;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-gray-600 flex items-center gap-1">
          {label}
          {hasOverride && (
            <span
              className="inline-block rounded-full bg-purple-100 text-purple-700 px-1.5 py-0 text-[9px] font-semibold"
              title={`Override active (plan default: ${planDefault?.toLocaleString() ?? '?'})`}
            >
              OVR
            </span>
          )}
        </span>
        <span
          className={cn(
            'text-xs tabular-nums',
            over && 'text-red-700 font-semibold',
            near && 'text-amber-700 font-semibold',
            !over && !near && 'text-gray-700',
          )}
        >
          {value.toLocaleString()}
          {limit > 0 && (
            <span className="text-gray-400">
              {' / '}
              {limit.toLocaleString()}
            </span>
          )}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            over && 'bg-red-500',
            near && 'bg-amber-500',
            !over && !near && 'bg-green-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">
        {pct}%
        {hasOverride && planDefault !== undefined && (
          <span className="ml-1 text-purple-600">
            · plan default {planDefault.toLocaleString()}
          </span>
        )}
      </p>
    </div>
  );
}

function IntegrationRow({
  icon: Icon,
  tone,
  label,
  connected,
  detail,
}: {
  icon: LucideIcon;
  tone: keyof typeof TILE_TONE;
  label: string;
  connected: boolean;
  detail: string;
}) {
  const t = TILE_TONE[tone];
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          t.ic,
        )}
      >
        <Icon size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-gray-900">{label}</span>
          <span
            className={cn(
              'inline-block rounded-full px-1.5 py-0 text-[10px] font-semibold',
              connected
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-500',
            )}
          >
            {connected ? 'Connected' : 'Off'}
          </span>
        </div>
        <p className="text-xs text-gray-500 truncate">{detail}</p>
      </div>
    </div>
  );
}

function CopyChip({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          {label}
        </div>
        <code className="block truncate text-xs text-gray-700 font-mono">
          {value}
        </code>
      </div>
      <button
        onClick={onCopy}
        className="rounded-lg border border-gray-200 bg-white hover:bg-gray-100 p-1.5 text-gray-600"
        title={`Copy ${label}`}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}
