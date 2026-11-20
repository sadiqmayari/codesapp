// Commission engine — the pure part (unit-tested in commission-math.spec.ts).
// A plan = what is counted (metric + config.earnOn/basis/source) + how it pays
// (config.calc) + who it applies to (applies_to). CommissionService loads the
// per-user units for a month and calls computePlan().

export const METRICS = [
  'orders',
  'parcels_packed',
  'parcels_booked',
  'parcels_dispatched',
  'returns_received',
] as const;
export type Metric = (typeof METRICS)[number];

/** Attribution kind each ops metric reads from order_attributions. */
export const OPS_KIND: Record<Exclude<Metric, 'orders'>, string> = {
  parcels_packed: 'packed',
  parcels_booked: 'booked',
  parcels_dispatched: 'dispatched',
  returns_received: 'returned_received',
};

export type EarnOn = 'placed' | 'confirmed' | 'delivered';
export type Basis = 'count' | 'value';
export type OrderSource = 'any' | 'inbox' | 'abandoned_cart';
export type CreditTo = 'created' | 'confirmed';

export type Calc =
  | { type: 'per_unit'; rate: number }
  | { type: 'percent'; rate: number }
  | { type: 'slab'; mode: 'whole' | 'marginal'; tiers: { from: number; rate: number }[] }
  | { type: 'target_bonus'; target: number; bonus: number; repeat: boolean }
  | { type: 'pool'; rate: number; splitBy: 'units' | 'hours' | 'equal' };

export interface PlanConfig {
  /** orders only: who gets the credit. */
  creditTo: CreditTo;
  /** orders only: when an order counts. */
  earnOn: EarnOn;
  /** count of units, or their net value (orders only). */
  basis: Basis;
  source: OrderSource;
  /** cancelled / returned orders are taken back (a later month = negative). */
  reverse: boolean;
  /** nothing is paid below this many units (or this much value). */
  min: number;
  /** monthly cap per person, 0 = none. */
  cap: number;
  calc: Calc;
}

export interface AppliesTo {
  roles: string[];
  userIds: number[];
}

const num = (v: unknown, lo: number, hi: number, fb: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};
const pick = <T extends string>(v: unknown, all: readonly T[], fb: T): T =>
  all.includes(v as T) ? (v as T) : fb;

export function resolveCalc(raw: unknown, basis: Basis): Calc {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = pick(c.type, ['per_unit', 'percent', 'slab', 'target_bonus', 'pool'] as const, basis === 'value' ? 'percent' : 'per_unit');
  switch (type) {
    case 'percent':
      return { type, rate: num(c.rate, 0, 100, 0) };
    case 'slab': {
      const tiers = (Array.isArray(c.tiers) ? c.tiers : [])
        .map((t) => {
          const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
          return { from: num(o.from, 0, 1e12, 0), rate: num(o.rate, 0, basis === 'value' ? 100 : 1e9, 0) };
        })
        .sort((a, b) => a.from - b.from)
        .slice(0, 12);
      if (!tiers.length || tiers[0].from !== 0) tiers.unshift({ from: 0, rate: 0 });
      return { type, mode: c.mode === 'marginal' ? 'marginal' : 'whole', tiers };
    }
    case 'target_bonus':
      return { type, target: num(c.target, 1, 1e12, 1), bonus: num(c.bonus, 0, 1e9, 0), repeat: c.repeat === true };
    case 'pool':
      return { type, rate: num(c.rate, 0, 1e9, 0), splitBy: pick(c.splitBy, ['units', 'hours', 'equal'] as const, 'units') };
    default:
      return { type: 'per_unit', rate: num(c.rate, 0, 1e9, 0) };
  }
}

export function resolvePlanConfig(metric: Metric, raw: unknown): PlanConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const isOrders = metric === 'orders';
  const basis: Basis = isOrders ? pick(c.basis, ['count', 'value'] as const, 'count') : 'count';
  return {
    creditTo: isOrders ? pick(c.creditTo, ['created', 'confirmed'] as const, 'created') : 'created',
    earnOn: isOrders ? pick(c.earnOn, ['placed', 'confirmed', 'delivered'] as const, 'delivered') : 'placed',
    basis,
    source: isOrders ? pick(c.source, ['any', 'inbox', 'abandoned_cart'] as const, 'any') : 'any',
    reverse: isOrders ? c.reverse !== false : false,
    min: num(c.min, 0, 1e12, 0),
    cap: num(c.cap, 0, 1e12, 0),
    calc: resolveCalc(c.calc, basis),
  };
}

export function resolveAppliesTo(raw: unknown): AppliesTo {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const roles = Array.isArray(a.roles) ? a.roles.map(String).filter(Boolean).slice(0, 20) : [];
  const userIds = Array.isArray(a.userIds)
    ? a.userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)
    : [];
  return { roles, userIds };
}

