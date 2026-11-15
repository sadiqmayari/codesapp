'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Lock, Plus, Trash2, Zap } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SaveBar } from '@/components/ui/save-bar';
import { BrandMark } from '@/components/icons/brand-logo';
import type {
  ShopifyOrderConfig,
  ShopifyOrderConfigResponse,
  Template,
} from '@/lib/crm-types';
import {
  Callout,
  FormField,
  Rows,
  SettingRow,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  WebhookDot,
  extractSlots,
  inputCls,
  templateBody,
} from './shared';

/**
 * Order automation = three Settings pages over ONE config document
 * (`GET /settings/shopify/order-config`):
 *   - Order confirmation → template (PATCH /template) + tags (PATCH /tags)
 *   - Abandoned carts    → `abandoned_cart` delivery event + delay + steps
 *                          (PATCH /proactive) + manual template
 *                          (PATCH /abandoned-template) + checkout webhooks
 *   - Delivery updates   → every other delivery event (PATCH /proactive)
 * The automatic-messages master switch (`proactiveEnabled`) gates BOTH
 * delivery updates and automatic cart recovery, so it shows on both pages.
 * `/proactive` always sends the full notifications map, so saving one page
 * never clobbers the other.
 */

const ABANDONED_KEY = 'abandoned_cart';

const DEFAULT_CFG: ShopifyOrderConfig = {
  enabled: false,
  templateId: null,
  languageCode: null,
  variableMap: {},
  confirmTag: 'confirmed',
  cancelTag: 'cancelled',
  pendingTag: 'confirmation pending',
  decisionWindowMinutes: 2,
  shopDomain: '',
  apiVersion: '',
  deliveryNotifications: {},
  abandonedCartDelayMinutes: 180,
};

type EvtCfg = { templateId: number | null; variableMap: Record<string, string>; enabled: boolean };

interface Snapshot {
  cfg: ShopifyOrderConfig;
  proactiveEnabled: boolean;
}

