'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Plus, RefreshCw, ShieldCheck, Star, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/modal';
import { SideSheet } from '@/components/ui/side-sheet';
import { BrandMark } from '@/components/icons/brand-logo';
import { getInventoryPushHealth, type InventoryPushHealth } from '@/lib/inventory';
import type { ShopifyOrderConfigResponse } from '@/lib/crm-types';
import {
  Callout,
  CopyField,
  FormField,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  inputCls,
} from './shared';

export type ShopifyStoreRow = {
  id: number;
  provider: 'shopify' | 'woocommerce';
  label: string | null;
  shopDomain: string;
  baseUrl: string | null;
  apiVersion: string | null;
  webhookKey: string;
  webhookUrl: string;
  adminTokenSet: boolean;
  wcCredentialsSet: boolean;
  webhookSecretSet: boolean;
  status: string;
  isPrimary: boolean;
  tokenInvalid?: boolean;
  // 'legacy' = pasted admin token; 'client_credentials' = Dev Dashboard app
  // (CodesApp mints a ~24h token from the client id/secret automatically).
  authMode?: 'legacy' | 'client_credentials';
  clientCredentialsSet?: boolean;
};

type Provider = 'shopify' | 'woocommerce';
type AuthMode = 'legacy' | 'client_credentials';

interface StoreForm {
  provider: Provider;
  label: string;
  shopDomain: string;
  apiVersion: string;
  authMode: AuthMode;
  adminToken: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

const EMPTY_FORM: StoreForm = {
  provider: 'shopify',
  label: '',
  shopDomain: '',
  apiVersion: '',
  authMode: 'client_credentials',
  adminToken: '',
  clientId: '',
  clientSecret: '',
  webhookSecret: '',
  baseUrl: '',
  consumerKey: '',
  consumerSecret: '',
};

const storeName = (s: ShopifyStoreRow) => s.label || s.shopDomain || s.baseUrl || 'Store';

/**
 * Settings → Stores. Shopify + WooCommerce stores as logo tiles; each opens a
 * side sheet (connection, sign-in method, secrets, granted access, webhook URL,
 * default / remove). Same endpoints as before (`/settings/shopify/stores*`).
 */
export function StoresSection() {
  const toast = useToast();
  const [stores, setStores] = useState<ShopifyStoreRow[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [fixedStoreId, setFixedStoreId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<ShopifyStoreRow[]>('/settings/shopify/stores');
      setStores(Array.isArray(rows) ? rows : []);
    } catch {
      setStores([]);
    }
  }, []);

  useEffect(() => {
    load();
    apiFetch<{ limits?: { shopifyStoreLimit?: number } }>('/billing/subscription')
      .then((s) => setLimit(s?.limits?.shopifyStoreLimit ?? 1))
      .catch(() => setLimit(1));
    apiFetch<{ fixedStoreId: number | null }>('/shopify/order-store')
      .then((r) => setFixedStoreId(r?.fixedStoreId ?? null))
      .catch(() => undefined);
  }, [load]);

  const saveFixedStore = async (value: number | null) => {
    const prev = fixedStoreId;
    setFixedStoreId(value);
    try {
      await apiFetch('/settings/shopify/order-store', { method: 'PATCH', body: { storeId: value } });
      toast.success(value == null ? 'Agents choose the store per order' : 'Chat orders now go to one store');
    } catch (e) {
      setFixedStoreId(prev);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    }
  };

  if (stores === null || limit === null) return <SettingsSkeleton cards={2} />;
  const count = stores.length;
  const canAdd = count < limit;
  const open = stores.find((s) => s.id === openId) ?? null;

