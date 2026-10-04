'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import type { Plan } from '@/lib/crm-types';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

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
  proactive_notifications: boolean;
  shopify_store_limit: number;
  whatsapp_number_limit: number;
  extra_store_price: number;
  extra_number_price: number;
  is_public: boolean;
  display_order: number;
  is_highlighted: boolean;
  tagline: string;
  features: string;
  cta_label: string;
  currency: string;
  billing_period: string;
}

const EMPTY: PlanForm = {
  plan_name: '', contact_limit: 0, template_limit: 0, user_limit: 0,
  monthly_price: 0, setup_fee: 0, webhook_enabled: true, ai_enabled: false,
  proactive_notifications: false, shopify_store_limit: 1, whatsapp_number_limit: 1,
  extra_store_price: 0, extra_number_price: 0, is_public: false, display_order: 0,
  is_highlighted: false, tagline: '', features: '', cta_label: '', currency: 'PKR',
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
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
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
        proactive_notifications: form.proactive_notifications,
        shopify_store_limit: Number(form.shopify_store_limit),
        whatsapp_number_limit: Number(form.whatsapp_number_limit),
        extra_store_price: Number(form.extra_store_price),
        extra_number_price: Number(form.extra_number_price),
        is_public: form.is_public,
        display_order: Number(form.display_order),
        is_highlighted: form.is_highlighted,
        tagline: form.tagline.trim() || null,
        cta_label: form.cta_label.trim() || null,
        currency: form.currency.trim() || 'PKR',
        billing_period: form.billing_period.trim() || 'month',
        features: form.features.split('\n').map((f) => f.trim()).filter((f) => f.length > 0),
      };
      if (form.id) {
        await apiFetch(`/super-admin/plans/${form.id}`, { method: 'PATCH', body });
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
    <div className="sa-content">
      <SaPageHeader
        title="Plans"
        subtitle="Subscription tiers, limits, and pricing applied to clients."
        actions={
          <button className="sa-btn primary" onClick={() => setForm({ ...EMPTY })}>
            <Plus size={16} /> New plan
          </button>
        }
      />

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Plan</th><th className="n">Contacts</th><th className="n">Templates</th>
                <th className="n">Users</th><th className="n">Monthly</th><th className="n">Setup</th>
                <th>Webhooks</th><th>Public</th><th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9}><SaSpinner /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No plans yet.</td></tr>
              ) : (
                rows.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{p.plan_name}</td>
                    <td className="n">{p.contact_limit.toLocaleString()}</td>
                    <td className="n">{p.template_limit.toLocaleString()}</td>
                    <td className="n">{p.user_limit.toLocaleString()}</td>
                    <td className="n" style={{ fontWeight: 600 }}>${num(p.monthly_price).toFixed(2)}</td>
                    <td className="n">${num(p.setup_fee).toFixed(2)}</td>
                    <td>
                      <span className={`sa-pill ${p.webhook_enabled ? 'good' : 'slate'}`}>{p.webhook_enabled ? 'Yes' : 'No'}</span>
                      {p.ai_enabled && <span className="sa-pill info" style={{ marginLeft: 4 }}>AI</span>}
                    </td>
                    <td>
                      {p.is_public ? (
                        <span className="sa-pill good">Public{p.is_highlighted && ' ★'}</span>
                      ) : (
                        <span className="sa-faint" style={{ fontSize: 12 }}>Hidden</span>
                      )}
                    </td>
                    <td className="n">
                      <button className="sa-iconbtn" title="Edit"
                        onClick={() => setForm({
                          id: p.id, plan_name: p.plan_name, contact_limit: p.contact_limit,
                          template_limit: p.template_limit, user_limit: p.user_limit,
                          monthly_price: num(p.monthly_price), setup_fee: num(p.setup_fee),
                          webhook_enabled: p.webhook_enabled, ai_enabled: p.ai_enabled ?? false,
                          proactive_notifications: p.proactive_notifications ?? false,
                          shopify_store_limit: p.shopify_store_limit ?? 1,
                          whatsapp_number_limit: p.whatsapp_number_limit ?? 1,
                          extra_store_price: num(p.extra_store_price ?? 0),
                          extra_number_price: num(p.extra_number_price ?? 0),
                          is_public: p.is_public ?? false, display_order: p.display_order ?? 0,
                          is_highlighted: p.is_highlighted ?? false, tagline: p.tagline ?? '',
                          features: (p.features ?? []).join('\n'), cta_label: p.cta_label ?? '',
                          currency: p.currency ?? 'PKR', billing_period: p.billing_period ?? 'month',
                        })}>
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SaCard>

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit plan' : 'New plan'}
        footer={
          <>
            <button className="sa-btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="sa-btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </>
        }
      >
        {form && (
          <div className="sa-root" data-sa-theme="codesapp" style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, background: 'transparent' }}>
            <Inp label="Plan name" value={form.plan_name} onChange={(v) => setForm({ ...form, plan_name: v })} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <NumInp label="Contact limit" value={form.contact_limit} onChange={(v) => setForm({ ...form, contact_limit: v })} />
              <NumInp label="Template limit" value={form.template_limit} onChange={(v) => setForm({ ...form, template_limit: v })} />
              <NumInp label="User limit" value={form.user_limit} onChange={(v) => setForm({ ...form, user_limit: v })} />
              <NumInp label="Monthly price ($)" value={form.monthly_price} onChange={(v) => setForm({ ...form, monthly_price: v })} />
              <NumInp label="Setup fee ($)" value={form.setup_fee} onChange={(v) => setForm({ ...form, setup_fee: v })} />
              <NumInp label="Stores included (Shopify + WooCommerce)" value={form.shopify_store_limit} onChange={(v) => setForm({ ...form, shopify_store_limit: v })} />
              <NumInp label="WhatsApp numbers included" value={form.whatsapp_number_limit} onChange={(v) => setForm({ ...form, whatsapp_number_limit: v })} />
              <NumInp label="Price per extra store (/mo)" value={form.extra_store_price} onChange={(v) => setForm({ ...form, extra_store_price: v })} />
              <NumInp label="Price per extra number (/mo)" value={form.extra_number_price} onChange={(v) => setForm({ ...form, extra_number_price: v })} />
            </div>
            <Chk label="Webhooks enabled for this plan" checked={form.webhook_enabled} onChange={(c) => setForm({ ...form, webhook_enabled: c })} />
            <Chk label="AI Copilot enabled for this plan" checked={form.ai_enabled} onChange={(c) => setForm({ ...form, ai_enabled: c })} />
            <Chk label="Delivery notifications enabled for this plan" checked={form.proactive_notifications} onChange={(c) => setForm({ ...form, proactive_notifications: c })} />

            <div style={{ paddingTop: 12, borderTop: '1px solid var(--sa-border)' }}>
              <p className="sa-faint" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 12 }}>
                Public pricing card (landing page)
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Chk label="Show this plan on the public pricing section" checked={form.is_public} onChange={(c) => setForm({ ...form, is_public: c })} />
                <Chk label="Highlight as “Most popular”" checked={form.is_highlighted} onChange={(c) => setForm({ ...form, is_highlighted: c })} />
                <Inp label="Tagline (short subtitle)" value={form.tagline} onChange={(v) => setForm({ ...form, tagline: v })} />
                <div>
                  <label className="sa-muted" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Features (one per line)</label>
                  <textarea
                    className="sa-input"
                    value={form.features}
                    onChange={(e) => setForm({ ...form, features: e.target.value })}
                    rows={4}
                    placeholder={'Shared team inbox\nBroadcast campaigns\nShopify integration'}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Inp label="Currency" value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
                  <Inp label="Billing period (e.g. month)" value={form.billing_period} onChange={(v) => setForm({ ...form, billing_period: v })} />
                  <Inp label="CTA label (default “Get Started”)" value={form.cta_label} onChange={(v) => setForm({ ...form, cta_label: v })} />
                  <NumInp label="Display order" value={form.display_order} onChange={(v) => setForm({ ...form, display_order: v })} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Inp({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="sa-muted" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input className="sa-input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumInp({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="sa-muted" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input className="sa-input" type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Chk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} className="sa-muted">
      <input type="checkbox" style={{ accentColor: 'var(--sa-accent)' }} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
