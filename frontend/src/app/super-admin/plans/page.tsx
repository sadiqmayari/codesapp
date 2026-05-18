'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil } from 'lucide-react';
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
}

const EMPTY: PlanForm = {
  plan_name: '',
  contact_limit: 0,
  template_limit: 0,
  user_limit: 0,
  monthly_price: 0,
  setup_fee: 0,
  webhook_enabled: true,
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
  }, [router, toast]);

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
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Plans</h2>
        <button
          onClick={() => setForm({ ...EMPTY })}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg"
        >
          <Plus size={16} /> New plan
        </button>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-gray-400">
              <tr>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Contacts</th>
                <th className="px-4 py-3">Templates</th>
                <th className="px-4 py-3">Users</th>
                <th className="px-4 py-3">Monthly</th>
                <th className="px-4 py-3">Setup</th>
                <th className="px-4 py-3">Webhooks</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-10 text-center text-gray-500"
                  >
                    No plans yet.
                  </td>
                </tr>
              ) : (
                rows.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t border-gray-700 hover:bg-gray-700"
                  >
                    <td className="px-4 py-3 font-medium text-white capitalize">
                      {p.plan_name}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {p.contact_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {p.template_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {p.user_limit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      ${num(p.monthly_price).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      ${num(p.setup_fee).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          p.webhook_enabled
                            ? 'text-green-400'
                            : 'text-gray-500'
                        }
                      >
                        {p.webhook_enabled ? 'Yes' : 'No'}
                      </span>
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
                          })
                        }
                        className="text-green-400 hover:text-green-300"
                        title="Edit"
                      >
                        <Pencil size={16} />
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
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
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
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
      />
    </div>
  );
}
