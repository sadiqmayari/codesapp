'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { BrandMark } from '@/components/icons/brand-logo';
import { fmtDateTime } from '@/lib/utils';
import {
  Callout,
  CopyField,
  FormField,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  inputCls,
} from './shared';

interface MetaPage {
  id: number;
  pageId: string;
  name: string;
  pictureUrl: string | null;
  igUserId: string | null;
  igUsername: string | null;
  status: 'active' | 'error' | 'disconnected';
  lastError: string | null;
  lastEventAt: string | null;
}

interface Available {
  pageId: string;
  name: string;
  pictureUrl: string | null;
  igUserId: string | null;
  igUsername: string | null;
  enabled: boolean;
  otherWorkspace: boolean;
}

interface Status {
  tokenSet: boolean;
  /** 'whatsapp' = reusing the WhatsApp token (one token for everything). */
  tokenSource?: 'own' | 'whatsapp' | null;
  webhookKey: string | null;
  verifyToken: string | null;
  pages: MetaPage[];
}

const BASE = '/settings/meta-social';

/**
 * Settings → Facebook & Instagram. The tenant pastes a system-user token from
 * their OWN Meta app (the same app as their WhatsApp); CodesApp lists the
 * Pages + linked Instagram accounts, stores a Page token per enabled Page and
 * subscribes it to the app. The webhook URL + verify token are the WhatsApp
 * ones, nothing new to copy.
 */