function useOrderConfig() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [fields, setFields] = useState<Array<{ key: string; label: string }>>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [proactivePlan, setProactivePlan] = useState(false);
  const [deliveryEvents, setDeliveryEvents] = useState<
    Array<{ key: string; label: string; source: string }>
  >([]);
  const [base, setBase] = useState<Snapshot>({ cfg: DEFAULT_CFG, proactiveEnabled: false });
  const [draft, setDraft] = useState<Snapshot>({ cfg: DEFAULT_CFG, proactiveEnabled: false });
  const [saving, setSaving] = useState(false);

  const apply = useCallback((res: ShopifyOrderConfigResponse) => {
    const snap = { cfg: res.config, proactiveEnabled: res.proactiveEnabled };
    setBase(snap);
    setDraft(snap);
    setFields(res.fields);
    setProactivePlan(res.proactivePlan);
    setDeliveryEvents(res.deliveryEvents);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/order-config'),
      apiFetch<Template[]>('/templates', { params: { status: 'approved' } }),
    ])
      .then(([res, tpls]) => {
        if (!alive) return;
        apply(res);
        setTemplates(tpls);
      })
      .catch((e) => {
        if (!alive) return;
        setFailed(true);
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load order settings');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apply, toast]);

  const cfg = draft.cfg;
  const setCfg = (patch: Partial<ShopifyOrderConfig>) =>
    setDraft((d) => ({ ...d, cfg: { ...d.cfg, ...patch } }));
  const setProactiveEnabled = (v: boolean) => setDraft((d) => ({ ...d, proactiveEnabled: v }));
  const evt = (key: string): EvtCfg =>
    cfg.deliveryNotifications[key] ?? { templateId: null, variableMap: {}, enabled: false };
  const patchEvt = (key: string, patch: Partial<EvtCfg>) =>
    setDraft((d) => ({
      ...d,
      cfg: {
        ...d.cfg,
        deliveryNotifications: {
          ...d.cfg.deliveryNotifications,
          [key]: { ...(d.cfg.deliveryNotifications[key] ?? { templateId: null, variableMap: {}, enabled: false }), ...patch },
        },
      },
    }));

  type Part = 'template' | 'tags' | 'proactive' | 'abandonedManual';
  /** Save the given parts in order with the CURRENT draft; last response wins. */
  const save = async (parts: Part[]) => {
    const c = draft.cfg;
    if (parts.includes('template') && c.enabled && !c.templateId) {
      toast.error('Pick an approved template to turn confirmation on');
      return;
    }
    if (parts.includes('tags') && (!c.confirmTag.trim() || !c.cancelTag.trim())) {
      toast.error('Confirmed and Cancelled tag names are required');
      return;
    }
    if (parts.includes('proactive') && draft.proactiveEnabled) {
      const anyReady = deliveryEvents.some((e) => {
        const ec = c.deliveryNotifications[e.key];
        return ec?.enabled && ec?.templateId;
      });
      if (!anyReady) {
        toast.error('Turn on at least one message with an approved template, or switch automatic messages off');
        return;
      }
    }
    setSaving(true);
    try {
      let last: ShopifyOrderConfigResponse | null = null;
      for (const part of parts) {
        if (part === 'template') {
          last = await apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/template', {
            method: 'PATCH',
            body: { enabled: c.enabled, templateId: c.templateId, variableMap: c.variableMap },
          });
        } else if (part === 'tags') {
          last = await apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/tags', {
            method: 'PATCH',
            body: {
              confirmTag: c.confirmTag.trim(),
              cancelTag: c.cancelTag.trim(),
              pendingTag: c.pendingTag.trim(),
              decisionWindowMinutes: c.decisionWindowMinutes,
            },
          });
        } else if (part === 'proactive') {
          last = await apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/proactive', {
            method: 'PATCH',
            body: {
              enabled: draft.proactiveEnabled,
              notifications: c.deliveryNotifications,
              abandonedCartDelayMinutes: c.abandonedCartDelayMinutes,
              abandonedCartSteps: c.abandonedCartSteps ?? [],
            },
          });
        } else {
          last = await apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/abandoned-template', {
            method: 'PATCH',
            body: {
              templateId: c.abandonedManualTemplate?.templateId ?? null,
              variableMap: c.abandonedManualTemplate?.variableMap ?? {},
            },
          });
        }
      }
      if (last) apply(last);
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return {
    loading,
    failed,
    saving,
    fields,
    templates,
    proactivePlan,
    deliveryEvents,
    base,
    draft,
    cfg,
    setCfg,
    setProactiveEnabled,
    evt,
    patchEvt,
    discard: () => setDraft(base),
    save,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ───────────── Shared: template + variable mapping ───────────── */

function TemplatePicker({
  id,
  label = 'Template',
  templates,
  fields,
  templateId,
  variableMap,
  onChange,
  emptyHint = 'No approved templates yet — create one under Templates.',
}: {
  id: string;
  label?: string;
  templates: Template[];
  fields: Array<{ key: string; label: string }>;
  templateId: number | null;
  variableMap: Record<string, string>;
  onChange: (next: { templateId: number | null; variableMap: Record<string, string> }) => void;
  emptyHint?: string;
}) {
  const tpl = templates.find((t) => t.id === templateId) ?? null;
  const body = tpl ? templateBody(tpl) : '';
  const slots = tpl ? extractSlots(body) : [];
  return (
    <div className="flex flex-col gap-3">
      <FormField
        label={label}
        htmlFor={id}
        hint={
          templates.length === 0 ? (
            <>
              {emptyHint}{' '}
              <Link href="/templates" className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
                Open Templates
              </Link>
            </>
          ) : undefined
        }
      >
        <select
          id={id}
          value={templateId ?? ''}
          onChange={(e) =>
            onChange({ templateId: e.target.value ? Number(e.target.value) : null, variableMap: {} })
          }
          className={inputCls}
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </FormField>
      {tpl && (
        <div className="whitespace-pre-wrap rounded-xl border border-line bg-sunken px-3.5 py-3 text-[13px] leading-relaxed text-ink">
          {body || '(no body text)'}
        </div>
      )}
      {slots.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold text-ink">Fill each variable from the order</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {slots.map((s) => (
              <div key={s} className="flex items-center gap-2">
                <span className="w-11 shrink-0 rounded-md bg-sunken px-1.5 py-1 text-center font-mono text-xs text-muted">{`{{${s}}}`}</span>
                <select
                  aria-label={`Variable ${s}`}
                  value={variableMap[s] ?? ''}
                  onChange={(e) => onChange({ templateId, variableMap: { ...variableMap, [s]: e.target.value } })}
                  className={cn(inputCls, !variableMap[s] && 'border-amber-300')}
                >
                  <option value="">Choose a field…</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanLocked({ what }: { what: string }) {
  return (
    <Callout tone="warn" icon={<Lock size={15} />}>
      <b>{what} isn’t included in your plan.</b> Contact your administrator to turn it on.
    </Callout>
  );
}

function MasterOffNotice({ onEnable }: { onEnable: () => void }) {
  return (
    <Callout
      tone="info"
      icon={<Zap size={15} />}
      action={
        <Button size="sm" variant="secondary" onClick={onEnable}>
          Turn on
        </Button>
      }
    >
      <b>Automatic messages are off for this workspace.</b> Delivery updates and automatic cart recovery only send while
      they’re on.
    </Callout>
  );
}

/* ───────────────────────── Order confirmation ───────────────────────── */

export function ConfirmationSection() {
  const oc = useOrderConfig();
  if (oc.loading) return <SettingsSkeleton cards={2} />;
  const { cfg, base, templates, fields } = oc;

  const tplDirty =
    cfg.enabled !== base.cfg.enabled ||
    cfg.templateId !== base.cfg.templateId ||
    !same(cfg.variableMap, base.cfg.variableMap);
  const tagsDirty =
    cfg.confirmTag !== base.cfg.confirmTag ||
    cfg.cancelTag !== base.cfg.cancelTag ||
    cfg.pendingTag !== base.cfg.pendingTag ||
    cfg.decisionWindowMinutes !== base.cfg.decisionWindowMinutes;

  return (
    <SettingsPage
      title="Order confirmation"
      description="Ask every new order to confirm or cancel on WhatsApp, then tag the order in your store. Applies to every connected store."
      actions={
        <>
          <span className="text-sm font-semibold text-muted">{cfg.enabled ? 'On' : 'Off'}</span>
          <Switch checked={cfg.enabled} onChange={(v) => oc.setCfg({ enabled: v })} label="Order confirmation" />
        </>
      }
    >
      {oc.failed && <Callout tone="warn">Couldn’t load your order settings. Refresh to try again.</Callout>}
      <SettingsCard title="Message" description="An approved template with Confirm / Cancel buttons.">
        <TemplatePicker
          id="conf-tpl"
          templates={templates}
          fields={fields}
          templateId={cfg.templateId}
          variableMap={cfg.variableMap}
          onChange={(n) => oc.setCfg(n)}
          emptyHint="No approved templates yet — create one with Confirm/Cancel buttons."
        />
      </SettingsCard>

      <SettingsCard
        title="Order tags"
        description="Only these three tags are ever changed — your other store tags are left alone. Confirm/Cancel is reversible."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="When confirmed" htmlFor="tag-c">
            <input id="tag-c" value={cfg.confirmTag} onChange={(e) => oc.setCfg({ confirmTag: e.target.value })} className={inputCls} />
          </FormField>
          <FormField label="When cancelled" htmlFor="tag-x">
            <input id="tag-x" value={cfg.cancelTag} onChange={(e) => oc.setCfg({ cancelTag: e.target.value })} className={inputCls} />
          </FormField>
          <FormField label="While waiting (no answer)" htmlFor="tag-p">
            <input id="tag-p" value={cfg.pendingTag} onChange={(e) => oc.setCfg({ pendingTag: e.target.value })} className={inputCls} />
          </FormField>
        </div>
        <FormField
          label="Decision window (minutes)"
          htmlFor="tag-dw"
          hint="A customer can change their mind within this time."
          className="max-w-[260px]"
        >
          <input
            id="tag-dw"
            type="number"
            min={1}
            value={cfg.decisionWindowMinutes}
            onChange={(e) => oc.setCfg({ decisionWindowMinutes: Number(e.target.value) || 1 })}
            className={cn(inputCls, 'tabular-nums')}
          />
        </FormField>
      </SettingsCard>

      <SaveBar
        dirty={tplDirty || tagsDirty}
        saving={oc.saving}
        onDiscard={oc.discard}
        onSave={() => oc.save([...(tplDirty ? ['template' as const] : []), ...(tagsDirty ? ['tags' as const] : [])])}
      />
    </SettingsPage>
  );
}

/* ───────────────────────── Abandoned carts ───────────────────────── */

export function AbandonedSection() {
  const oc = useOrderConfig();
  if (oc.loading) return <SettingsSkeleton cards={3} />;
  const { cfg, base, templates, fields, draft } = oc;
  const hasAbandonedEvent = oc.deliveryEvents.some((e) => e.key === ABANDONED_KEY);
  const ev = oc.evt(ABANDONED_KEY);
  const steps = cfg.abandonedCartSteps ?? [];

  const proactiveDirty =
    draft.proactiveEnabled !== base.proactiveEnabled ||
    !same(cfg.deliveryNotifications[ABANDONED_KEY], base.cfg.deliveryNotifications[ABANDONED_KEY]) ||
    cfg.abandonedCartDelayMinutes !== base.cfg.abandonedCartDelayMinutes ||
    !same(cfg.abandonedCartSteps ?? [], base.cfg.abandonedCartSteps ?? []);
  const manualDirty = !same(cfg.abandonedManualTemplate, base.cfg.abandonedManualTemplate);

  const setSteps = (next: NonNullable<ShopifyOrderConfig['abandonedCartSteps']>) =>
    oc.setCfg({ abandonedCartSteps: next });

  return (
    <SettingsPage
      title="Abandoned carts"
      description="Everything about cart recovery in one place. Only checkouts that captured a phone number can be messaged."
    >
      <CheckoutWebhooksCard />

      <SettingsCard
        title="Automatic recovery"
        description="Sent on a timer after a cart is abandoned, if no order follows."
        action={
          oc.proactivePlan && hasAbandonedEvent ? (
            <Switch
              checked={ev.enabled}
              onChange={(v) => oc.patchEvt(ABANDONED_KEY, { enabled: v })}
              label="Automatic cart recovery"
            />
          ) : undefined
        }
      >
        {!oc.proactivePlan ? (
          <PlanLocked what="Automatic cart recovery" />
        ) : !hasAbandonedEvent ? (
          <p className="text-sm text-muted">Automatic recovery isn’t available for your store yet.</p>
        ) : (
          <>
            {!draft.proactiveEnabled && <MasterOffNotice onEnable={() => oc.setProactiveEnabled(true)} />}
            <div className={cn('flex flex-col gap-4', !ev.enabled && 'pointer-events-none opacity-50')}>
              {steps.length === 0 ? (
                <>
                  <FormField
                    label="Send after (hours)"
                    htmlFor="ab-delay"
                    hint="Hours after the cart is abandoned."
                    className="max-w-[220px]"
                  >
                    <input
                      id="ab-delay"
                      type="number"
                      min={1}
                      value={Math.round(cfg.abandonedCartDelayMinutes / 60)}
                      onChange={(e) => oc.setCfg({ abandonedCartDelayMinutes: (Number(e.target.value) || 1) * 60 })}
                      className={cn(inputCls, 'tabular-nums')}
                    />
                  </FormField>
                  <TemplatePicker
                    id="ab-tpl"
                    templates={templates}
                    fields={fields}
                    templateId={ev.templateId}
                    variableMap={ev.variableMap}
                    onChange={(n) => oc.patchEvt(ABANDONED_KEY, n)}
                  />
                </>
              ) : (
                <div className="flex flex-col gap-3">
                  {steps.map((st, idx) => (
                    <div key={idx} className="rounded-xl border border-line bg-sunken/60 p-3.5">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-xs font-extrabold text-ink">
                          {idx + 1}
                        </span>
                        <span className="text-sm font-semibold text-ink">Send</span>
                        <input
                          type="number"
                          min={1}
                          aria-label={`Step ${idx + 1} hours`}
                          value={Math.max(1, Math.round(st.delayMinutes / 60))}
                          onChange={(e) => {
                            const next = [...steps];
                            next[idx] = { ...st, delayMinutes: (Number(e.target.value) || 1) * 60 };
                            setSteps(next);
                          }}
                          className={cn(inputCls, 'w-20 tabular-nums')}
                        />
                        <span className="text-sm text-muted">hours after the cart is abandoned</span>
                        <button
                          type="button"
                          onClick={() => setSteps(steps.filter((_, i) => i !== idx))}
                          className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                          aria-label={`Remove step ${idx + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <TemplatePicker
                        id={`ab-step-${idx}`}
                        templates={templates}
                        fields={fields}
                        templateId={st.templateId || null}
                        variableMap={st.variableMap}
                        onChange={(n) => {
                          const next = [...steps];
                          next[idx] = { ...st, templateId: n.templateId ?? 0, variableMap: n.variableMap };
                          setSteps(next);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setSteps([
                      ...steps,
                      {
                        delayMinutes: steps.length ? steps[steps.length - 1].delayMinutes + 24 * 60 : cfg.abandonedCartDelayMinutes,
                        templateId: steps.length ? 0 : (ev.templateId ?? 0),
                        variableMap: steps.length ? {} : ev.variableMap,
                      },
                    ])
                  }
                >
                  <Plus size={14} /> {steps.length ? 'Add step' : 'Send a sequence instead'}
                </Button>
                <span className="text-xs text-muted">
                  {steps.length
                    ? 'Steps send in order; each only if the customer still hasn’t ordered.'
                    : 'One message by default — add steps to nudge more than once (e.g. 1h, 24h, 72h).'}
                </span>
              </div>
            </div>
          </>
        )}
      </SettingsCard>

      <SettingsCard
        title="Manual “Send message” template"
        description="Used when an agent presses Send message on a cart in Orders → Abandoned."
      >
        <TemplatePicker
          id="ab-manual"
          templates={templates}
          fields={fields}
          templateId={cfg.abandonedManualTemplate?.templateId ?? null}
          variableMap={cfg.abandonedManualTemplate?.variableMap ?? {}}
          onChange={(n) => oc.setCfg({ abandonedManualTemplate: n.templateId ? { templateId: n.templateId, variableMap: n.variableMap } : null })}
        />
      </SettingsCard>

      <SaveBar
        dirty={proactiveDirty || manualDirty}
        saving={oc.saving}
        onDiscard={oc.discard}
        onSave={() =>
          oc.save([
            ...(proactiveDirty ? ['proactive' as const] : []),
            ...(manualDirty ? ['abandonedManual' as const] : []),
          ])
        }
      />
    </SettingsPage>
  );
}

/* ───────────────────────── Delivery updates ───────────────────────── */

export function DeliverySection() {
  const oc = useOrderConfig();
  const events = useMemo(() => oc.deliveryEvents.filter((e) => e.key !== ABANDONED_KEY), [oc.deliveryEvents]);
  if (oc.loading) return <SettingsSkeleton cards={2} />;
  const { cfg, base, draft, templates, fields } = oc;

  const dirty =
    draft.proactiveEnabled !== base.proactiveEnabled ||
    events.some((e) => !same(cfg.deliveryNotifications[e.key], base.cfg.deliveryNotifications[e.key]));

  return (
    <SettingsPage
      title="Delivery updates"
      description="Message customers automatically as their order moves. Templates send even outside the 24-hour window."
      actions={
        oc.proactivePlan ? (
          <>
            <span className="text-sm font-semibold text-muted">{draft.proactiveEnabled ? 'On' : 'Off'}</span>
            <Switch checked={draft.proactiveEnabled} onChange={oc.setProactiveEnabled} label="Automatic messages" />
          </>
        ) : undefined
      }
    >
      {!oc.proactivePlan ? (
        <PlanLocked what="Delivery updates" />
      ) : (
        <>
          {!draft.proactiveEnabled && <MasterOffNotice onEnable={() => oc.setProactiveEnabled(true)} />}
          <SettingsCard
            title="Messages"
            description="Shipped and Cancelled come from store events; the rest need your courier to report tracking."
          >
            <Rows>
              {events.map((e) => {
                const ec = oc.evt(e.key);
                const ready = ec.enabled && !!ec.templateId;
                return (
                  <div key={e.key} className="flex flex-col gap-3">
                    <SettingRow
                      title={
                        <span className="flex items-center gap-2">
                          {e.label}
                          {ec.enabled && !ec.templateId && <Badge tone="warn">Choose a template</Badge>}
                          {ready && <Badge tone="success">On</Badge>}
                        </span>
                      }
                      description={e.source.startsWith('orders/') ? 'Store event' : 'Courier tracking (needs your courier to report status)'}
                    >
                      <Switch checked={ec.enabled} onChange={(v) => oc.patchEvt(e.key, { enabled: v })} label={`${e.label} message`} />
                    </SettingRow>
                    {ec.enabled && (
                      <div className="rounded-xl border border-line bg-sunken/60 p-3.5">
                        <TemplatePicker
                          id={`dn-${e.key}`}
                          templates={templates}
                          fields={fields}
                          templateId={ec.templateId}
                          variableMap={ec.variableMap}
                          onChange={(n) => oc.patchEvt(e.key, n)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </Rows>
          </SettingsCard>
          <p className="text-[13px] text-muted">
            Automatic abandoned-cart messages are set up under{' '}
            <Link href="/settings/abandoned" className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Abandoned carts
            </Link>
            .
          </p>
        </>
      )}
      <SaveBar dirty={dirty} saving={oc.saving} onDiscard={oc.discard} onSave={() => oc.save(['proactive'])} />
    </SettingsPage>
  );
}

/* ───────────── Checkout (abandoned-cart) webhooks ───────────── */

function CheckoutWebhooksCard() {
  const toast = useToast();
  const [status, setStatus] = useState<{ url: string; create: boolean; update: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(
        await apiFetch<{ url: string; create: boolean; update: boolean }>('/settings/shopify/checkout-webhook-status'),
      );
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const register = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{
        url: string;
        results: Array<{ topic: string; ok: boolean; message: string }>;
        secretHint: string;
      }>('/settings/shopify/register-checkout-webhooks', { method: 'POST' });
      if (res.results.every((r) => r.ok)) toast.success('Checkout webhooks registered');
      else
        toast.error(
          res.results
            .filter((r) => !r.ok)
            .map((r) => `${r.topic}: ${r.message}`)
            .join(' · ') || 'Some webhooks failed',
        );
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to register webhooks');
    } finally {
      setBusy(false);
    }
  };

  const both = !!status && status.create && status.update;
  return (
    <SettingsCard
      icon={<BrandMark brand="shopify" size="md" />}
      title="Checkout tracking"
      description="Shopify webhooks that put abandoned carts into Orders → Abandoned."
      action={
        loading ? undefined : both ? (
          <Badge tone="success">Registered</Badge>
        ) : (
          <Badge tone="warn">{status?.create || status?.update ? 'Partly registered' : 'Not registered'}</Badge>
        )
      }
    >
      {loading ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <WebhookDot label="checkouts/create" on={!!status?.create} />
            <WebhookDot label="checkouts/update" on={!!status?.update} />
            <Button size="sm" variant={both ? 'secondary' : 'primary'} loading={busy} onClick={register} className="ml-auto">
              {both ? 'Re-register' : 'Register webhooks'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            For these to verify, your store’s webhook signing secret (Stores → your store) must be the custom app’s{' '}
            <b>API secret key</b>.
          </p>
        </>
      )}
    </SettingsCard>
  );
}