  return (
    <SettingsPage
      title="Stores"
      description={
        <>
          Shopify and WooCommerce stores. Each has its own credentials and webhook URL; order confirmation, cart and
          delivery settings apply to all of them. Your plan allows {limit} store{limit === 1 ? '' : 's'}.
        </>
      }
      actions={
        canAdd ? (
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} /> Connect store
          </Button>
        ) : undefined
      }
    >
      {count === 0 ? (
        <LegacyConnection onConnectStore={() => setAdding(true)} />
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2">
          {stores.map((s) => (
            <StoreTile key={s.id} store={s} onOpen={() => setOpenId(s.id)} />
          ))}
          {canAdd ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line p-4 text-muted transition-colors hover:border-brand-400 hover:bg-brand-50/40 dark:hover:bg-brand-900/20"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                <Plus size={18} />
              </span>
              <span className="text-sm font-semibold text-ink">Connect a store</span>
              <span className="text-xs">
                Shopify or WooCommerce · {count} of {limit} used
              </span>
            </button>
          ) : (
            <div className="flex min-h-[150px] flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-line p-4 text-center text-xs text-muted">
              <span className="font-semibold text-ink">Store limit reached</span>
              Contact support to connect more stores.
            </div>
          )}
        </div>
      )}

      {count > 1 && (
        <SettingsCard
          title="Orders created from chats"
          description="Which store an agent’s (or the AI’s) chat order is created in. Fixing one store hides the per-order picker."
        >
          <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-sunken p-1" role="radiogroup" aria-label="Chat orders store">
            {[{ id: null as number | null, label: 'Agents choose per order' }, ...stores.map((s) => ({ id: s.id as number | null, label: `Always ${storeName(s)}` }))].map((o) => (
              <button
                key={o.id ?? 'any'}
                type="button"
                role="radio"
                aria-checked={fixedStoreId === o.id}
                onClick={() => saveFixedStore(o.id)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[13px] font-semibold',
                  fixedStoreId === o.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </SettingsCard>
      )}

      {count > 0 && <CancelledOrdersCard />}

      {open && (
        <StoreSheet
          key={open.id}
          store={open}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
      <AddStoreSheet open={adding} onClose={() => setAdding(false)} onAdded={load} />
    </SettingsPage>
  );
}

function StoreTile({ store: s, onOpen }: { store: ShopifyStoreRow; onOpen: () => void }) {
  const woo = s.provider === 'woocommerce';
  const domain = s.shopDomain || s.baseUrl || '';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 text-left shadow-sm transition hover:-translate-y-px hover:border-brand-400"
    >
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark brand={woo ? 'woocommerce' : 'shopify'} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold text-ink">{storeName(s)}</p>
          {s.label && domain && <p className="truncate text-xs text-muted">{domain}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {s.tokenInvalid ? (
          <Badge tone="danger">
            <AlertTriangle size={12} /> Token rejected
          </Badge>
        ) : s.status === 'active' ? (
          <Badge tone="success">Connected</Badge>
        ) : (
          <Badge className="capitalize">{s.status}</Badge>
        )}
        {s.isPrimary && (
          <Badge tone="warn">
            <Star size={11} /> Default
          </Badge>
        )}
        {!woo && s.authMode === 'client_credentials' && <Badge tone="violet">⟳ Auto-token</Badge>}
        {woo && <Badge tone="violet">WooCommerce</Badge>}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-[13px] text-muted">
        <span>{woo ? 'REST API' : s.apiVersion ? `API ${s.apiVersion}` : 'Shopify Admin API'}</span>
        <span className={cn('font-semibold', s.tokenInvalid ? 'text-red-600' : 'text-brand-700 dark:text-brand-300')}>
          {s.tokenInvalid ? 'Fix →' : 'Manage →'}
        </span>
      </div>
    </button>
  );
}

function ScopeBadge({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <Badge tone={ok === null ? 'neutral' : ok ? 'success' : 'danger'}>
      {ok === null ? null : ok ? <Check size={12} /> : <X size={12} />}
      {label}
    </Badge>
  );
}

function StoreSheet({
  store: s,
  onClose,
  onChanged,
}: {
  store: ShopifyStoreRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const woo = s.provider === 'woocommerce';
  const [form, setForm] = useState<StoreForm>({
    ...EMPTY_FORM,
    provider: s.provider,
    label: s.label ?? '',
    shopDomain: s.shopDomain ?? '',
    apiVersion: s.apiVersion ?? '',
    authMode: s.authMode === 'client_credentials' ? 'client_credentials' : 'legacy',
    baseUrl: s.baseUrl ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [health, setHealth] = useState<InventoryPushHealth | null>(null);

  useEffect(() => {
    if (woo) return;
    getInventoryPushHealth(s.id)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [s.id, woo]);

  const set = (p: Partial<StoreForm>) => setForm((f) => ({ ...f, ...p }));

  const save = async () => {
    setBusy(true);
    try {
      // Only send changed/filled fields; blank token/secret = keep the stored one.
      const body: Record<string, string> = { label: form.label.trim() };
      if (woo) {
        if (form.baseUrl.trim()) body.baseUrl = form.baseUrl.trim();
        if (form.consumerKey.trim()) body.consumerKey = form.consumerKey.trim();
        if (form.consumerSecret.trim()) body.consumerSecret = form.consumerSecret.trim();
      } else {
        if (form.shopDomain.trim()) body.shopDomain = form.shopDomain.trim();
        if (form.apiVersion.trim()) body.apiVersion = form.apiVersion.trim();
        body.authMode = form.authMode;
        if (form.authMode === 'client_credentials') {
          if (form.clientId.trim()) body.clientId = form.clientId.trim();
          if (form.clientSecret.trim()) body.clientSecret = form.clientSecret.trim();
        } else if (form.adminToken.trim()) {
          body.adminToken = form.adminToken.trim();
        }
      }
      if (form.webhookSecret.trim()) body.webhookSecret = form.webhookSecret.trim();
      const res = await apiFetch<{ grantedScope?: string }>(`/settings/shopify/stores/${s.id}`, {
        method: 'PATCH',
        body,
      });
      toast.success(
        !woo && form.authMode === 'client_credentials' && res?.grantedScope
          ? 'Store updated — credentials verified ✓'
          : 'Store updated',
      );
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update the store');
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async () => {
    try {
      await apiFetch(`/settings/shopify/stores/${s.id}/default`, { method: 'POST' });
      toast.success(`${storeName(s)} is now the default store`);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not set default');
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiFetch(`/settings/shopify/stores/${s.id}`, { method: 'DELETE' });
      toast.success('Store removed');
      setConfirmRemove(false);
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not remove the store');
    } finally {
      setBusy(false);
    }
  };

  const savedHint = (isSet: boolean | undefined) => (isSet ? '•••••••• saved — leave blank to keep' : '');

  return (
    <SideSheet
      open
      onClose={onClose}
      icon={<BrandMark brand={woo ? 'woocommerce' : 'shopify'} size="lg" />}
      title={storeName(s)}
      subtitle={
        <div className="flex flex-wrap gap-1.5">
          {s.tokenInvalid ? <Badge tone="danger">Token rejected</Badge> : <Badge tone="success">Connected</Badge>}
          {s.isPrimary && <Badge tone="warn">Default</Badge>}
        </div>
      }
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setConfirmRemove(true)}>
            Remove store
          </Button>
          {!s.isPrimary && (
            <Button variant="secondary" onClick={makeDefault}>
              Make default
            </Button>
          )}
          <Button loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {s.tokenInvalid && (
        <Callout tone="danger" icon={<AlertTriangle size={15} className="text-red-600" />}>
          <b>Shopify rejected this store’s Admin API token</b> (revoked or regenerated). Bookings and sync for this store
          fail until you reconnect — switch to a Dev Dashboard app so tokens renew on their own, or paste a fresh token.
        </Callout>
      )}
      <Callout tone="brand" icon={<ShieldCheck size={15} className="text-brand-600" />}>
        Secrets are encrypted and never shown again. Leave a secret blank to keep the saved one.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Display name" htmlFor="st-label">
          <input id="st-label" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder={s.shopDomain || s.baseUrl || 'Store name'} className={inputCls} />
        </FormField>
        {woo ? (
          <FormField label="Store URL" htmlFor="st-url">
            <input id="st-url" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} className={inputCls} />
          </FormField>
        ) : (
          <FormField label="Store domain" htmlFor="st-domain">
            <input id="st-domain" value={form.shopDomain} onChange={(e) => set({ shopDomain: e.target.value })} className={inputCls} />
          </FormField>
        )}
      </div>

      {woo ? (
        <>
          <FormField label="Consumer key" htmlFor="st-ck">
            <input id="st-ck" type="password" autoComplete="new-password" value={form.consumerKey} onChange={(e) => set({ consumerKey: e.target.value })} placeholder={savedHint(s.wcCredentialsSet)} className={inputCls} />
          </FormField>
          <FormField label="Consumer secret" htmlFor="st-cs">
            <input id="st-cs" type="password" autoComplete="new-password" value={form.consumerSecret} onChange={(e) => set({ consumerSecret: e.target.value })} placeholder={savedHint(s.wcCredentialsSet)} className={inputCls} />
          </FormField>
        </>
      ) : (
        <>
          <AuthModePicker value={form.authMode} onChange={(v) => set({ authMode: v })} />
          {form.authMode === 'client_credentials' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Client ID" htmlFor="st-cid">
                <input id="st-cid" type="password" autoComplete="new-password" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} placeholder={savedHint(s.clientCredentialsSet)} className={inputCls} />
              </FormField>
              <FormField label="Client secret" htmlFor="st-csec">
                <input id="st-csec" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder={savedHint(s.clientCredentialsSet)} className={inputCls} />
              </FormField>
            </div>
          ) : (
            <FormField label="Admin API token" htmlFor="st-tok">
              <input id="st-tok" type="password" autoComplete="new-password" value={form.adminToken} onChange={(e) => set({ adminToken: e.target.value })} placeholder={s.tokenInvalid ? 'Paste a fresh token' : savedHint(s.adminTokenSet)} className={inputCls} />
            </FormField>
          )}
          <FormField label="API version" htmlFor="st-ver" hint="Leave as-is unless support asks you to change it.">
            <input id="st-ver" value={form.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })} placeholder="e.g. 2026-10" className={inputCls} />
          </FormField>
        </>
      )}

      <FormField label="Webhook signing secret" htmlFor="st-whs" hint="Shopify: your custom app’s API secret key. WooCommerce: the secret you set on the webhook.">
        <input id="st-whs" type="password" autoComplete="new-password" value={form.webhookSecret} onChange={(e) => set({ webhookSecret: e.target.value })} placeholder={savedHint(s.webhookSecretSet)} className={inputCls} />
      </FormField>

      {!woo && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-ink">Access granted</span>
          <div className="flex flex-wrap gap-1.5">
            <ScopeBadge ok={health ? health.writeProducts : null} label="write_products" />
            <ScopeBadge ok={health ? health.writeInventory : null} label="write_inventory" />
          </div>
          <p className="text-xs text-muted">
            {health && (health.writeProducts === false || health.writeInventory === false)
              ? 'Missing scopes stop price / stock / cost pushes to the store. Add them to the app, then reinstall or re-save.'
              : 'Price, stock and cost edits in Inventory push to the store with these.'}
          </p>
        </div>
      )}

      <CopyField
        label={woo ? 'Order created webhook — delivery URL' : 'Order webhook URL (orders/create)'}
        value={s.webhookUrl}
        hint={
          woo
            ? 'WooCommerce → Settings → Advanced → Webhooks → Order created.'
            : 'Register orders/create (and optional checkout webhooks) in this store’s Shopify app.'
        }
      />

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${storeName(s)}?`}
        message="Orders already imported stay in CodesApp, but new orders, sync and bookings for this store stop. You can reconnect it later."
        danger
        confirmLabel="Remove store"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </SideSheet>
  );
}

function AuthModePicker({ value, onChange }: { value: AuthMode; onChange: (v: AuthMode) => void }) {
  const opts: Array<{ v: AuthMode; title: string; note: string }> = [
    { v: 'client_credentials', title: 'Dev Dashboard app', note: 'Recommended — CodesApp renews the token automatically.' },
    { v: 'legacy', title: 'Custom app token', note: 'A pasted Admin API token (stops working if revoked).' },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink">How CodesApp signs in</span>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Sign-in method">
        {opts.map((o) => (
          <label
            key={o.v}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3',
              value === o.v ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30' : 'border-line hover:bg-sunken',
            )}
          >
            <span className="flex items-center gap-2 text-sm font-bold text-ink">
              <input type="radio" name="auth-mode" checked={value === o.v} onChange={() => onChange(o.v)} className="accent-brand-600" />
              {o.title}
            </span>
            <span className="text-xs text-muted">{o.note}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function AddStoreSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState<StoreForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<StoreForm>) => setForm((f) => ({ ...f, ...p }));
  const woo = form.provider === 'woocommerce';

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  const add = async () => {
    if (woo) {
      if (!form.baseUrl.trim() || !form.consumerKey.trim() || !form.consumerSecret.trim()) {
        toast.error('A store URL, consumer key and consumer secret are required.');
        return;
      }
    } else if (form.authMode === 'client_credentials') {
      if (!form.shopDomain.trim() || !form.clientId.trim() || !form.clientSecret.trim()) {
        toast.error('A store domain, Client ID and Client secret are required.');
        return;
      }
    } else if (!form.shopDomain.trim() || form.adminToken.trim().length < 8) {
      toast.error('A store domain and an Admin API token are required.');
      return;
    }
    setBusy(true);
    try {
      const body = woo
        ? {
            provider: 'woocommerce' as const,
            label: form.label.trim() || undefined,
            baseUrl: form.baseUrl.trim(),
            consumerKey: form.consumerKey.trim(),
            consumerSecret: form.consumerSecret.trim(),
            webhookSecret: form.webhookSecret.trim() || undefined,
          }
        : form.authMode === 'client_credentials'
          ? {
              provider: 'shopify' as const,
              label: form.label.trim() || undefined,
              shopDomain: form.shopDomain.trim(),
              apiVersion: form.apiVersion.trim() || undefined,
              authMode: 'client_credentials' as const,
              clientId: form.clientId.trim(),
              clientSecret: form.clientSecret.trim(),
              webhookSecret: form.webhookSecret.trim() || undefined,
            }
          : {
              provider: 'shopify' as const,
              label: form.label.trim() || undefined,
              shopDomain: form.shopDomain.trim(),
              apiVersion: form.apiVersion.trim() || undefined,
              authMode: 'legacy' as const,
              adminToken: form.adminToken.trim(),
              webhookSecret: form.webhookSecret.trim() || undefined,
            };
      const res = await apiFetch<{ grantedScope?: string }>('/settings/shopify/stores', { method: 'POST', body });
      toast.success(res?.grantedScope ? 'Store connected — credentials verified ✓' : 'Store connected');
      await onAdded();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not add the store');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      icon={
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
          <Plus size={22} />
        </span>
      }
      title="Connect a store"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={add}>
            Connect store
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink">Platform</span>
        <div className="grid grid-cols-2 gap-2">
          {(['shopify', 'woocommerce'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => set({ provider: p })}
              aria-pressed={form.provider === p}
              className={cn(
                'flex items-center gap-3 rounded-xl border p-3 text-left',
                form.provider === p ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30' : 'border-line hover:bg-sunken',
              )}
            >
              <BrandMark brand={p} size="sm" />
              <span className="text-sm font-bold text-ink">{p === 'shopify' ? 'Shopify' : 'WooCommerce'}</span>
            </button>
          ))}
        </div>
      </div>

      <FormField label="Label" htmlFor="ns-label" hint="Shown on orders and filters, e.g. “Brand B”.">
        <input id="ns-label" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Brand B" className={inputCls} />
      </FormField>

      {woo ? (
        <>
          <FormField label="Store URL" htmlFor="ns-url">
            <input id="ns-url" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://store.example.com" className={inputCls} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Consumer key" htmlFor="ns-ck">
              <input id="ns-ck" type="password" autoComplete="new-password" value={form.consumerKey} onChange={(e) => set({ consumerKey: e.target.value })} placeholder="ck_…" className={inputCls} />
            </FormField>
            <FormField label="Consumer secret" htmlFor="ns-cs">
              <input id="ns-cs" type="password" autoComplete="new-password" value={form.consumerSecret} onChange={(e) => set({ consumerSecret: e.target.value })} placeholder="cs_…" className={inputCls} />
            </FormField>
          </div>
        </>
      ) : (
        <>
          <FormField label="Store domain" htmlFor="ns-domain">
            <input id="ns-domain" value={form.shopDomain} onChange={(e) => set({ shopDomain: e.target.value })} placeholder="brand-b.myshopify.com" className={inputCls} />
          </FormField>
          <AuthModePicker value={form.authMode} onChange={(v) => set({ authMode: v })} />
          {form.authMode === 'client_credentials' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Client ID" htmlFor="ns-cid">
                  <input id="ns-cid" type="password" autoComplete="new-password" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} className={inputCls} />
                </FormField>
                <FormField label="Client secret" htmlFor="ns-csec">
                  <input id="ns-csec" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder="shpss_…" className={inputCls} />
                </FormField>
              </div>
              <p className="text-xs text-muted">
                The app must be installed on this store and belong to the same Shopify organization. We check the
                credentials when you connect.
              </p>
            </>
          ) : (
            <FormField label="Admin API token" htmlFor="ns-tok">
              <input id="ns-tok" type="password" autoComplete="new-password" value={form.adminToken} onChange={(e) => set({ adminToken: e.target.value })} placeholder="shpat_…" className={inputCls} />
            </FormField>
          )}
          <FormField label="API version (optional)" htmlFor="ns-ver">
            <input id="ns-ver" value={form.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })} placeholder="e.g. 2026-10" className={inputCls} />
          </FormField>
        </>
      )}
      <FormField label="Webhook signing secret (optional)" htmlFor="ns-whs">
        <input id="ns-whs" type="password" autoComplete="new-password" value={form.webhookSecret} onChange={(e) => set({ webhookSecret: e.target.value })} className={inputCls} />
      </FormField>
      <Callout tone="info">
        {woo
          ? 'After connecting, create an “Order created” webhook in WooCommerce using the delivery URL shown on the store.'
          : 'After connecting, register the orders/create webhook in the store’s Shopify app using the URL shown on the store.'}
      </Callout>
    </SideSheet>
  );
}

/**
 * Pre-multistore tenants: the single Shopify connection stored on the company
 * (`/settings/shopify/credentials`). Shown ONLY while no store exists, so it's
 * never a second copy of a connected store.
 */
function LegacyConnection({ onConnectStore }: { onConnectStore: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<ShopifyOrderConfigResponse | null>(null);
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/order-config')
      .then((r) => {
        setRes(r);
        setDomain(r.config.shopDomain);
        setVersion(r.config.apiVersion);
      })
      .catch(() => setRes(null));
  }, []);

  const hasLegacy = !!res && (res.adminTokenSet || !!res.config.shopDomain);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const save = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<ShopifyOrderConfigResponse>('/settings/shopify/credentials', {
        method: 'PATCH',
        body: {
          ...(secret.trim() ? { webhookSecret: secret.trim() } : {}),
          ...(token.trim() ? { adminToken: token.trim() } : {}),
          shopDomain: domain.trim(),
          apiVersion: version,
        },
      });
      setRes(r);
      setSecret('');
      setToken('');
      toast.success('Connection saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!hasLegacy) {
    return (
      <SettingsCard>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex gap-2">
            <BrandMark brand="shopify" size="lg" />
            <BrandMark brand="woocommerce" size="lg" />
          </div>
          <p className="text-base font-bold text-ink">Connect your first store</p>
          <p className="max-w-sm text-sm text-muted">
            Bring in orders from Shopify or WooCommerce to confirm them on WhatsApp, book couriers and track delivery.
          </p>
          <Button onClick={onConnectStore}>
            <Plus size={16} /> Connect store
          </Button>
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      icon={<BrandMark brand="shopify" />}
      title={domain || 'Shopify store'}
      description="Connected the original way (one store per workspace)."
      action={<Badge tone={res?.adminTokenSet ? 'success' : 'warn'}>{res?.adminTokenSet ? 'Connected' : 'Token missing'}</Badge>}
    >
      <Callout
        tone="info"
        icon={<RefreshCw size={15} />}
        action={
          <Button size="sm" variant="secondary" onClick={onConnectStore}>
            Connect as a store
          </Button>
        }
      >
        <b>Move to Connected stores</b> to get auto-renewing tokens, store health and more than one store. Your current
        connection keeps working until you do.
      </Callout>
      <CopyField label="Order webhook URL (orders/create)" value={res?.webhookKey ? `${origin}/webhooks/shopify/${res.webhookKey}` : ''} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Store domain" htmlFor="lg-domain">
          <input id="lg-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-store.myshopify.com" className={inputCls} />
        </FormField>
        <FormField label="API version" htmlFor="lg-ver">
          <select id="lg-ver" value={version} onChange={(e) => setVersion(e.target.value)} className={inputCls}>
            {(res?.apiVersions ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Admin API token" htmlFor="lg-tok">
          <input id="lg-tok" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={res?.adminTokenSet ? '•••••••• saved — blank keeps it' : 'shpat_…'} className={inputCls} />
        </FormField>
        <FormField label="Webhook signing secret" htmlFor="lg-sec">
          <input id="lg-sec" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={res?.webhookSecretSet ? '•••••••• saved — blank keeps it' : 'Paste secret'} className={inputCls} />
        </FormField>
      </div>
      <div>
        <Button loading={busy} onClick={save}>
          Save connection
        </Button>
      </div>
    </SettingsCard>
  );
}

/**
 * Reconciles cancelled/voided state for orders created BEFORE cancellation
 * accounting shipped. Ongoing cancellations are handled automatically by the
 * orders/cancelled webhook — this is the one-time (re-runnable) catch-up.
 */
function CancelledOrdersCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      await apiFetch<{ started: boolean }>('/shopify/sync-cancellations', { method: 'POST' });
      toast.success('Reconciliation started — cancelled orders will drop out of your totals shortly.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to start reconciliation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title="Cancelled & voided orders"
      description="Orders cancelled or voided in the store drop out of counts and revenue automatically (the record stays in Orders, badged “Cancelled”)."
      action={
        <Button variant="secondary" size="sm" loading={busy} onClick={sync}>
          Re-check old orders
        </Button>
      }
    />
  );
}
