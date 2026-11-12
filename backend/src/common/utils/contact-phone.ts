import { DIAL_CODES } from './phone';

/**
 * Contact phone canonicalization — the SINGLE rule for how a contact's phone is
 * stored and matched.
 *
 * Canonical form = INTERNATIONAL DIGITS ONLY, no '+' (e.g. `923001234567`).
 * That is exactly what WhatsApp delivers as `msg.from`, which is how the vast
 * majority of contacts are created, so canonical rows need no migration. Other
 * entry points (UI form, CSV, Shopify) used to keep a leading '+', producing
 * two contacts for one person — every write path now runs through
 * `canonContactPhone`, and every lookup uses `phoneVariants` so legacy rows
 * stored with '+' still match until they are merged.
 */

/** Digits-only international form, or '' when unusable. */
export function canonContactPhone(raw: string | null | undefined, country = 'PK'): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  const dial = DIAL_CODES[country] ?? '92';
  // National trunk prefix: 03001234567 → 923001234567
  if (digits.startsWith('0')) return dial + digits.slice(1);
  // Bare national mobile without trunk 0 (PK: 10 digits starting with 3)
  if (dial === '92' && digits.length === 10 && digits.startsWith('3')) return '92' + digits;
  return digits;
}

/** True when the canonical phone is a plausible E.164 number (7–15 digits). */
export function isValidContactPhone(canon: string): boolean {
  return /^[1-9]\d{6,14}$/.test(canon);
}

/**
 * Every stored representation the same number may exist under — canonical,
 * '+'-prefixed legacy, and the raw input itself. Use as `phone: { in: … }`.
 */
export function phoneVariants(raw: string | null | undefined, country = 'PK'): string[] {
  const canon = canonContactPhone(raw, country);
  const set = new Set<string>();
  if (canon) {
    set.add(canon);
    set.add('+' + canon);
  }
  if (raw && String(raw).trim()) set.add(String(raw).trim());
  return [...set];
}

/**
 * Digits used for phone SEARCH (substring). A local "0300…" query becomes
 * "300…" so it matches both `92300…` and `+92300…`. Returns '' when the query
 * has fewer than 3 digits (not a phone search).
 */
export function phoneSearchDigits(q: string): string {
  const d = q.replace(/\D/g, '');
  if (d.length < 3) return '';
  return d.startsWith('0') ? d.replace(/^0+/, '') : d;
}

