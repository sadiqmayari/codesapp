import {
  BookableService,
  Industry,
  INDUSTRIES,
  LeadField,
  PACKS,
  packFor,
  SKILL_KEYS,
  SkillKey,
} from './packs';

/**
 * Agent Profile — the per-tenant configuration of the AI agent. `resolveProfile`
 * is the SINGLE resolver: it merges the stored row (any of whose JSON blobs may
 * be partial, legacy or null) over the industry pack defaults and clamps every
 * value. Pure + unit-tested (profile.spec.ts). Nothing else may read the
 * ai_agent_profiles JSON columns raw.
 */

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface DayHours {
  on: boolean;
  open: string; // HH:MM
  close: string; // HH:MM
}

export type OffHoursMode = 'full' | 'no_transactions' | 'away_only';

export interface HoursConfig {
  enabled: boolean;
  days: Record<DayKey, DayHours>;
  /** YYYY-MM-DD dates the business is closed. */
  holidays: string[];
  offHoursMode: OffHoursMode;
  awayMessage: string;
}

export interface HandoffConfig {
  asksHuman: boolean;
  upset: boolean;
  /** Hand off after N AI replies without progress (0 = off). */
  noProgressTurns: number;
  /** Hand off orders above this value (null = off). */
  orderValueAbove: number | null;
  paymentSlip: boolean;
  keywords: string[];
  messageInHours: string;
  messageOffHours: string;
  assignTo: 'round_robin' | 'pool';
  /** Give the chat back to the AI after N minutes without a human reply (0 = never). */
  resumeAfterMin: number;
  /** Pause the AI for N minutes after a human agent replies. */
  humanReplyPauseMin: number;
}

export interface OrdersSkill {
  enabled: boolean;
  /** Payment methods the AI may offer. */
  allowPrepaid: boolean;
  allowCod: boolean;
}

export interface BookingsSkill {
  enabled: boolean;
  services: BookableService[];
  /** Earliest booking = now + this many minutes. */
  leadTimeMin: number;
  /** How far ahead customers may book. */
  maxDaysAhead: number;
}

export interface LeadsSkill {
  enabled: boolean;
  fields: LeadField[];
  hotRule: string;
  /** Tag added to a qualified contact. */
  tag: string;
}

export interface SkillsConfig {
  knowledge: { enabled: boolean };
  orders: OrdersSkill;
  order_status: { enabled: boolean };
  payments: { enabled: boolean };
  bookings: BookingsSkill;
  leads: LeadsSkill;
  handoff: { enabled: boolean };
}

export type AiEngine = 'v1' | 'shadow' | 'v2';

export interface ResolvedProfile {
  industry: Industry;
  agentName: string;
  agentRole: string;
  goals: string;
  doRules: string;
  dontRules: string;
  tone: string;
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  languages: string[];
  mirrorLanguage: boolean;
  /** ISO-639-1 hint for Whisper ('' = auto-detect). */
  voiceLanguage: string;
  paymentMethods: string[];
  skills: SkillsConfig;
  handoff: HandoffConfig;
  hours: HoursConfig;
  engine: AiEngine;
  domainRules: string;
  sensitiveTopics: string[];
}

/** Raw row shape (Prisma AiAgentProfile minus ids/timestamps), all optional. */
export interface ProfileRow {
  industry?: string | null;
  agent_name?: string | null;
  agent_role?: string | null;
  goals?: string | null;
  do_rules?: string | null;
  dont_rules?: string | null;
  tone?: string | null;
  country_code?: string | null;
  currency_code?: string | null;
  currency_symbol?: string | null;
  languages?: unknown;
  mirror_language?: boolean | null;
  voice_language?: string | null;
  payment_methods?: unknown;
  skills?: unknown;
  handoff?: unknown;
  hours?: unknown;
  engine?: string | null;
}

/** Country → currency defaults (extend as tenants arrive). */
const CURRENCY_BY_COUNTRY: Record<string, { code: string; symbol: string }> = {
  PK: { code: 'PKR', symbol: 'Rs' },
  IN: { code: 'INR', symbol: '₹' },
  AE: { code: 'AED', symbol: 'AED' },
  SA: { code: 'SAR', symbol: 'SAR' },
  GB: { code: 'GBP', symbol: '£' },
  US: { code: 'USD', symbol: '$' },
  BD: { code: 'BDT', symbol: '৳' },
  QA: { code: 'QAR', symbol: 'QAR' },
  EG: { code: 'EGP', symbol: 'EGP' },
  TR: { code: 'TRY', symbol: '₺' },
};

const LANGS_BY_COUNTRY: Record<string, string[]> = {
  PK: ['English', 'Roman Urdu', 'Urdu'],
  IN: ['English', 'Hindi', 'Hinglish'],
  AE: ['English', 'Arabic'],
  SA: ['Arabic', 'English'],
  BD: ['Bengali', 'English'],
  QA: ['Arabic', 'English'],
  EG: ['Arabic', 'English'],
  TR: ['Turkish', 'English'],
};

