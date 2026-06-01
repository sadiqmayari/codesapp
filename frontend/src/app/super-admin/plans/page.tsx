'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, CreditCard } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import type { Plan } from '@/lib/crm-types';

interface PlanForm {
  id?: number;
  plan_name: string;
  contact_limit: number;
  template_limit: number;
  user_limit: number;
  monthly_price: number;
  setup_fee: number;
  webhook_enabled: boolean;
  ai_enabled: boolean;
  // Public pricing-card fields
  is_public: boolean;
  display_order: number;
  is_highlighted: boolean;
  tagline: string;
  features: string; // edited as one-per-line textarea
  cta_label: string;
  currency: string;
  billing_period: string;
}

const EMPTY: PlanForm = {
  plan_name: '',
  contact_limit: 0,
  template_limit: 0,
  user_limit: 0,
  monthly_price: 0,
  setup_fee: 0,
  webhook_enabled: true,
  ai_enabled: false,
  is_public: false,
  display_order: 0,
  is_highlighted: false,
  tagline: '',
  features: '',
  cta_label: '',
  currency: 'PKR',
  billing_period: 'month',
};

function num(v: string | number) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

export default function SuperAdminPlansPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<PlanForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await apiFetch<Plan[]>('/super-admin/plans'));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load plans',
      );
    } finally {
      setLoading(false);
    }
    // `router` + `toast` deliberately omitted (unstable identities in Next 14
    // / React context). Both are stable for our purposes — methods only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    if (!form.plan_name.trim()) {
      toast.error('Plan name is required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        plan_name: form.plan_name.trim(),
        contact_limit: Number(form.contact_limit),
        template_limit: Number(form.template_limit),
        user_limit: Number(form.user_limit),
        monthly_price: Number(form.monthly_price),
        setup_fee: Number(form.setup_fee),
        webhook_enabled: form.webhook_enabled,
        ai_enabled: form.ai_enabled,
        is_public: form.is_public,
        display_order: Number(form.display_order),
        is_highlighted: form.is_highlighted,
        tagline: form.tagline.trim() || null,
        cta_label: form.cta_label.trim() || null,
        currency: form.currency.trim() || 'PKR',
        billing_period: form.billing_period.trim() || 'month',
        features: form.features
          .split('\n')
          .map((f) => f.trim())
          .filter((f) => f.length > 0),
      };
      if (form.id) {
        await apiFetch(`/super-admin/plans/${form.id}`, {
          method: 'PATCH',
          body,
        });
        toast.success('Plan updated');
      } else {
        await apiFetch('/super-admin/plans', { method: 'POST', body });
        toast.success('Plan created');
      }
      setForm(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
              <CreditCard size={18} />
            </span>
            Plans
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Subscription tiers, limits, and pricing applied to clients.
          </p>
        </div>
        <button
          onClick={() => setForm({ ...EMPTY })}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg shadow-sm"
        >
          <Plus size={16} /> New plan
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-right px-4 py-3 font-medium">Contacts</th>
                <th className="text-right px-4 py-3 font-medium">Templates</th>
                <th className="text-right px-4 py-3 font-medium">Users</th>
                <th className="text-right px-4 py-3 font-medium">Monthly</th>
                <th className="text-right px-4 py-3 font-medium">Setup</th>
                <th className="text-left px-4 py-3 font-medium">Webhooks</th>
                <th className="text-left px-4 py-3 font-medium">Public</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-10 text-center text-gray-400"
                  >
                    No plans yet.
                  </td>
                </tr>
              ) : (
                rows.map((p) => (
                  <tr
                    key={p.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 capitalize">
                      {p.plan_name}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                      {p.contact_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                      {p.template_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                      {p.user_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-800 tabular-nums font-medium">
                      ${num(p.monthly_price).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                      ${num(p.setup_fee).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          p.webhook_enabled
                            ? 'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200'
                            : 'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200'
                        }
                      >
                        {p.webhook_enabled ? 'Yes' : 'No'}
                      </span>
                      {p.ai_enabled && (
                        <span className="ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-violet-50 text-violet-700 border border-violet-200">
                          AI
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.is_public ? (
                        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Public
                          {p.is_highlighted && ' ★'}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">Hidden</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() =>
                          setForm({
                            id: p.id,
                            plan_name: p.plan_name,
                            contact_limit: p.contact_limit,
                            template_limit: p.template_limit,
                            user_limit: p.user_limit,
                            monthly_price: num(p.monthly_price),
                            setup_fee: num(p.setup_fee),
                            webhook_enabled: p.webhook_enabled,
                            ai_enabled: p.ai_enabled ?? false,
                            is_public: p.is_public ?? false,
                            display_order: p.display_order ?? 0,
                            is_highlighted: p.is_highlighted ?? false,
                            tagline: p.tagline ?? '',
                            features: (p.features ?? []).join('\n'),
                            cta_label: p.cta_label ?? '',
                            currency: p.currency ?? 'PKR',
                            billing_period: p.billing_period ?? 'month',
                          })
                        }
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:bg-green-50 hover:text-green-700 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit plan' : 'New plan'}
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
          <div className="space-y-4 text-gray-800">
            <Inp
              label="Plan name"
              value={form.plan_name}
              onChange={(v) => setForm({ ...form, plan_name: v })}
            />
            <div className="grid grid-cols-2 gap-4">
              <NumInp
                label="Contact limit"
                value={form.contact_limit}
                onChange={(v) => setForm({ ...form, contact_limit: v })}
              />
              <NumInp
                label="Template limit"
                value={form.template_limit}
                onChange={(v) => setForm({ ...form, template_limit: v })}
              />
              <NumInp
                label="User limit"
                value={form.user_limit}
                onChange={(v) => setForm({ ...form, user_limit: v })}
              />
              <NumInp
                label="Monthly price ($)"
                value={form.monthly_price}
                onChange={(v) => setForm({ ...form, monthly_price: v })}
              />
              <NumInp
                label="Setup fee ($)"
                value={form.setup_fee}
                onChange={(v) => setForm({ ...form, setup_fee: v })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.webhook_enabled}
                onChange={(e) =>
                  setForm({ ...form, webhook_enabled: e.target.checked })
                }
              />
              Webhooks enabled for this plan
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.ai_enabled}
                onChange={(e) =>
                  setForm({ ...form, ai_enabled: e.target.checked })
                }
              />
              AI Copilot enabled for this plan
            </label>

            {/* ── Public pricing card ───────────────────────────────── */}
            <div className="pt-3 border-t border-gray-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
                Public pricing card (landing page)
              </p>
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.is_public}
                    onChange={(e) =>
                      setForm({ ...form, is_public: e.target.checked })
                    }
                  />
                  Show this plan on the public pricing section
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.is_highlighted}
                    onChange={(e) =>
                      setForm({ ...form, is_highlighted: e.target.checked })
                    }
                  />
                  Highlight as “Most popular”
                </label>
                <Inp
                  label="Tagline (short subtitle)"
                  value={form.tagline}
                  onChange={(v) => setForm({ ...form, tagline: v })}
                />
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Features (one per line)
                  </label>
                  <textarea
                    value={form.features}
                    onChange={(e) =>
                      setForm({ ...form, features: e.target.value })
                    }
                    rows={4}
                    placeholder={'Shared team inbox\nBroadcast campaigns\nShopify integration'}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Inp
                    label="Currency"
                    value={form.currency}
                    onChange={(v) => setForm({ ...form, currency: v })}
                  />
                  <Inp
                    label="Billing period (e.g. month)"
                    value={form.billing_period}
                    onChange={(v) => setForm({ ...form, billing_period: v })}
                  />
                  <Inp
                    label="CTA label (default “Get Started”)"
                    value={form.cta_label}
                    onChange={(v) => setForm({ ...form, cta_label: v })}
                  />
                  <NumInp
                    label="Display order"
                    value={form.display_order}
                    onChange={(v) => setForm({ ...form, display_order: v })}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Inp({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent"
      />
    </div>
  );
}

function NumInp({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent"
      />
    </div>
  );
}
