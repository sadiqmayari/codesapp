/**
 * Attribution engine — pure functions (unit-testable, no DB).
 *
 * A touchpoint is one marketing interaction before an order (a Shopify
 * customer-journey visit, a landing-page UTM, a Click-to-WhatsApp ad chat).
 * `classify` turns raw UTM / click-id / referrer evidence into a channel +
 * platform; `credit` splits one order across its touchpoints under each model.
 */

export type Model = 'first' | 'last' | 'lnd' | 'linear' | 'position' | 'decay';
export const MODELS: Model[] = ['first', 'last', 'lnd', 'linear', 'position', 'decay'];
export const WINDOWS = [1, 7, 28] as const;
export const DEFAULT_WINDOW = 28;
const DECAY_HALF_LIFE_DAYS = 7;

export type Channel =
  | 'meta_ads'
  | 'google_ads'
  | 'tiktok_ads'
  | 'snap_ads'
  | 'whatsapp_ctwa'
  | 'influencer'
  | 'email_sms'
  | 'organic_search'
  | 'organic_social'
  | 'referral'
  | 'direct'
  | 'unknown';

export const CHANNEL_LABEL: Record<Channel, string> = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
  snap_ads: 'Snapchat Ads',
  whatsapp_ctwa: 'WhatsApp ads (CTWA)',
  influencer: 'Influencers',
  email_sms: 'Email & SMS',
  organic_search: 'Organic search',
  organic_social: 'Organic social',
  referral: 'Referral',
  direct: 'Direct',
  unknown: 'Unattributed',
};

export const PAID_CHANNELS = new Set<Channel>(['meta_ads', 'google_ads', 'tiktok_ads', 'snap_ads', 'whatsapp_ctwa']);

export interface RawTouch {
  occurredAt: Date;
  source: 'shopify_journey' | 'landing_site' | 'ctwa';
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  landingPage?: string | null;
  referrer?: string | null;
  adRef?: string | null; // CTWA ad id
}

export interface Classified {
  channel: Channel;
  platform: 'meta' | 'google' | 'tiktok' | 'snap' | null;
  clickIdType: string | null;
}

const PAID_MEDIUM = /^(cpc|ppc|paid|paid[_-]?social|paidsocial|cpm|cpa|display|ads?|social[_-]?paid|retargeting)$/i;
const META_SRC = /(^|\b)(facebook|fb|instagram|ig|meta|an|messenger)(\b|$)/i;
const GOOGLE_SRC = /(^|\b)(google|youtube|gdn|adwords|pmax)(\b|$)/i;
const TIKTOK_SRC = /tiktok/i;
const SNAP_SRC = /snap/i;

function clickId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /[?&](fbclid|gclid|gbraid|wbraid|ttclid|ScCid|sccid|msclkid)=/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export function classify(t: RawTouch): Classified {
  if (t.source === 'ctwa') return { channel: 'whatsapp_ctwa', platform: 'meta', clickIdType: 'ctwa' };
  const src = (t.utmSource ?? '').trim();
  const med = (t.utmMedium ?? '').trim();
  const cid = clickId(t.landingPage);
  const paidMedium = PAID_MEDIUM.test(med);
  const hasCampaign = !!t.utmCampaign;

  if (cid === 'gclid' || cid === 'gbraid' || cid === 'wbraid' || (GOOGLE_SRC.test(src) && (paidMedium || hasCampaign))) {
    return { channel: 'google_ads', platform: 'google', clickIdType: cid };
  }
  if (cid === 'ttclid' || (TIKTOK_SRC.test(src) && (paidMedium || hasCampaign))) {
    return { channel: 'tiktok_ads', platform: 'tiktok', clickIdType: cid };
  }
  if (cid === 'sccid' || (SNAP_SRC.test(src) && (paidMedium || hasCampaign))) {
    return { channel: 'snap_ads', platform: 'snap', clickIdType: cid };
  }
  if (META_SRC.test(src) && (paidMedium || hasCampaign)) {
    return { channel: 'meta_ads', platform: 'meta', clickIdType: cid };
  }
  if (/influenc|creator|collab|^pr$|affiliate/i.test(`${src} ${med}`)) {
    return { channel: 'influencer', platform: null, clickIdType: cid };
  }
  if (/email|newsletter|klaviyo|sms|whatsapp|broadcast/i.test(`${src} ${med}`)) {
    return { channel: 'email_sms', platform: null, clickIdType: cid };
  }
  const ref = `${t.referrer ?? ''} ${src}`.toLowerCase();
  if (cid === 'fbclid' || /facebook|instagram|fb\.|t\.co|twitter|tiktok|snapchat|pinterest|linkedin|youtube/.test(ref)) {
    // fbclid is appended to organic Facebook/Instagram link clicks too.
    return { channel: 'organic_social', platform: null, clickIdType: cid };
  }
  if (/google|bing|yahoo|duckduckgo|yandex|baidu/.test(ref)) {
    return { channel: 'organic_search', platform: null, clickIdType: cid };
  }
  if (t.referrer && !/^\s*$/.test(t.referrer)) return { channel: 'referral', platform: null, clickIdType: cid };
  if (src) return { channel: 'referral', platform: null, clickIdType: cid };
  return { channel: 'direct', platform: null, clickIdType: cid };
}