const VOICE_BY_COUNTRY: Record<string, string> = {
  PK: 'ur',
  IN: 'hi',
  AE: 'ar',
  SA: 'ar',
  BD: 'bn',
  QA: 'ar',
  EG: 'ar',
  TR: 'tr',
};

export function currencyFor(country: string): { code: string; symbol: string } {
  return CURRENCY_BY_COUNTRY[country] ?? { code: 'USD', symbol: '$' };
}
export function languagesFor(country: string): string[] {
  return LANGS_BY_COUNTRY[country] ?? ['English'];
}
export function voiceLanguageFor(country: string): string {
  return VOICE_BY_COUNTRY[country] ?? '';
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, max = 4000): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const bool = (v: unknown, dflt: boolean): boolean =>
  typeof v === 'boolean' ? v : dflt;
const int = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};
const strList = (v: unknown, maxItems = 30, maxLen = 80): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, maxLen))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
const hhmm = (v: unknown, dflt: string): string => {
  const s = str(v, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : dflt;
};

export const DEFAULT_HANDOFF: HandoffConfig = {
  asksHuman: true,
  upset: true,
  noProgressTurns: 4,
  orderValueAbove: null,
  paymentSlip: true,
  keywords: [],
  messageInHours:
    'I am connecting you with our team now — someone will reply here shortly.',
  messageOffHours:
    'Our team is offline right now and will reply as soon as we open. I can keep helping with your questions meanwhile.',
  assignTo: 'round_robin',
  resumeAfterMin: 120,
  humanReplyPauseMin: 15,
};

export function defaultHours(): HoursConfig {
  const days = {} as Record<DayKey, DayHours>;
  for (const d of DAY_KEYS) {
    days[d] = { on: d !== 'sun', open: '10:00', close: '19:00' };
  }
  return {
    enabled: false,
    days,
    holidays: [],
    offHoursMode: 'full',
    awayMessage:
      'Thanks for your message! We are closed right now and will reply when we open.',
  };
}

function resolveHandoff(raw: unknown): HandoffConfig {
  const o = obj(raw);
  const value = o.orderValueAbove;
  return {
    asksHuman: bool(o.asksHuman, DEFAULT_HANDOFF.asksHuman),
    upset: bool(o.upset, DEFAULT_HANDOFF.upset),
    noProgressTurns: int(o.noProgressTurns, DEFAULT_HANDOFF.noProgressTurns, 0, 20),
    orderValueAbove:
      value === null || value === undefined || value === ''
        ? null
        : Number.isFinite(Number(value)) && Number(value) > 0
          ? Number(value)
          : null,
    paymentSlip: bool(o.paymentSlip, DEFAULT_HANDOFF.paymentSlip),
    keywords: strList(o.keywords, 40, 60),
    messageInHours: str(o.messageInHours, 500) || DEFAULT_HANDOFF.messageInHours,
    messageOffHours: str(o.messageOffHours, 500) || DEFAULT_HANDOFF.messageOffHours,
    assignTo: o.assignTo === 'pool' ? 'pool' : 'round_robin',
    resumeAfterMin: int(o.resumeAfterMin, DEFAULT_HANDOFF.resumeAfterMin, 0, 10080),
    humanReplyPauseMin: int(o.humanReplyPauseMin, DEFAULT_HANDOFF.humanReplyPauseMin, 0, 1440),
  };
}

function resolveHours(raw: unknown): HoursConfig {
  const o = obj(raw);
  const base = defaultHours();
  const daysIn = obj(o.days);
  const days = {} as Record<DayKey, DayHours>;
  for (const d of DAY_KEYS) {
    const di = obj(daysIn[d]);
    days[d] = {
      on: bool(di.on, base.days[d].on),
      open: hhmm(di.open, base.days[d].open),
      close: hhmm(di.close, base.days[d].close),
    };
  }
  const mode = o.offHoursMode;
  return {
    enabled: bool(o.enabled, false),
    days,
    holidays: strList(o.holidays, 60, 10).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)),
    offHoursMode:
      mode === 'no_transactions' || mode === 'away_only' ? mode : 'full',
    awayMessage: str(o.awayMessage, 500) || base.awayMessage,
  };
}

function resolveServices(raw: unknown, dflt: BookableService[]): BookableService[] {
  if (!Array.isArray(raw)) return dflt.map((s) => ({ ...s }));
  return raw
    .map((x) => {
      const o = obj(x);
      const name = str(o.name, 120);
      if (!name) return null;
      const svc: BookableService = {
        name,
        durationMin: int(o.durationMin, 30, 5, 600),
        capacity: int(o.capacity, 1, 1, 500),
      };
      const res = str(o.resource, 120);
      if (res) svc.resource = res;
      return svc;
    })
    .filter((s): s is BookableService => !!s)
    .slice(0, 30);
}

function resolveLeadFields(raw: unknown, dflt: LeadField[]): LeadField[] {
  if (!Array.isArray(raw)) return dflt.map((f) => ({ ...f }));
  const seen = new Set<string>();
  return raw
    .map((x) => {
      const o = obj(x);
      const label = str(o.label, 80);
      const key =
        str(o.key, 40)
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_') ||
        label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
      if (!label || !key || seen.has(key)) return null;
      seen.add(key);
      return { key, label, required: bool(o.required, false) };
    })
    .filter((f): f is LeadField => !!f)
    .slice(0, 20);
}