export function MetaSocialSection() {
  const { user } = useAuth();
  const toast = useToast();
  const enabled = user?.company?.modules ? user.company.modules.meta_inbox === true : true;
  const [st, setSt] = useState<Status | null>(null);
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const [editToken, setEditToken] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<Status>(`${BASE}/status`);
      setSt(s);
      if (s.tokenSet) {
        apiFetch<{ available: Available[] }>(`${BASE}/available`)
          .then((r) => setAvailable(r.available))
          .catch(() => setAvailable([]));
      }
    } catch (e) {
      setSt({ tokenSet: false, webhookKey: null, verifyToken: null, pages: [] });
      if (!(e instanceof ApiError && e.status === 403)) toast.error('Could not load Facebook & Instagram settings');
    }
  }, [toast]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  if (!enabled) {
    return (
      <SettingsPage title="Facebook & Instagram" description="Reply to Messenger and Instagram messages and comments from CodesApp.">
        <Callout tone="info">Facebook & Instagram is not switched on for this workspace yet. Ask CodesApp support to enable it.</Callout>
      </SettingsPage>
    );
  }
  if (!st) return <SettingsSkeleton cards={3} />;

  // No token = use the WhatsApp token already saved (one token for everything).
  const connect = async (useWhatsapp = false) => {
    setBusy(useWhatsapp ? 'connect-wa' : 'connect');
    try {
      const r = await apiFetch<{ account: string | null; missingScopes: string[]; available: Available[] }>(`${BASE}/connect`, {
        method: 'POST',
        body: useWhatsapp ? {} : { token: token.trim() },
      });
      setMissing(r.missingScopes);
      setAvailable(r.available);
      setToken('');
      setEditToken(false);
      toast.success(r.account ? `Connected as ${r.account}` : 'Token saved');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not connect');
    } finally {
      setBusy(null);
    }
  };

  const pageRow = (pageId: string) => st.pages.find((p) => p.pageId === pageId);

  const toggle = async (a: Available, on: boolean) => {
    setBusy(a.pageId);
    try {
      if (on) {
        const p = await apiFetch<MetaPage>(`${BASE}/pages`, { method: 'POST', body: { pageId: a.pageId } });
        if (p.status === 'error') toast.error(p.lastError ?? 'Meta refused the Page subscription');
        else toast.success(`${a.name} is connected`);
      } else {
        const row = pageRow(a.pageId);
        if (row) await apiFetch(`${BASE}/pages/${row.id}`, { method: 'DELETE' });
        toast.info(`${a.name} turned off`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update the Page');
    } finally {
      setBusy(null);
    }
  };

  const resubscribe = async (p: MetaPage) => {
    setBusy(`re-${p.id}`);
    try {
      const r = await apiFetch<MetaPage>(`${BASE}/pages/${p.id}/resubscribe`, { method: 'POST' });
      if (r.status === 'error') toast.error(r.lastError ?? 'Still failing');
      else toast.success('Page subscribed again');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not resubscribe');
    } finally {
      setBusy(null);
    }
  };

  // Show stored Pages even when the live list hasn't loaded / the token lost access.
  const rows: Available[] = available ?? [];
  const extra = st.pages
    .filter((p) => !rows.some((a) => a.pageId === p.pageId))
    .map<Available>((p) => ({
      pageId: p.pageId,
      name: p.name,
      pictureUrl: p.pictureUrl,
      igUserId: p.igUserId,
      igUsername: p.igUsername,
      enabled: p.status !== 'disconnected',
      otherWorkspace: false,
    }));
  const all = [...rows, ...extra];
  const callback = st.webhookKey ? `${origin}/webhooks/meta/${st.webhookKey}` : '';

  return (
    <SettingsPage
      title="Facebook & Instagram"
      description="Messenger and Instagram DMs arrive in the inbox; Page and Instagram comments arrive in Comments. Uses your own Meta app, the same one as your WhatsApp."
      icon={<BrandMark brand="messenger" />}
    >
      <SettingsCard
        title="Meta connection"
        description="One token for WhatsApp, Facebook and Instagram: CodesApp uses the WhatsApp token you already saved. Give that system-user token the Page and Instagram permissions too."
        action={st.tokenSet ? <Badge tone="success">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
      >
        {st.tokenSet && !editToken ? (
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] text-muted">
              {st.tokenSource === 'own' ? 'Separate Facebook & Instagram token (stored encrypted)' : 'Using your WhatsApp token'}
            </code>
            <Button variant="secondary" size="sm" loading={busy === 'connect-wa'} onClick={() => void connect(true)}>
              {st.tokenSource === 'own' ? 'Use WhatsApp token instead' : 'Check permissions'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditToken(true)}>
              Use a different token
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <FormField
              label="System-user access token"
              htmlFor="meta-social-token"
              hint="Only if you don't want to reuse the WhatsApp token. Give it: pages_show_list, pages_messaging, pages_manage_metadata, pages_read_engagement, pages_manage_engagement, instagram_basic, instagram_manage_messages, instagram_manage_comments. Assign the Page (and its Instagram account) to the system user."
            >
              <textarea
                id="meta-social-token"
                rows={3}
                className={inputCls}
                placeholder="EAAG…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void connect(false)} loading={busy === 'connect'} disabled={token.trim().length < 20}>
                {st.tokenSet ? 'Save this token' : 'Connect with this token'}
              </Button>
              {st.tokenSet && (
                <Button variant="ghost" onClick={() => setEditToken(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
        {missing.length > 0 && (
          <Callout tone="warn" icon={<AlertTriangle size={16} className="text-amber-600" />}>
            The token is missing: <b>{missing.join(', ')}</b>. In Business Settings → System users, generate the token again with these permissions ticked too, then save it in Settings → WhatsApp so WhatsApp, Facebook and Instagram keep sharing one token.
          </Callout>
        )}
      </SettingsCard>

      {st.tokenSet && (
        <SettingsCard
          title="Pages & Instagram accounts"
          description="Turn on the Pages whose Messenger (and linked Instagram) chats and comments should come into CodesApp."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setAvailable(null);
                void load();
              }}
            >
              <RefreshCw size={14} /> Refresh list
            </Button>
          }
        >
          {available === null ? (
            <SettingsSkeleton cards={1} />
          ) : all.length === 0 ? (
            <p className="text-sm text-muted">No Pages found with this token. In Business Settings → System users: assign the Page (and its Instagram account) to the system user and generate the token with the Page + Instagram permissions, save it in Settings → WhatsApp, then refresh.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {all.map((a) => {
                const row = pageRow(a.pageId);
                const on = !!row && row.status !== 'disconnected';
                return (
                  <div key={a.pageId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3.5 py-3">
                    {a.pictureUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.pictureUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <BrandMark brand="facebook" />
                    )}
                    <div className="min-w-[180px] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-ink">{a.name}</span>
                        <span className="text-xs text-muted">Facebook Page</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
                        {a.igUsername ? (
                          <>
                            <BrandMark brand="instagram" size="sm" className="!h-4 !w-4 !rounded [&>svg]:!h-2.5 [&>svg]:!w-2.5" />@{a.igUsername} linked
                          </>
                        ) : (
                          'No Instagram account linked'
                        )}
                      </div>
                      {row && on && row.status === 'active' && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300">
                          <CheckCircle2 size={13} />
                          Receiving messages + comments
                          {row.lastEventAt ? ` · last event ${fmtDateTime(row.lastEventAt)}` : ' · waiting for the first event'}
                        </div>
                      )}
                      {row && row.status === 'error' && (
                        <div className="mt-1 text-xs text-red-600">{row.lastError ?? 'Subscription failed'}</div>
                      )}
                      {a.otherWorkspace && (
                        <div className="mt-1 text-xs text-amber-700">Connected to another CodesApp workspace</div>
                      )}
                    </div>
                    {row && row.status === 'error' && (
                      <Button variant="secondary" size="sm" loading={busy === `re-${row.id}`} onClick={() => resubscribe(row)}>
                        Retry
                      </Button>
                    )}
                    <Switch
                      checked={on}
                      disabled={a.otherWorkspace || busy === a.pageId}
                      onChange={(v) => void toggle(a, v)}
                      label={`${a.name} ${on ? 'on' : 'off'}`}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        icon={<BrandMark brand="meta" />}
        title="Finish in your Meta app"
        description="Same callback URL and verify token as your WhatsApp webhook."
      >
        {callback ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <CopyField label="Callback URL" value={callback} />
            <CopyField label="Verify token" value={st.verifyToken ?? ''} />
          </div>
        ) : (
          <Callout tone="warn">Connect WhatsApp first: the Facebook & Instagram webhook uses the same callback URL.</Callout>
        )}
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-[13px] text-ink">
          <li>
            Meta app → Webhooks → <b>Page</b>: use the URL above and subscribe <b>messages, messaging_postbacks, message_echoes, message_reads, message_reactions, feed</b>.
          </li>
          <li>
            Webhooks → <b>Instagram</b>: same URL, subscribe <b>messages, comments</b>.
          </li>
          <li>
            Instagram app → Settings → Privacy → Messages → Connected tools: turn on <b>Allow access to messages</b>.
          </li>
          <li>Turn the Page on above. CodesApp subscribes it to your app automatically.</li>
        </ol>
        <p className="text-xs text-muted">
          You can reply within 24 hours of the customer&apos;s last message, the Messenger and Instagram rule. Templates and calls are WhatsApp-only.
        </p>
      </SettingsCard>
    </SettingsPage>
  );
}