export interface Touch extends Classified {
  occurredAt: Date;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
}

export interface Credit {
  channel: Channel;
  platform: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  credit: number;
}

function key(t: Omit<Credit, 'credit'>) {
  return `${t.channel}|${t.platform ?? ''}|${t.campaignId ?? ''}|${t.adsetId ?? ''}|${t.adId ?? ''}`;
}

/**
 * Split one order across `touches` (oldest → newest) under `model`, keeping
 * only touches inside the lookback `windowDays` before `orderAt`. Credits sum
 * to exactly 1. No touches → a single `unknown` (or `direct`) credit.
 */
export function credit(touches: Touch[], orderAt: Date, model: Model, windowDays: number): Credit[] {
  const from = orderAt.getTime() - windowDays * 86_400_000;
  const inWin = touches
    .filter((t) => t.occurredAt.getTime() <= orderAt.getTime() + 60_000 && t.occurredAt.getTime() >= from)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (!inWin.length) {
    return [{ channel: 'unknown', platform: null, campaignId: null, adsetId: null, adId: null, credit: 1 }];
  }
  const w = new Array<number>(inWin.length).fill(0);
  const k = inWin.length;
  switch (model) {
    case 'first':
      w[0] = 1;
      break;
    case 'last':
      w[k - 1] = 1;
      break;
    case 'lnd': {
      let idx = k - 1;
      for (let i = k - 1; i >= 0; i--) {
        if (inWin[i].channel !== 'direct') {
          idx = i;
          break;
        }
      }
      w[idx] = 1;
      break;
    }
    case 'linear':
      w.fill(1 / k);
      break;
    case 'position':
      if (k === 1) w[0] = 1;
      else if (k === 2) w[0] = w[1] = 0.5;
      else {
        w[0] = 0.4;
        w[k - 1] = 0.4;
        for (let i = 1; i < k - 1; i++) w[i] = 0.2 / (k - 2);
      }
      break;
    case 'decay': {
      const raw = inWin.map((t) =>
        Math.pow(2, -((orderAt.getTime() - t.occurredAt.getTime()) / 86_400_000) / DECAY_HALF_LIFE_DAYS),
      );
      const s = raw.reduce((a, b) => a + b, 0) || 1;
      raw.forEach((r, i) => (w[i] = r / s));
      break;
    }
  }
  const merged = new Map<string, Credit>();
  inWin.forEach((t, i) => {
    if (w[i] <= 0) return;
    const base = { channel: t.channel, platform: t.platform, campaignId: t.campaignId, adsetId: t.adsetId, adId: t.adId };
    const kk = key(base);
    const cur = merged.get(kk);
    if (cur) cur.credit += w[i];
    else merged.set(kk, { ...base, credit: w[i] });
  });
  // Round to 4dp and push the residual onto the largest share so the sum is 1.
  const out = [...merged.values()].map((c) => ({ ...c, credit: Math.round(c.credit * 10_000) / 10_000 }));
  const residual = Math.round((1 - out.reduce((a, c) => a + c.credit, 0)) * 10_000) / 10_000;
  if (residual !== 0) out.sort((a, b) => b.credit - a.credit)[0].credit += residual;
  return out;
}