function resolveSkills(raw: unknown, industry: Industry): SkillsConfig {
  const pack = PACKS[industry];
  const o = obj(raw);
  const on = (k: SkillKey): boolean => {
    const s = obj(o[k]);
    return bool(s.enabled, pack.skills.includes(k));
  };
  const orders = obj(o.orders);
  const bookings = obj(o.bookings);
  const leads = obj(o.leads);
  return {
    knowledge: { enabled: on('knowledge') },
    orders: {
      enabled: on('orders'),
      allowCod: bool(orders.allowCod, true),
      allowPrepaid: bool(orders.allowPrepaid, true),
    },
    order_status: { enabled: on('order_status') },
    payments: { enabled: on('payments') },
    bookings: {
      enabled: on('bookings'),
      services: resolveServices(bookings.services, pack.services),
      leadTimeMin: int(bookings.leadTimeMin, 60, 0, 10080),
      maxDaysAhead: int(bookings.maxDaysAhead, 30, 1, 365),
    },
    leads: {
      enabled: on('leads'),
      fields: resolveLeadFields(leads.fields, pack.leadFields),
      hotRule: str(leads.hotRule, 300) || pack.hotLeadRule,
      tag: str(leads.tag, 40) || 'AI lead',
    },
    handoff: { enabled: on('handoff') },
  };
}

/**
 * Merge a stored profile row over its industry pack + country defaults.
 * `fallback` carries legacy company values used when the row is empty
 * (brand tone, default country).
 */
export function resolveProfile(
  row: ProfileRow | null | undefined,
  fallback: { tone?: string | null; countryCode?: string | null } = {},
): ResolvedProfile {
  const r = row ?? {};
  const industry: Industry = INDUSTRIES.includes(r.industry as Industry)
    ? (r.industry as Industry)
    : 'ecommerce';
  const pack = packFor(industry);
  const country = (str(r.country_code, 2) || str(fallback.countryCode, 2) || 'PK').toUpperCase();
  const cur = currencyFor(country);
  const langs = strList(r.languages, 10, 40);
  const pm = strList(r.payment_methods, 10, 30);
  const engine: AiEngine =
    r.engine === 'v1' || r.engine === 'shadow' ? r.engine : 'v2';

  return {
    industry,
    agentName: str(r.agent_name, 80) || pack.agentName,
    agentRole: str(r.agent_role, 120) || pack.agentRole,
    goals: str(r.goals) || pack.goals,
    doRules: str(r.do_rules) || pack.doRules,
    dontRules: str(r.dont_rules) || pack.dontRules,
    tone: str(r.tone, 2000) || str(fallback.tone, 2000),
    countryCode: country,
    currencyCode: (str(r.currency_code, 3) || cur.code).toUpperCase(),
    currencySymbol: str(r.currency_symbol, 8) || cur.symbol,
    languages: langs.length ? langs : languagesFor(country),
    mirrorLanguage: r.mirror_language !== false,
    voiceLanguage:
      r.voice_language === null || r.voice_language === undefined
        ? voiceLanguageFor(country)
        : str(r.voice_language, 8),
    paymentMethods: pm.length ? pm : ['cod', 'prepaid'],
    skills: resolveSkills(r.skills, industry),
    handoff: resolveHandoff(r.handoff),
    hours: resolveHours(r.hours),
    engine,
    domainRules: pack.domainRules,
    sensitiveTopics: pack.sensitiveTopics,
  };
}

/** Per-store overrides layered on top of the company profile. */
export interface StoreOverride {
  brandName?: string | null;
  tone?: string | null;
  currencyCode?: string | null;
  currencySymbol?: string | null;
  countryCode?: string | null;
}

export function withStore(
  p: ResolvedProfile,
  s: StoreOverride | null | undefined,
): ResolvedProfile {
  if (!s) return p;
  const country = (s.countryCode || '').toUpperCase().slice(0, 2);
  return {
    ...p,
    tone: s.tone?.trim() || p.tone,
    countryCode: country || p.countryCode,
    currencyCode: s.currencyCode?.trim().toUpperCase() || p.currencyCode,
    currencySymbol: s.currencySymbol?.trim() || p.currencySymbol,
  };
}

/** Is `at` inside the configured business hours? (disabled = always open) */
export function isOpenAt(
  hours: HoursConfig,
  at: Date,
  timeZone: string | null | undefined,
): boolean {
  if (!hours.enabled) return true;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  if (hours.holidays.includes(ymd)) return false;
  const key = String(parts.weekday).toLowerCase().slice(0, 3) as DayKey;
  const day = hours.days[key];
  if (!day || !day.on) return false;
  const hh = parts.hour === '24' ? '00' : parts.hour;
  const now = `${hh}:${parts.minute}`;
  // Overnight windows (close < open) wrap past midnight.
  if (day.close > day.open) return now >= day.open && now < day.close;
  return now >= day.open || now < day.close;
}

export { SKILL_KEYS };
