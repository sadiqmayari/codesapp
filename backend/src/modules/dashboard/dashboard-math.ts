/**
 * Pure helpers for Dashboard v3 (unit-tested in dashboard-math.spec.ts).
 * No Nest, no Prisma — keep it that way so the spec runs under jest.unit.config.js.
 */

/** "+05:00" for a tenant IANA zone at "now" (UTC when unset/invalid). Safe to interpolate. */
export function tenantUtcOffset(tz: string | null, at = new Date()): string {
  if (!tz) return '+00:00';
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .reduce<Record<string, number>>((a, x) => {
        if (x.type !== 'literal') a[x.type] = Number(x.value);
        return a;
      }, {});
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offMin = Math.round((asUtc - at.getTime()) / 60000);
    const abs = Math.abs(offMin);
    const pad = (x: number) => String(x).padStart(2, '0');
    const out = `${offMin >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return /^[+-]\d{2}:\d{2}$/.test(out) ? out : '+00:00';
  } catch {
    return '+00:00';
  }
}

/** Median of a numeric list (null when empty). */
export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

export interface BriefSignals {
  hotspot: { city: string; rtoRate: number; parcels: number; bestCourier: { courier: string; deliveryRate: number } | null } | null;
  storeRtoRate: number | null;
  unconfirmedOld: number;
  target: { target: number | null; net: number | null; projected: number | null; onTrack: boolean | null; neededPerDay: number | null } | null;
  roas: number | null;
  unreadOldestMin: number | null;
  unread: number;
  deliveryRate: number | null;
  deliveryRatePrev: number | null;
}

export interface BriefItem {
  tone: 'bad' | 'warn' | 'good';
  text: string;
  why: string;
  cta: string;
  href: string;
  /** Higher = shown first. */
  weight: number;
}

const COURIER: Record<string, string> = {
  trax: 'Trax', leopards: 'Leopards', postex: 'PostEx', rocket: 'Rocket', mnp: 'M&P', rapidxpk: 'RapidXpk', tcs: 'TCS',
};

const fmt = (v: number) => Math.round(v).toLocaleString('en-US');

/**
 * Deterministic "Today's brief": the three most important things to act on,
 * built from live signals (no AI call, so it is free and never wrong about a
 * number). Each item deep-links to the screen that fixes it.
 */
export function buildBrief(s: BriefSignals): BriefItem[] {
  const out: BriefItem[] = [];

  if (s.unreadOldestMin != null && s.unreadOldestMin >= 30 && s.unread > 0) {
    out.push({
      tone: s.unreadOldestMin >= 120 ? 'bad' : 'warn',
      text: `${s.unread} unread chat${s.unread === 1 ? '' : 's'}; the oldest has waited ${s.unreadOldestMin >= 120 ? `${Math.round(s.unreadOldestMin / 60)} h` : `${s.unreadOldestMin} min`}.`,
      why: 'Customers who wait over 30 minutes confirm far fewer orders.',
      cta: 'Open inbox',
      href: '/inbox?status=unread',
      weight: 60 + Math.min(40, s.unreadOldestMin / 6),
    });
  }

  if (s.hotspot && s.storeRtoRate != null) {
    const best = s.hotspot.bestCourier;
    out.push({
      tone: 'bad',
      text: `${s.hotspot.city} returns ${s.hotspot.rtoRate}% of parcels (store ${s.storeRtoRate}%).`,
      why: best
        ? `${COURIER[best.courier] ?? best.courier} delivers ${best.deliveryRate}% there on ${fmt(s.hotspot.parcels)} settled parcels.`
        : `Based on ${fmt(s.hotspot.parcels)} settled parcels. Confirm these orders by call or ask for an advance.`,
      cta: best ? 'Set city courier' : 'Review city',
      href: '/settings/couriers',
      weight: 50 + (s.hotspot.rtoRate - s.storeRtoRate),
    });
  }

  if (s.unconfirmedOld > 0) {
    out.push({
      tone: s.unconfirmedOld >= 20 ? 'bad' : 'warn',
      text: `${fmt(s.unconfirmedOld)} order${s.unconfirmedOld === 1 ? ' is' : 's are'} over 24 h old and still unconfirmed.`,
      why: 'Old unconfirmed orders are the ones most likely to be cancelled or returned.',
      cta: 'Confirm orders',
      href: '/orders/fulfillment?lane=unfulfilled&conf=unconfirmed',
      weight: 40 + Math.min(40, s.unconfirmedOld),
    });
  }

  const t = s.target;
  if (t && t.target && t.projected != null) {
    if (t.onTrack) {
      out.push({
        tone: 'good',
        text: `On track for the monthly target: heading for ${fmt(t.projected)} of ${fmt(t.target)}.`,
        why: 'Projected from net sales so far this month.',
        cta: 'See forecast',
        href: '/growth/forecast',
        weight: 15,
      });
    } else {
      out.push({
        tone: 'warn',
        text: `Behind the monthly target: heading for ${fmt(t.projected)} of ${fmt(t.target)}.`,
        why: t.neededPerDay != null ? `Need ${fmt(t.neededPerDay)} net per day from here.` : 'Projected from net sales so far this month.',
        cta: 'Plan to catch up',
        href: '/growth/forecast',
        weight: 45,
      });
    }
  }

  if (s.deliveryRate != null && s.deliveryRatePrev != null && s.deliveryRatePrev - s.deliveryRate >= 3) {
    out.push({
      tone: 'bad',
      text: `Delivery rate fell to ${s.deliveryRate}% (was ${s.deliveryRatePrev}%).`,
      why: 'Settled parcels, last 30 days vs the 30 before.',
      cta: 'Courier scorecard',
      href: '/orders/fulfillment?view=performance',
      weight: 35 + (s.deliveryRatePrev - s.deliveryRate),
    });
  }

  if (s.roas != null && s.roas > 0 && s.roas < 1.5) {
    out.push({
      tone: 'warn',
      text: `Ads are returning ${s.roas}× net sales for this period.`,
      why: 'Below 1.5× most stores lose money after product and shipping cost.',
      cta: 'Open Growth',
      href: '/growth/campaigns',
      weight: 30,
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}
