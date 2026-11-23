'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, PhoneCall, Plus, ShieldCheck, Star } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/modal';
import { SideSheet } from '@/components/ui/side-sheet';
import { BrandMark } from '@/components/icons/brand-logo';
import type { OnboardingStatusView } from '@/lib/crm-types';
import {
  Callout,
  CopyField,
  FormField,
  Rows,
  SettingRow,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  inputCls,
} from './shared';

type WhatsAppNumberRow = {
  id: number;
  label: string | null;
  wabaId: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  webhookKey: string;
  webhookUrl: string;
  verifyToken: string | null;
  tokenSet: boolean;
  appSecretSet: boolean;
  status: string;
  isPrimary: boolean;
};

const numberName = (n: WhatsAppNumberRow) => n.label || n.displayPhoneNumber || n.phoneNumberId;

/**
 * Settings → WhatsApp (owner/admin). One list of numbers (each opens a sheet
 * with its webhook pair + connection details), the Meta webhook for the
 * setup-wizard connection, WhatsApp Calling re-sync, and the owner-only reset.
 * The old "connection status" grid is folded into the number sheet — it used
 * to repeat what the number rows already showed.
 */
export function WhatsAppSection() {
  const toast = useToast();
  const { user } = useAuth();
  const [st, setSt] = useState<OnboardingStatusView | null>(null);
  const [rows, setRows] = useState<WhatsAppNumberRow[] | null>(null);
  const [limit, setLimit] = useState(1);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | 'setup' | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    const [s, r, sub] = await Promise.all([
      apiFetch<OnboardingStatusView>('/onboarding/status', { noOnboardingRedirect: true }).catch(() => null),
      apiFetch<WhatsAppNumberRow[]>('/settings/whatsapp/numbers').catch(() => [] as WhatsAppNumberRow[]),
      apiFetch<{ limits?: { whatsappNumberLimit?: number } }>('/billing/subscription').catch(() => null),
    ]);
    setSt(s);
    setRows(Array.isArray(r) ? r : []);
    setLimit(sub?.limits?.whatsappNumberLimit ?? 1);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doReset = async () => {
    setResetting(true);
    try {
      await apiFetch('/onboarding/reset', { method: 'POST' });
      toast.success('WhatsApp connection reset');
      setConfirmReset(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Reset failed');
    } finally {
      setResetting(false);
    }
  };

  if (loading || rows === null) return <SettingsSkeleton cards={3} />;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const count = rows.length;
  const canAdd = limit > 1 && count < limit;
  const setupNumber = count === 0 && st?.phoneNumberId ? st : null;
  const open = typeof openId === 'number' ? rows.find((n) => n.id === openId) ?? null : null;

  return (
    <SettingsPage
      icon={<BrandMark brand="whatsapp" size="lg" />}
      title="WhatsApp"
      description="Numbers connected through the Meta Cloud API. Every number lands in one inbox; replies go from the number the customer used."
      actions={
        <>
          <Link
            href="/onboarding"
            className="inline-flex h-10 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-sunken"
          >
            {st?.completed ? 'Update connection' : 'Continue setup'}
          </Link>
          {canAdd && (
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} /> Add number
            </Button>
          )}
        </>
      }
    >
      {st && !st.completed && (
        <Callout tone="warn" icon={<AlertTriangle size={15} className="text-amber-600" />}>
          <b>Setup isn’t finished</b> (step {st.currentStep} of 5). You can’t send messages until it is.
        </Callout>
      )}

      <SettingsCard
        title="Numbers"
        description={
          limit > 1
            ? `The default number sends confirmations, broadcasts and new chats. Your plan allows ${limit} numbers.`
            : 'The number your customers message.'
        }
      >
        {count === 0 && !setupNumber ? (
          <p className="text-sm text-muted">No number connected yet — finish setup to connect one.</p>
        ) : (
          <Rows>
            {setupNumber && (
              <NumberRow
                name={setupNumber.phoneNumberId ?? ''}
                sub="Connected in the setup wizard"
                ok={!!setupNumber.metaAccessToken}
                onManage={() => setOpenId('setup')}
              />
            )}
            {rows.map((n) => (
              <NumberRow
                key={n.id}
                name={numberName(n)}
                sub={[
                  n.label && n.displayPhoneNumber ? n.displayPhoneNumber : null,
                  `Phone ID ${n.phoneNumberId}`,
                  n.appSecretSet ? 'App secret set' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                isDefault={n.isPrimary && count > 1}
                ok={n.status === 'active' && n.tokenSet}
                status={n.status}
                onManage={() => setOpenId(n.id)}
              />
            ))}
          </Rows>
        )}
      </SettingsCard>

      {st && count <= 1 && (
        <SettingsCard
          icon={<BrandMark brand="meta" />}
          title="Webhook for your Meta app"
          description="Meta → your app → WhatsApp → Configuration. These never change."
        >
          <CopyField label="Callback URL" value={`${origin}/webhooks/meta/${st.webhookKey}`} />
          <CopyField label="Verify token" value={st.webhookVerifyToken} />
        </SettingsCard>
      )}

      <WebhookDeliveryCard />

      <CallingCard />

      {user?.role === 'owner' && (
        <SettingsCard tone="danger" title="Danger zone" description="Owner only.">
          <SettingRow
            title="Reset WhatsApp connection"
            description="Clears the Meta token, WABA and phone number. Contacts and messages are kept; you’ll run setup again before you can send."
          >
            <Button variant="danger" onClick={() => setConfirmReset(true)}>
              Reset…
            </Button>
          </SettingRow>
        </SettingsCard>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Reset WhatsApp connection?"
        message="This clears the Meta token, WABA and phone number. Contacts and messages are preserved. You must re-run onboarding to send again."
        danger
        confirmLabel="Reset"
        busy={resetting}
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />

      {open && <NumberSheet number={open} onClose={() => setOpenId(null)} onChanged={load} multi={count > 1} />}
      {openId === 'setup' && st && (
        <SetupNumberSheet st={st} origin={origin} onClose={() => setOpenId(null)} />
      )}
      <AddNumberSheet open={adding} onClose={() => setAdding(false)} onAdded={load} />
    </SettingsPage>
  );
}

function NumberRow({
  name,
  sub,
  ok,
  status,
  isDefault,
  onManage,
}: {
  name: string;
  sub: string;
  ok: boolean;
  status?: string;
  isDefault?: boolean;
  onManage: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <BrandMark brand="whatsapp" />
      <div className="min-w-[180px] flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold tabular-nums text-ink">
          {name}
          {isDefault && (
            <Badge tone="warn">
              <Star size={11} /> Default
            </Badge>
          )}
        </p>
        <p className="truncate text-[13px] text-muted">{sub}</p>
      </div>
      {ok ? <Badge tone="success">Connected</Badge> : <Badge tone="warn" className="capitalize">{status && status !== 'active' ? status : 'Needs attention'}</Badge>}
      <Button variant="secondary" size="sm" onClick={onManage}>
        Manage
      </Button>
    </div>
  );
}

function SetupNumberSheet({ st, origin, onClose }: { st: OnboardingStatusView; origin: string; onClose: () => void }) {
  const items: Array<[string, string]> = [
    ['Meta App ID', st.metaAppId || '—'],
    ['WABA ID', st.wabaId || '—'],
    ['Phone number ID', st.phoneNumberId || '—'],
    ['Access token', st.metaAccessToken ? 'Saved' : 'Not set'],
    ['App secret', st.webhookSecretSet ? 'Saved' : 'Not set'],
    ['Test message', st.testMessageSentAt ? 'Sent' : 'Not sent'],
  ];
  return (
    <SideSheet
      open
      onClose={onClose}
      icon={<BrandMark brand="whatsapp" size="lg" />}
      title={st.phoneNumberId ?? 'WhatsApp number'}
      subtitle={<Badge tone={st.completed ? 'success' : 'warn'}>{st.completed ? 'Connected' : `Setup step ${st.currentStep} of 5`}</Badge>}
      footer={
        <Link href="/onboarding" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
          Update in setup wizard
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="break-all text-sm font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <CopyField label="Callback URL" value={`${origin}/webhooks/meta/${st.webhookKey}`} />
      <CopyField label="Verify token" value={st.webhookVerifyToken} />
    </SideSheet>
  );
}

function NumberSheet({
  number: n,
  onClose,
  onChanged,
  multi,
}: {
  number: WhatsAppNumberRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
  multi: boolean;
}) {
  const toast = useToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const makeDefault = async () => {
    try {
      await apiFetch(`/settings/whatsapp/numbers/${n.id}/default`, { method: 'POST' });
      toast.success(`${numberName(n)} is now the default number`);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not set default');
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiFetch(`/settings/whatsapp/numbers/${n.id}`, { method: 'DELETE' });
      toast.success('Number removed');
      setConfirmRemove(false);
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not remove the number');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSheet
      open
      onClose={onClose}
      icon={<BrandMark brand="whatsapp" size="lg" />}
      title={numberName(n)}
      subtitle={
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={n.status === 'active' ? 'success' : 'neutral'} className="capitalize">
            {n.status === 'active' ? 'Connected' : n.status}
          </Badge>
          {n.isPrimary && multi && <Badge tone="warn">Default</Badge>}
        </div>
      }
      footer={
        <>
          {multi && (
            <Button variant="ghost" className="mr-auto text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setConfirmRemove(true)}>
              Remove number
            </Button>
          )}
          {multi && !n.isPrimary && (
            <Button variant="secondary" onClick={makeDefault}>
              Make default
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {(
          [
            ['Phone number', n.displayPhoneNumber || '—'],
            ['Phone number ID', n.phoneNumberId],
            ['WABA ID', n.wabaId || '—'],
            ['Access token', n.tokenSet ? 'Saved' : 'Not set'],
            ['App secret', n.appSecretSet ? 'Saved' : 'Not set'],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="break-all text-sm font-semibold tabular-nums text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <Callout tone="info" icon={<BrandMark brand="meta" size="sm" />}>
        Paste these into <b>this number’s</b> Meta app → WhatsApp → Configuration.
      </Callout>
      <CopyField label="Callback URL" value={n.webhookUrl} />
      {n.verifyToken && <CopyField label="Verify token" value={n.verifyToken} />}
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${numberName(n)}?`}
        message="Messages to this number stop arriving in CodesApp. Existing chats are kept."
        danger
        confirmLabel="Remove number"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </SideSheet>
  );
}

function AddNumberSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => Promise<void> }) {
  const toast = useToast();
  const empty = { label: '', wabaId: '', phoneNumberId: '', accessToken: '', appSecret: '' };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ label: '', wabaId: '', phoneNumberId: '', accessToken: '', appSecret: '' });
  }, [open]);

  const add = async () => {
    if (!form.phoneNumberId.trim() || form.accessToken.trim().length < 8) {
      toast.error('A phone number ID and an access token are required.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/settings/whatsapp/numbers', {
        method: 'POST',
        body: {
          label: form.label.trim() || undefined,
          wabaId: form.wabaId.trim() || undefined,
          phoneNumberId: form.phoneNumberId.trim(),
          accessToken: form.accessToken.trim(),
          appSecret: form.appSecret.trim() || undefined,
        },
      });
      toast.success('Number added — open it to copy its webhook');
      await onAdded();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not add the number');
    } finally {
      setBusy(false);
    }
  };

  const f = (k: keyof typeof form, label: string, opts: { secret?: boolean; placeholder?: string; hint?: string } = {}) => (
    <FormField label={label} htmlFor={`wa-${k}`} hint={opts.hint}>
      <input
        id={`wa-${k}`}
        type={opts.secret ? 'password' : 'text'}
        autoComplete={opts.secret ? 'new-password' : undefined}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        placeholder={opts.placeholder}
        className={inputCls}
      />
    </FormField>
  );

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      icon={<BrandMark brand="whatsapp" size="lg" />}
      title="Add a WhatsApp number"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={add}>
            Add number
          </Button>
        </>
      }
    >
      <Callout tone="brand" icon={<ShieldCheck size={15} className="text-brand-600" />}>
        Tokens and secrets are encrypted and never shown again.
      </Callout>
      {f('label', 'Label', { placeholder: 'e.g. Brand B', hint: 'Shown on chats from this number.' })}
      <div className="grid gap-4 sm:grid-cols-2">
        {f('phoneNumberId', 'Phone number ID', { placeholder: 'From Meta → WhatsApp → API setup' })}
        {f('wabaId', 'WABA ID (optional)')}
      </div>
      {f('accessToken', 'Access token', { secret: true })}
      {f('appSecret', 'App secret (optional)', { secret: true, hint: 'Lets CodesApp verify that webhooks really come from Meta.' })}
    </SideSheet>
  );
}

const SYNC_REASONS: Record<string, string> = {
  calls_business_number_unset: 'Calling isn’t set up on this platform yet.',
  not_calling_company: 'WhatsApp Calling isn’t enabled for your number.',
  no_token: 'No Meta access token is saved — update the connection first.',
  no_phone_number_id: 'No phone number ID is saved — update the connection first.',
  no_sip_password: 'Meta didn’t return calling credentials. Check that calling is enabled for the number in Meta.',
  error: 'Meta couldn’t be reached. Try again in a minute.',
};

/** WhatsApp Calling: on-demand re-sync of the SIP trunk password from Meta. */
function CallingCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ synced: boolean; reason?: string } | null>(null);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<{ synced: boolean; reason?: string }>('/calls/sync-trunk-auth', { method: 'POST' });
      setResult(r);
      if (r.synced) toast.success('Calling is in sync with Meta');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Re-sync failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      icon={
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal-600 text-white">
          <PhoneCall size={19} />
        </span>
      }
      title="WhatsApp Calling"
      description="Call customers from the inbox. The calling password re-syncs automatically whenever you save a new Meta token."
      action={
        result ? (
          <Badge tone={result.synced ? 'success' : 'neutral'}>{result.synced ? 'In sync' : 'Not active'}</Badge>
        ) : undefined
      }
    >
      <SettingRow
        title="Calls failing after a token change?"
        description={
          result && !result.synced
            ? SYNC_REASONS[result.reason ?? 'error'] ?? 'Calling couldn’t be synced.'
            : 'Re-check the calling password with Meta now.'
        }
      >
        <Button variant="secondary" size="sm" loading={busy} onClick={sync}>
          Check &amp; re-sync
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

type WabaSubscription = { wabaId: string; subscribed: boolean; fixed?: boolean; apps?: string[]; error?: string };

/**
 * Meta only sends inbound messages + sent/delivered/read ticks to apps that are
 * subscribed to the WhatsApp Business Account. Verifying the callback URL is
 * not enough. The server checks + repairs this automatically; this card shows
 * the state and lets an admin force a repair.
 */
function WebhookDeliveryCard() {
  const toast = useToast();
  const [rows, setRows] = useState<WabaSubscription[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await apiFetch<WabaSubscription[]>('/settings/whatsapp/webhook-subscription'));
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const fix = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<WabaSubscription[]>('/settings/whatsapp/webhook-subscription', { method: 'POST' });
      setRows(r);
      if (r.length && r.every((x) => x.subscribed)) toast.success('Meta will now deliver messages and ticks');
      else toast.error(r.find((x) => x.error)?.error ?? 'Could not subscribe the app');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Repair failed');
    } finally {
      setBusy(false);
    }
  };

  if (!rows || rows.length === 0) return null;
  const allOk = rows.every((r) => r.subscribed);

  return (
    <SettingsCard
      icon={<BrandMark brand="meta" />}
      title="Message delivery from Meta"
      description="Incoming messages and delivery/read ticks only arrive when your Meta app is subscribed to your WhatsApp Business Account."
      action={<Badge tone={allOk ? 'success' : 'danger'}>{allOk ? 'Receiving' : 'Not receiving'}</Badge>}
    >
      {rows.map((r) => (
        <SettingRow
          key={r.wabaId}
          title={`WABA ${r.wabaId}`}
          description={
            r.subscribed
              ? `Subscribed app: ${(r.apps ?? []).join(', ') || 'yes'}`
              : r.error ?? 'No app subscribed: Meta is not sending messages or ticks.'
          }
        >
          {!r.subscribed && (
            <Button variant="secondary" size="sm" loading={busy} onClick={fix}>
              Fix now
            </Button>
          )}
        </SettingRow>
      ))}
    </SettingsCard>
  );
}
