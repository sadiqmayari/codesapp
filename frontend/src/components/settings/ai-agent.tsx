'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CalendarDays,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  ShoppingCart,
  Sparkles,
  Trash2,
  UserRound,
  BookOpen,
  Package,
  CreditCard,
  Users,
  Headphones,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SaveBar } from '@/components/ui/save-bar';
import {
  Callout,
  FormField,
  Rows,
  SettingRow,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  inputCls,
} from './shared';
import {
  cancelBooking,
  getAgentProfile,
  getPack,
  getPerformance,
  getStoreProfiles,
  listBookings,
  runPlayground,
  saveAgentProfile,
  saveStoreProfile,
  INDUSTRY_LABEL,
  type AgentPerformance,
  type AgentProfile,
  type AgentTrace,
  type AiBooking,
  type BookableService,
  type DayKey,
  type Industry,
  type LeadField,
  type PlaygroundMsg,
  type StoreAiProfile,
} from '@/lib/ai-agent';

const DAYS: Array<[DayKey, string]> = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

const LANGUAGE_CHOICES = [
  'English',
  'Roman Urdu',
  'Urdu',
  'Arabic',
  'Hindi',
  'Hinglish',
  'Bengali',
  'Turkish',
  'French',
  'Spanish',
  'Punjabi',
  'Pashto',
  'Sindhi',
];

