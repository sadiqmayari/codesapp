// Phone normalization to +E.164. Mirrors frontend/src/lib/phone.ts — customers
// type LOCAL formats (e.g. Pakistani "03171263292") but Shopify needs E.164.
// Used by the AI auto-order worker to normalize the number it extracted from
// the chat before creating the order.

export const DIAL_CODES: Record<string, string> = {
  PK: '92', AF: '93', BD: '880', BT: '975', IN: '91', LK: '94', MV: '960',
  NP: '977', AE: '971', SA: '966', QA: '974', KW: '965', BH: '973', OM: '968',
  JO: '962', LB: '961', IQ: '964', IR: '98', IL: '972', TR: '90', EG: '20',
  CN: '86', HK: '852', TW: '886', JP: '81', KR: '82', SG: '65', MY: '60',
  ID: '62', TH: '66', VN: '84', PH: '63', MM: '95', KH: '855', US: '1',
  CA: '1', MX: '52', GB: '44', IE: '353', FR: '33', DE: '49', ES: '34',
  IT: '39', NL: '31', BE: '32', CH: '41', AT: '43', SE: '46', NO: '47',
  DK: '45', FI: '358', PL: '48', PT: '351', GR: '30', CZ: '420', RO: '40',
  HU: '36', RU: '7', UA: '380', AU: '61', NZ: '64', ZA: '27', NG: '234',
  KE: '254', GH: '233', MA: '212', DZ: '213', TN: '216', BR: '55', AR: '54',
  CL: '56', CO: '57', PE: '51',
};

/** Normalize a raw phone string to `+E.164` using a destination country code. */
export function normalizePhone(raw: string, countryCode = 'PK'): string {
  if (!raw) return '';
  const dial = DIAL_CODES[countryCode] ?? '92';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  if (hasPlus) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+${dial}${digits.slice(1)}`;
  if (digits.startsWith(dial) && digits.length > dial.length + 5)
    return `+${digits}`;
  return `+${dial}${digits}`;
}