export const appliesToUser = (a: AppliesTo, u: { id: number; role: string }) =>
  (a.roles.length === 0 && a.userIds.length === 0) || a.roles.includes(u.role) || a.userIds.includes(u.id);

export interface UserUnits {
  /** earned this month minus reversed (can be negative when only reversals). */
  count: number;
  value: number;
  /** for the pool split. */
  minutesWorked: number;
}

export interface PlanResult {
  userId: number;
  /** the figure the calc ran on (count or value). */
  units: number;
  amount: number;
  detail: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Amount for one person from their basis figure. */
export function calcAmount(calc: Calc, basis: Basis, x: number): { amount: number; detail: string } {
  const unitWord = basis === 'value' ? '' : ' units';
  switch (calc.type) {
    case 'per_unit':
      return { amount: x * calc.rate, detail: `${fmt(x)}${unitWord} × ${fmt(calc.rate)}` };
    case 'percent':
      return { amount: (x * calc.rate) / 100, detail: `${calc.rate}% of ${fmt(x)}` };
    case 'slab': {
      const tiers = calc.tiers;
      const rateOf = (rate: number, amt: number) => (basis === 'value' ? (amt * rate) / 100 : amt * rate);
      if (x <= 0) {
        // reversals only: take back at the base tier rate
        return { amount: rateOf(tiers[0].rate, x), detail: `${fmt(x)}${unitWord} reversed` };
      }
      if (calc.mode === 'whole') {
        let t = tiers[0];
        for (const tier of tiers) if (x >= tier.from) t = tier;
        return {
          amount: rateOf(t.rate, x),
          detail: `${fmt(x)}${unitWord} × ${basis === 'value' ? `${t.rate}%` : fmt(t.rate)} (tier from ${fmt(t.from)})`,
        };
      }
      let amount = 0;
      for (let i = 0; i < tiers.length; i++) {
        const lo = tiers[i].from;
        const hi = i + 1 < tiers.length ? tiers[i + 1].from : Infinity;
        if (x <= lo) break;
        amount += rateOf(tiers[i].rate, Math.min(x, hi) - lo);
      }
      return { amount, detail: `${fmt(x)}${unitWord} across ${tiers.length} tiers` };
    }
    case 'target_bonus': {
      const times = x >= calc.target ? (calc.repeat ? Math.floor(x / calc.target) : 1) : 0;
      return { amount: times * calc.bonus, detail: `${fmt(x)} of ${fmt(calc.target)} target${times > 1 ? ` × ${times}` : ''}` };
    }
    case 'pool':
      return { amount: 0, detail: '' }; // handled across users in computePlan
  }
}

/** Compute one plan for every eligible user. */
export function computePlan(config: PlanConfig, users: Map<number, UserUnits>): PlanResult[] {
  const basisOf = (u: UserUnits) => (config.basis === 'value' ? u.value : u.count);
  const out: PlanResult[] = [];

  if (config.calc.type === 'pool') {
    const pool = config.calc;
    let totalUnits = 0;
    for (const u of users.values()) totalUnits += Math.max(0, basisOf(u));
    const potRaw = basisOf({ count: totalUnits, value: totalUnits, minutesWorked: 0 });
    const pot = (config.basis === 'value' ? (potRaw * pool.rate) / 100 : potRaw * pool.rate);
    const weights = new Map<number, number>();
    for (const [id, u] of users) {
      weights.set(id, pool.splitBy === 'hours' ? u.minutesWorked : pool.splitBy === 'equal' ? 1 : Math.max(0, basisOf(u)));
    }
    const wsum = Array.from(weights.values()).reduce((s, w) => s + w, 0);
    for (const [id, u] of users) {
      const share = wsum > 0 ? (weights.get(id) ?? 0) / wsum : 0;
      let amount = pot * share;
      if (config.cap > 0) amount = Math.min(amount, config.cap);
      out.push({
        userId: id,
        units: basisOf(u),
        amount: r2(amount),
        detail: `${Math.round(share * 1000) / 10}% of team pool ${fmt(r2(pot))} (${fmt(totalUnits)} total)`,
      });
    }
    return out;
  }

  for (const [id, u] of users) {
    const x = basisOf(u);
    if (x > 0 && x < config.min) {
      out.push({ userId: id, units: x, amount: 0, detail: `below minimum ${fmt(config.min)}` });
      continue;
    }
    const { amount, detail } = calcAmount(config.calc, config.basis, x);
    let a = amount;
    if (config.cap > 0) a = Math.min(a, config.cap);
    out.push({ userId: id, units: x, amount: r2(a), detail: a !== amount ? `${detail} (capped)` : detail });
  }
  return out;
}