/** Shared load/edit/save state for the profile-backed AI pages. */
function useProfileForm() {
  const toast = useToast();
  const [base, setBase] = useState<AgentProfile | null>(null);
  const [form, setForm] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getAgentProfile()
      .then((p) => {
        if (!alive) return;
        setBase(p);
        setForm(p);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load the AI agent'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [toast]);

  const set = useCallback((p: Partial<AgentProfile>) => setForm((f) => (f ? { ...f, ...p } : f)), []);
  const dirty = !!form && !!base && JSON.stringify(form) !== JSON.stringify(base);

  const save = useCallback(
    async (keys: Array<keyof AgentProfile>) => {
      if (!form) return;
      setSaving(true);
      try {
        const body: Record<string, unknown> = {};
        for (const k of keys) body[k] = form[k];
        const updated = await saveAgentProfile(body);
        const merged = { ...form, ...updated };
        setBase(merged);
        setForm(merged);
        toast.success('Saved');
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [form, toast],
  );

  return { base, form, set, setForm, loading, saving, dirty, save, discard: () => setForm(base) };
}

// ── Profile & persona ─────────────────────────────────────────────────────

export function AiProfileSection() {
  const toast = useToast();
  const f = useProfileForm();
  const [stores, setStores] = useState<StoreAiProfile[]>([]);
  const [applying, setApplying] = useState<Industry | null>(null);

  useEffect(() => {
    getStoreProfiles().then(setStores).catch(() => setStores([]));
  }, []);

  if (f.loading) return <SettingsSkeleton cards={3} />;
  if (!f.form) return <Callout tone="warn">Couldn’t load the AI agent. Refresh to try again.</Callout>;
  const form = f.form;

  const pickPack = async (key: Industry) => {
    if (key === form.industry) return;
    setApplying(key);
    try {
      const p = await getPack(key);
      const skills = JSON.parse(JSON.stringify(form.skills)) as typeof form.skills;
      for (const k of Object.keys(skills) as Array<keyof typeof skills>) {
        (skills[k] as { enabled: boolean }).enabled = p.skills.includes(k);
      }
      skills.bookings = { ...skills.bookings, services: p.services };
      skills.leads = { ...skills.leads, fields: p.leadFields, hotRule: p.hotLeadRule };
      f.set({
        industry: key,
        agentName: p.agentName,
        agentRole: p.agentRole,
        goals: p.goals,
        doRules: p.doRules,
        dontRules: p.dontRules,
        skills,
      });
      toast.info(`${p.label} defaults applied — review and save.`);
    } catch {
      toast.error('Could not load that pack');
    } finally {
      setApplying(null);
    }
  };

  const toggleLang = (l: string) => {
    const has = form.languages.includes(l);
    f.set({ languages: has ? form.languages.filter((x) => x !== l) : [...form.languages, l] });
  };

  return (
    <SettingsPage
      title="Profile & persona"
      description="Who your AI agent is, what business it works for, and how it speaks. Picking an industry pre-fills sensible goals, rules and skills — edit anything."
      icon={<span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"><UserRound size={20} /></span>}
    >
      <SettingsCard title="Industry" description="Changes the defaults below and which skills are on. Your knowledge base is kept.">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {form.packs.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pickPack(p.key)}
              aria-pressed={form.industry === p.key}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition',
                form.industry === p.key
                  ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-900/30'
                  : 'border-line hover:bg-sunken',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-bold text-ink">
                {applying === p.key && <Loader2 size={13} className="animate-spin" />}
                {p.label}
              </span>
              <span className="text-xs text-muted">{p.description}</span>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Persona">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name customers see" htmlFor="ag-name">
            <input id="ag-name" className={inputCls} value={form.agentName} maxLength={80} onChange={(e) => f.set({ agentName: e.target.value })} />
          </FormField>
          <FormField label="Role" htmlFor="ag-role">
            <input id="ag-role" className={inputCls} value={form.agentRole} maxLength={120} onChange={(e) => f.set({ agentRole: e.target.value })} />
          </FormField>
        </div>
        <FormField label="Goals, in priority order" htmlFor="ag-goals">
          <textarea id="ag-goals" rows={4} className={inputCls} value={form.goals} maxLength={4000} onChange={(e) => f.set({ goals: e.target.value })} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Always" htmlFor="ag-do" hint="One rule per line.">
            <textarea id="ag-do" rows={4} className={inputCls} value={form.doRules} maxLength={4000} onChange={(e) => f.set({ doRules: e.target.value })} />
          </FormField>
          <FormField label="Never" htmlFor="ag-dont" hint="One rule per line.">
            <textarea id="ag-dont" rows={4} className={inputCls} value={form.dontRules} maxLength={4000} onChange={(e) => f.set({ dontRules: e.target.value })} />
          </FormField>
        </div>
        <FormField label="Voice & tone" htmlFor="ag-tone" hint="How replies should sound.">
          <textarea id="ag-tone" rows={2} className={inputCls} value={form.tone} maxLength={2000} placeholder="Warm, short, uses the customer's name once." onChange={(e) => f.set({ tone: e.target.value })} />
        </FormField>
      </SettingsCard>

      <SettingsCard title="Language & region" description="Replaces the old fixed “English / Roman Urdu only” rule — choose what fits your customers.">
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Country (ISO-2)" htmlFor="ag-cc">
            <input id="ag-cc" className={cn(inputCls, 'uppercase')} maxLength={2} value={form.countryCode} onChange={(e) => f.set({ countryCode: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField label="Currency" htmlFor="ag-cur">
            <div className="flex gap-2">
              <input id="ag-cur" className={cn(inputCls, 'uppercase')} maxLength={3} value={form.currencyCode} onChange={(e) => f.set({ currencyCode: e.target.value.toUpperCase() })} aria-label="Currency code" />
              <input className={inputCls} maxLength={8} value={form.currencySymbol} onChange={(e) => f.set({ currencySymbol: e.target.value })} aria-label="Currency symbol" />
            </div>
          </FormField>
          <FormField label="Voice-note language hint" htmlFor="ag-voice" hint="ISO code, e.g. ur, ar, hi — blank = auto-detect.">
            <input id="ag-voice" className={inputCls} maxLength={8} value={form.voiceLanguage} onChange={(e) => f.set({ voiceLanguage: e.target.value.toLowerCase() })} />
          </FormField>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-ink">Languages the agent may reply in</p>
          <div className="flex flex-wrap gap-1.5">
            {Array.from(new Set([...LANGUAGE_CHOICES, ...form.languages])).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => toggleLang(l)}
                aria-pressed={form.languages.includes(l)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-semibold',
                  form.languages.includes(l) ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : 'border-line text-muted hover:bg-sunken',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <Rows>
          <SettingRow title="Mirror the customer" description="Reply in the language and script the customer wrote in (when it’s on the list).">
            <Switch checked={form.mirrorLanguage} onChange={(v) => f.set({ mirrorLanguage: v })} label="Mirror the customer" />
          </SettingRow>
        </Rows>
      </SettingsCard>

      <SettingsCard title="Payments" description="Shared only through the payment tool — never searched from knowledge.">
        <FormField label="Bank / wallet details for advance payment" htmlFor="ag-pay" hint="Stored encrypted. Leave blank if you don't take advance payments.">
          <textarea id="ag-pay" rows={3} className={inputCls} value={form.paymentDetails} maxLength={2000} placeholder={'Bank: Meezan Bank\nTitle: Your Business\nIBAN: PK00 MEZN 0000 0000 0000 0000'} onChange={(e) => f.set({ paymentDetails: e.target.value })} />
        </FormField>
      </SettingsCard>

      {stores.length > 1 && <StoreOverrides stores={stores} onSaved={() => getStoreProfiles().then(setStores)} />}

      <SaveBar
        dirty={f.dirty}
        saving={f.saving}
        onDiscard={f.discard}
        onSave={() =>
          f.save([
            'industry',
            'agentName',
            'agentRole',
            'goals',
            'doRules',
            'dontRules',
            'tone',
            'countryCode',
            'currencyCode',
            'currencySymbol',
            'languages',
            'mirrorLanguage',
            'voiceLanguage',
            'paymentDetails',
            'skills',
          ])
        }
      />
    </SettingsPage>
  );
}

function StoreOverrides({ stores, onSaved }: { stores: StoreAiProfile[]; onSaved: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Record<number, Partial<StoreAiProfile> & { paymentDetails?: string }>>({});
  const save = async (s: StoreAiProfile) => {
    const e = edit[s.storeId] ?? {};
    try {
      await saveStoreProfile(s.storeId, {
        brandName: e.brandName ?? s.brandName,
        tone: e.tone ?? s.tone,
        currencyCode: e.currencyCode ?? s.currencyCode,
        currencySymbol: e.currencySymbol ?? s.currencySymbol,
        ...(e.paymentDetails !== undefined ? { paymentDetails: e.paymentDetails } : {}),
      });
      toast.success(`${s.label} saved`);
      setEdit((x) => ({ ...x, [s.storeId]: {} }));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.userMessage : 'Save failed');
    }
  };
  return (
    <SettingsCard title="Per-store brand" description="For chats about a specific store: its own brand name, voice, currency and payment details.">
      <div className="flex flex-col gap-3">
        {stores.map((s) => {
          const e = edit[s.storeId] ?? {};
          const v = <K extends keyof StoreAiProfile>(k: K) => (e[k] as StoreAiProfile[K]) ?? s[k];
          const up = (p: Partial<StoreAiProfile> & { paymentDetails?: string }) =>
            setEdit((x) => ({ ...x, [s.storeId]: { ...(x[s.storeId] ?? {}), ...p } }));
          return (
            <div key={s.storeId} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <b className="text-sm text-ink">{s.label}</b>
                <Badge tone="neutral">{s.provider}</Badge>
                {s.isPrimary && <Badge tone="brand">primary</Badge>}
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <input className={inputCls} placeholder="Brand name" value={v('brandName')} onChange={(x) => up({ brandName: x.target.value })} aria-label="Brand name" />
                <input className={inputCls} placeholder="Voice (optional)" value={v('tone')} onChange={(x) => up({ tone: x.target.value })} aria-label="Voice" />
                <div className="flex gap-2">
                  <input className={cn(inputCls, 'uppercase')} placeholder="PKR" maxLength={3} value={v('currencyCode')} onChange={(x) => up({ currencyCode: x.target.value })} aria-label="Currency code" />
                  <input className={inputCls} placeholder="Rs" maxLength={8} value={v('currencySymbol')} onChange={(x) => up({ currencySymbol: x.target.value })} aria-label="Currency symbol" />
                </div>
                <input className={inputCls} placeholder={s.paymentDetailsSet ? 'Payment details set — type to replace' : 'Payment details (optional)'} value={e.paymentDetails ?? ''} onChange={(x) => up({ paymentDetails: x.target.value })} aria-label="Payment details" />
              </div>
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="secondary" onClick={() => save(s)}>Save store</Button>
              </div>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}

// ── Skills ────────────────────────────────────────────────────────────────

const SKILL_META: Array<{
  key: keyof AgentProfile['skills'];
  title: string;
  desc: string;
  icon: typeof BookOpen;
  tools: string;
}> = [
  { key: 'knowledge', title: 'Knowledge Q&A', desc: 'Answers from your FAQ, website, documents and policies — and cites them.', icon: BookOpen, tools: 'search_knowledge' },
  { key: 'orders', title: 'Catalogue & orders', desc: 'Live product search, cart, delivery charges, then summary → confirm → order.', icon: ShoppingCart, tools: 'search_products · set_cart · review_order · place_order' },
  { key: 'order_status', title: 'Order status & returns', desc: 'Tracking, delivery questions and return / exchange tickets.', icon: Package, tools: 'get_order_status · open_ticket' },
  { key: 'payments', title: 'Payment details', desc: 'Shares your bank / wallet details from the Profile page.', icon: CreditCard, tools: 'get_payment_details' },
  { key: 'bookings', title: 'Appointments & reservations', desc: 'Free slots from your business hours, book / cancel with capacity.', icon: CalendarDays, tools: 'get_slots · book_slot · cancel_booking' },
  { key: 'leads', title: 'Lead capture', desc: 'Collects your own fields, tags hot leads, sends a lead.qualified webhook.', icon: Users, tools: 'save_lead' },
  { key: 'handoff', title: 'Handoff to team', desc: 'Connects the customer to a person (rules on Handoff & hours).', icon: Headphones, tools: 'handoff' },
];

export function AiSkillsSection() {
  const f = useProfileForm();
  if (f.loading) return <SettingsSkeleton cards={3} />;
  if (!f.form) return <Callout tone="warn">Couldn’t load the AI agent.</Callout>;
  const form = f.form;
  const sk = form.skills;
  const setSkill = <K extends keyof typeof sk>(k: K, p: Partial<(typeof sk)[K]>) =>
    f.set({ skills: { ...sk, [k]: { ...sk[k], ...p } } });

  return (
    <SettingsPage
      title="Skills"
      description={`What your agent can do. Pre-set for ${INDUSTRY_LABEL[form.industry]} — the agent only ever gets the tools switched on here.`}
      icon={<span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"><Sparkles size={20} /></span>}
    >
      <SettingsCard flush>
        <ul className="divide-y divide-line">
          {SKILL_META.map((m) => {
            const Icon = m.icon;
            return (
              <li key={m.key} className="flex items-start gap-3 px-5 py-4">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sunken text-brand-700 dark:text-brand-300"><Icon size={17} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink">{m.title}</p>
                  <p className="text-[13px] text-muted">{m.desc}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">{m.tools}</p>
                </div>
                <Switch checked={sk[m.key].enabled} onChange={(v) => setSkill(m.key, { enabled: v } as never)} label={m.title} />
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {sk.orders.enabled && (
        <SettingsCard title="Orders" description="Automatic placement is controlled on the AI assistant page (“Let the AI create store orders”).">
          <Rows>
            <SettingRow title="Offer cash on delivery">
              <Switch checked={sk.orders.allowCod} onChange={(v) => setSkill('orders', { allowCod: v })} label="Offer cash on delivery" />
            </SettingRow>
            <SettingRow title="Offer prepaid / bank transfer" description="The agent shares your payment details and hands the slip to your team.">
              <Switch checked={sk.orders.allowPrepaid} onChange={(v) => setSkill('orders', { allowPrepaid: v })} label="Offer prepaid" />
            </SettingRow>
          </Rows>
        </SettingsCard>
      )}

      {sk.bookings.enabled && (
        <SettingsCard title="Bookable services" description="Slots come from your business hours (Handoff & hours). Capacity = bookings allowed in the same slot.">
          <ServicesEditor value={sk.bookings.services} onChange={(services) => setSkill('bookings', { services })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Earliest booking (minutes from now)" htmlFor="bk-lead">
              <input id="bk-lead" type="number" min={0} className={inputCls} value={sk.bookings.leadTimeMin} onChange={(e) => setSkill('bookings', { leadTimeMin: Number(e.target.value) || 0 })} />
            </FormField>
            <FormField label="Book up to (days ahead)" htmlFor="bk-max">
              <input id="bk-max" type="number" min={1} className={inputCls} value={sk.bookings.maxDaysAhead} onChange={(e) => setSkill('bookings', { maxDaysAhead: Number(e.target.value) || 1 })} />
            </FormField>
          </div>
          <BookingsList />
        </SettingsCard>
      )}

      {sk.leads.enabled && (
        <SettingsCard title="Lead fields" description="Saved on the contact as custom fields (lead_<key>) and tagged.">
          <LeadFieldsEditor value={sk.leads.fields} onChange={(fields) => setSkill('leads', { fields })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Hot lead when…" htmlFor="ld-hot" hint="Plain words — the agent judges it.">
              <input id="ld-hot" className={inputCls} value={sk.leads.hotRule} placeholder="Budget given and moving within 3 months" onChange={(e) => setSkill('leads', { hotRule: e.target.value })} />
            </FormField>
            <FormField label="Contact tag" htmlFor="ld-tag">
              <input id="ld-tag" className={inputCls} value={sk.leads.tag} maxLength={40} onChange={(e) => setSkill('leads', { tag: e.target.value })} />
            </FormField>
          </div>
        </SettingsCard>
      )}

      <SaveBar dirty={f.dirty} saving={f.saving} onDiscard={f.discard} onSave={() => f.save(['skills'])} />
    </SettingsPage>
  );
}

function ServicesEditor({ value, onChange }: { value: BookableService[]; onChange: (v: BookableService[]) => void }) {
  const up = (i: number, p: Partial<BookableService>) => onChange(value.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="flex flex-col gap-2">
      {value.map((s, i) => (
        <div key={i} className="grid grid-cols-[1fr_90px_90px_1fr_auto] items-center gap-2">
          <input className={inputCls} value={s.name} placeholder="Service" onChange={(e) => up(i, { name: e.target.value })} aria-label="Service name" />
          <input className={inputCls} type="number" min={5} value={s.durationMin} onChange={(e) => up(i, { durationMin: Number(e.target.value) || 30 })} aria-label="Minutes" title="Minutes" />
          <input className={inputCls} type="number" min={1} value={s.capacity} onChange={(e) => up(i, { capacity: Number(e.target.value) || 1 })} aria-label="Capacity" title="Capacity per slot" />
          <input className={inputCls} value={s.resource ?? ''} placeholder="Staff / room (optional)" onChange={(e) => up(i, { resource: e.target.value || undefined })} aria-label="Resource" />
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded-lg p-2 text-muted hover:bg-sunken hover:text-red-600" aria-label="Remove service"><Trash2 size={15} /></button>
        </div>
      ))}
      <p className="text-xs text-muted">Columns: service · minutes · capacity per slot · staff/room</p>
      <div><Button size="sm" variant="secondary" onClick={() => onChange([...value, { name: '', durationMin: 30, capacity: 1 }])}><Plus size={14} /> Add service</Button></div>
    </div>
  );
}

function LeadFieldsEditor({ value, onChange }: { value: LeadField[]; onChange: (v: LeadField[]) => void }) {
  const up = (i: number, p: Partial<LeadField>) => onChange(value.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="flex flex-col gap-2">
      {value.map((fld, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
          <input className={inputCls} value={fld.label} placeholder="Label (e.g. Budget)" onChange={(e) => up(i, { label: e.target.value, key: fld.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} aria-label="Field label" />
          <input className={cn(inputCls, 'font-mono text-xs')} value={fld.key} placeholder="key" onChange={(e) => up(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} aria-label="Field key" />
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted"><input type="checkbox" checked={fld.required} onChange={(e) => up(i, { required: e.target.checked })} className="accent-brand-600" /> required</label>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded-lg p-2 text-muted hover:bg-sunken hover:text-red-600" aria-label="Remove field"><Trash2 size={15} /></button>
        </div>
      ))}
      <div><Button size="sm" variant="secondary" onClick={() => onChange([...value, { key: '', label: '', required: false }])}><Plus size={14} /> Add field</Button></div>
    </div>
  );
}

function BookingsList() {
  const toast = useToast();
  const [rows, setRows] = useState<AiBooking[] | null>(null);
  const load = useCallback(() => listBookings().then(setRows).catch(() => setRows([])), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!rows) return null;
  const upcoming = rows.filter((r) => r.status === 'booked');
  return (
    <div className="rounded-xl border border-line">
      <p className="border-b border-line px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted">Upcoming bookings ({upcoming.length})</p>
      {upcoming.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted">No bookings yet.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {upcoming.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="w-40 shrink-0 tabular-nums text-ink">{new Date(b.starts_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
              <span className="min-w-0 flex-1 truncate">{b.service} · {b.name ?? 'Customer'}{b.party_size > 1 ? ` · ${b.party_size} people` : ''}</span>
              <Badge tone={b.created_by === 'ai' ? 'violet' : 'neutral'}>{b.created_by === 'ai' ? 'AI' : 'agent'}</Badge>
              <button
                type="button"
                className="text-xs font-semibold text-red-600 hover:underline"
                onClick={async () => {
                  await cancelBooking(b.id).catch(() => toast.error('Cancel failed'));
                  load();
                }}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Handoff & hours ───────────────────────────────────────────────────────

export function AiHandoffSection() {
  const f = useProfileForm();
  const [kw, setKw] = useState('');
  if (f.loading) return <SettingsSkeleton cards={3} />;
  if (!f.form) return <Callout tone="warn">Couldn’t load the AI agent.</Callout>;
  const ho = f.form.handoff;
  const hours = f.form.hours;
  const setHo = (p: Partial<typeof ho>) => f.set({ handoff: { ...ho, ...p } });
  const setHours = (p: Partial<typeof hours>) => f.set({ hours: { ...hours, ...p } });
  const setDay = (d: DayKey, p: Partial<(typeof hours.days)[DayKey]>) =>
    setHours({ days: { ...hours.days, [d]: { ...hours.days[d], ...p } } });

  return (
    <SettingsPage
      title="Handoff & hours"
      description="When a person takes over, what the customer hears, who gets the chat — and when your team is open."
      icon={<span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"><Headphones size={20} /></span>}
    >
      <SettingsCard title="When should a person take over?">
        <Rows>
          <SettingRow title="Customer asks for a human" description="Any language — “agent se baat karao”, “call me”, “real person”.">
            <Switch checked={ho.asksHuman} onChange={(v) => setHo({ asksHuman: v })} label="Asks for a human" />
          </SettingRow>
          <SettingRow title="Customer is upset" description="Anger, threats or a serious complaint.">
            <Switch checked={ho.upset} onChange={(v) => setHo({ upset: v })} label="Upset customer" />
          </SettingRow>
          <SettingRow title="Payment slip received" description="Your team verifies prepaid slips before the order is placed.">
            <Switch checked={ho.paymentSlip} onChange={(v) => setHo({ paymentSlip: v })} label="Payment slip" />
          </SettingRow>
          <SettingRow title="No progress after" description="AI replies in a row where nothing moved forward (0 = off).">
            <input type="number" min={0} max={20} className={cn(inputCls, 'w-20 tabular-nums')} value={ho.noProgressTurns} onChange={(e) => setHo({ noProgressTurns: Number(e.target.value) || 0 })} aria-label="Turns without progress" />
          </SettingRow>
          <SettingRow title="Orders above" description="Big orders get a human check before placing (blank = off).">
            <input type="number" min={0} className={cn(inputCls, 'w-32 tabular-nums')} value={ho.orderValueAbove ?? ''} onChange={(e) => setHo({ orderValueAbove: e.target.value ? Number(e.target.value) : null })} aria-label="Order value threshold" />
          </SettingRow>
        </Rows>
        <div>
          <p className="mb-1.5 text-sm font-semibold text-ink">Always hand off when the message contains</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {ho.keywords.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold text-ink">
                {k}
                <button type="button" onClick={() => setHo({ keywords: ho.keywords.filter((x) => x !== k) })} aria-label={`Remove ${k}`} className="text-muted hover:text-red-600">×</button>
              </span>
            ))}
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && kw.trim()) {
                  e.preventDefault();
                  if (!ho.keywords.includes(kw.trim())) setHo({ keywords: [...ho.keywords, kw.trim()] });
                  setKw('');
                }
              }}
              placeholder="type a word, press Enter"
              className={cn(inputCls, 'w-56')}
              aria-label="Add handoff keyword"
            />
          </div>
        </div>
      </SettingsCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SettingsCard title="What the customer hears">
          <FormField label="During business hours" htmlFor="ho-in">
            <textarea id="ho-in" rows={3} className={inputCls} value={ho.messageInHours} maxLength={500} onChange={(e) => setHo({ messageInHours: e.target.value })} />
          </FormField>
          <FormField label="Outside business hours" htmlFor="ho-off">
            <textarea id="ho-off" rows={3} className={inputCls} value={ho.messageOffHours} maxLength={500} onChange={(e) => setHo({ messageOffHours: e.target.value })} />
          </FormField>
        </SettingsCard>
        <SettingsCard title="Who gets it">
          <FormField label="Assign to" htmlFor="ho-assign">
            <select id="ho-assign" className={inputCls} value={ho.assignTo} onChange={(e) => setHo({ assignTo: e.target.value as 'round_robin' | 'pool' })}>
              <option value="round_robin">Least-busy agent (round-robin)</option>
              <option value="pool">Leave in the shared pool</option>
            </select>
          </FormField>
          <FormField label="Give the chat back to the AI after (minutes)" htmlFor="ho-resume" hint="0 = only when an agent turns it back on.">
            <input id="ho-resume" type="number" min={0} className={inputCls} value={ho.resumeAfterMin} onChange={(e) => setHo({ resumeAfterMin: Number(e.target.value) || 0 })} />
          </FormField>
          <FormField label="Pause the AI after an agent replies (minutes)" htmlFor="ho-pause" hint="Stops the AI talking over your team.">
            <input id="ho-pause" type="number" min={0} className={inputCls} value={ho.humanReplyPauseMin} onChange={(e) => setHo({ humanReplyPauseMin: Number(e.target.value) || 0 })} />
          </FormField>
        </SettingsCard>
      </div>

      <SettingsCard
        title="Business hours"
        description="Used for off-hours behaviour, handoff messages and booking slots. Times are in your workspace timezone (Settings → General)."
        action={<Switch checked={hours.enabled} onChange={(v) => setHours({ enabled: v })} label="Use business hours" />}
      >
        <div className="flex flex-col gap-2">
          {DAYS.map(([d, label]) => (
            <div key={d} className="grid grid-cols-[110px_1fr_1fr_auto] items-center gap-2">
              <span className="text-sm font-semibold text-ink">{label}</span>
              <input type="time" className={inputCls} value={hours.days[d].open} disabled={!hours.days[d].on} onChange={(e) => setDay(d, { open: e.target.value })} aria-label={`${label} opens`} />
              <input type="time" className={inputCls} value={hours.days[d].close} disabled={!hours.days[d].on} onChange={(e) => setDay(d, { close: e.target.value })} aria-label={`${label} closes`} />
              <Switch checked={hours.days[d].on} onChange={(v) => setDay(d, { on: v })} label={`${label} open`} />
            </div>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Outside these hours the AI" htmlFor="hr-mode">
            <select id="hr-mode" className={inputCls} value={hours.offHoursMode} onChange={(e) => setHours({ offHoursMode: e.target.value as typeof hours.offHoursMode })}>
              <option value="full">Answers everything, including orders and bookings</option>
              <option value="no_transactions">Answers questions; orders/bookings wait for the team</option>
              <option value="away_only">Only sends the away message</option>
            </select>
          </FormField>
          <FormField label="Closed dates" htmlFor="hr-hol" hint="YYYY-MM-DD, comma separated.">
            <input id="hr-hol" className={inputCls} value={hours.holidays.join(', ')} onChange={(e) => setHours({ holidays: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </FormField>
        </div>
        <FormField label="Away message" htmlFor="hr-away">
          <textarea id="hr-away" rows={2} className={inputCls} value={hours.awayMessage} maxLength={500} onChange={(e) => setHours({ awayMessage: e.target.value })} />
        </FormField>
      </SettingsCard>

      <SaveBar dirty={f.dirty} saving={f.saving} onDiscard={f.discard} onSave={() => f.save(['handoff', 'hours'])} />
    </SettingsPage>
  );
}

// ── Playground ────────────────────────────────────────────────────────────

const SAMPLE_PROMPTS: Record<Industry, string[]> = {
  ecommerce: ['What do you have under 3000?', 'return policy kya hai?', 'I want to order this'],
  clinic: ['Doctor timings?', 'Book me tomorrow evening', 'Fee kitni hai?'],
  real_estate: ['2 bed apartment for rent?', 'Budget 1.5 crore, Bahria Town', 'Can I visit Saturday?'],
  education: ['Which courses do you offer?', 'Fee structure?', 'Admission process?'],
  restaurant: ['Table for 6 tonight at 8', 'What are today’s deals?', 'Do you deliver?'],
  services: ['Book a haircut tomorrow', 'Price list?', 'Are you open Sunday?'],
  travel: ['Dubai packages for 4 people?', 'Umrah in March', 'Visa help?'],
  generic: ['Opening hours?', 'Where are you located?', 'I need a quote'],
};

export function AiPlaygroundSection() {
  const toast = useToast();
  const [industry, setIndustry] = useState<Industry>('ecommerce');
  const [msgs, setMsgs] = useState<PlaygroundMsg[]>([]);
  const [memory, setMemory] = useState<Record<string, unknown> | null>(null);
  const [trace, setTrace] = useState<AgentTrace | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAgentProfile().then((p) => setIndustry(p.industry)).catch(() => undefined);
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, busy]);

  const send = async (t?: string) => {
    const body = (t ?? text).trim();
    if (!body || busy) return;
    const next: PlaygroundMsg[] = [...msgs, { role: 'customer', text: body }];
    setMsgs(next);
    setText('');
    setBusy(true);
    try {
      const r = await runPlayground(next, memory);
      setMemory(r.memory);
      setTrace({ ...r.trace, handoff: r.handoff });
      if (r.reply) setMsgs((m) => [...m, { role: 'ai', text: r.reply! }]);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'The agent could not reply');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      title="Playground"
      description="Chat with your agent exactly as a customer would. It uses your real profile, skills and knowledge — but nothing is sent, and orders, bookings and tickets are simulated."
      icon={<span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"><Bot size={20} /></span>}
      actions={
        <Button size="sm" variant="secondary" onClick={() => { setMsgs([]); setMemory(null); setTrace(null); }}>
          <RotateCcw size={14} /> New chat
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <SettingsCard flush>
          <div className="flex h-[480px] flex-col">
            <div className="flex-1 space-y-2 overflow-y-auto bg-sunken/60 p-4">
              {msgs.length === 0 && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-muted">Try one:</p>
                  {SAMPLE_PROMPTS[industry].map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-sunken">{s}</button>
                  ))}
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={cn('max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm', m.role === 'customer' ? 'self-start rounded-tl-sm border border-line bg-surface' : 'ml-auto rounded-tr-sm bubble-out')}>
                  {m.role === 'ai' && <span className="mb-0.5 flex items-center gap-1 text-[11px] font-bold text-violet-700 dark:text-violet-300"><Sparkles size={11} /> AI</span>}
                  {m.text}
                </div>
              ))}
              {busy && <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> thinking…</div>}
              <div ref={endRef} />
            </div>
            <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write as a customer…" className={inputCls} aria-label="Customer message" />
              <Button type="submit" disabled={busy || !text.trim()}><Send size={15} /></Button>
            </form>
          </div>
        </SettingsCard>
        <SettingsCard title="Why it said that" description="The last reply's trace.">
          {!trace ? (
            <p className="text-sm text-muted">Send a message to see which tools, sources and model the agent used.</p>
          ) : (
            <TraceView trace={trace} memory={memory} />
          )}
        </SettingsCard>
      </div>
    </SettingsPage>
  );
}

/** Shared trace renderer (Playground + inbox “Why this reply?”). */
export function TraceView({ trace, memory }: { trace: AgentTrace; memory?: Record<string, unknown> | null }) {
  const stage = (memory?.stage as string) ?? trace.memoryStage;
  const items: Array<[string, React.ReactNode]> = [];
  if (trace.handoff) items.push(['Handoff', <span key="h">{trace.handoff.reason} <Badge tone="warn">{trace.handoff.category}</Badge></span>]);
  if (trace.tools?.length) {
    items.push([
      'Tools',
      <ul key="t" className="space-y-1">
        {trace.tools.map((t, i) => (
          <li key={i} className="text-xs">
            <code className="rounded bg-sunken px-1.5 py-0.5 font-mono">{t.name}</code>{' '}
            <span className={t.ok ? 'text-muted' : 'text-red-600'}>{t.ok ? `${t.ms} ms` : 'failed'}</span>
            <span className="block truncate text-muted">{t.summary}</span>
          </li>
        ))}
      </ul>,
    ]);
  } else {
    items.push(['Tools', <span key="t0" className="text-muted">none — answered from the conversation</span>]);
  }
  if (trace.sources?.length) {
    items.push([
      'Sources',
      <ul key="s" className="space-y-0.5 text-xs">
        {trace.sources.map((s, i) => (
          <li key={i}>
            {s.title} <span className="text-muted">· {s.sourceType} · {s.score.toFixed(2)}</span>
          </li>
        ))}
      </ul>,
    ]);
  }
  if (trace.systemReply) items.push(['Reply', 'Sent by the system (exact order summary — not model text)']);
  if (trace.orderPlaced) items.push(['Order', trace.orderPlaced]);
  if (stage) items.push(['Memory', <code key="m" className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs">stage: {stage}</code>]);
  if (trace.model) {
    items.push([
      'Model',
      `${trace.model}${trace.tier ? ` · ${trace.tier}` : ''} · ${trace.latencyMs ?? 0} ms · $${((trace.costMicros ?? 0) / 1_000_000).toFixed(4)}${trace.promptVersion ? ` · ${trace.promptVersion}` : ''}`,
    ]);
  }
  return (
    <ol className="flex flex-col gap-3">
      {items.map(([k, v], i) => (
        <li key={k} className="grid grid-cols-[22px_1fr] gap-2.5">
          <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-violet-50 text-[11px] font-extrabold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{i + 1}</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">{k}</p>
            <div className="text-[13px] text-muted">{v}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ── Performance ───────────────────────────────────────────────────────────

export function AiPerformanceSection() {
  const [days, setDays] = useState(30);
  const [p, setP] = useState<AgentPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    getPerformance(days)
      .then(setP)
      .catch(() => setP(null))
      .finally(() => setLoading(false));
  }, [days]);
  const maxReason = useMemo(() => Math.max(1, ...(p?.handoffsByReason.map((h) => h.count) ?? [1])), [p]);

  return (
    <SettingsPage
      title="Performance"
      description="How your AI agent is doing — results, handoffs, quality and cost."
      actions={
        <select className={cn(inputCls, 'w-36')} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      }
    >
      {loading ? (
        <SettingsSkeleton cards={2} />
      ) : !p ? (
        <Callout tone="warn">Couldn’t load performance.</Callout>
      ) : (
        <>
          {p.shadowTurns > 0 && (
            <Callout tone="info">
              The new agent is running in <b>shadow mode</b> on your workspace ({p.shadowTurns} turns compared). Your current AI still replies; the platform switches you over once the new agent proves better.
            </Callout>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Resolved by AI', p.resolvedByAiPct != null ? `${p.resolvedByAiPct}%` : '—', `${p.aiChats} chats`],
              ['Handed to team', String(p.handoffs), 'with a message to the customer'],
              ['Results', `${p.ordersCreated + p.bookingsMade + p.leadsQualified}`, `${p.ordersCreated} orders · ${p.bookingsMade} bookings · ${p.leadsQualified} leads`],
              ['Spend', `$${p.billedUsd.toFixed(2)}`, p.costPerChatUsd != null ? `$${p.costPerChatUsd.toFixed(3)} per chat` : ''],
            ].map(([k, v, s]) => (
              <div key={k} className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-xs font-semibold text-muted">{k}</p>
                <p className="mt-1 text-2xl font-extrabold tabular-nums text-ink">{v}</p>
                <p className="text-xs text-muted">{s}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <SettingsCard title="Why chats were handed over">
              {p.handoffsByReason.length === 0 ? (
                <p className="text-sm text-muted">No handoffs in this period.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {p.handoffsByReason.map((h) => (
                    <li key={h.reason} className="grid grid-cols-[140px_1fr_40px] items-center gap-2 text-sm">
                      <span className="truncate text-ink">{h.reason.replace(/_/g, ' ')}</span>
                      <span className="h-3 overflow-hidden rounded bg-sunken"><span className="block h-full rounded bg-brand-500" style={{ width: `${(h.count / maxReason) * 100}%` }} /></span>
                      <b className="text-right tabular-nums">{h.count}</b>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>
            <SettingsCard title="Questions it couldn’t answer" description="Add these to your Knowledge base.">
              {p.unanswered.length === 0 ? (
                <p className="text-sm text-muted">Nothing missing — nice.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {p.unanswered.map((u) => (
                    <li key={u.question} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-ink">“{u.question}”</span>
                      <Badge tone="warn">{u.count}×</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>
          </div>
          <SettingsCard title="Agent feedback" description="Thumbs from your team on AI replies in the inbox.">
            <p className="text-sm text-ink">
              👍 {p.feedback.up} · 👎 {p.feedback.down}
              {p.feedback.downPct != null && <span className="text-muted"> · {p.feedback.downPct}% negative</span>}
            </p>
          </SettingsCard>
        </>
      )}
    </SettingsPage>
  );
}
