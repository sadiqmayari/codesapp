import { phoneSearchDigits } from './contact-phone';

/**
 * Shared search helpers — the SINGLE source for how free-text list searches are
 * escaped and classified across the app (inbox, calls, orders board, payments,
 * finance, inventory, PR…). See CLAUDE.md "Search & filter conventions".
 */

/** Escape `\ % _` so user input is matched literally inside a SQL LIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** `%<escaped>%` — for raw `LIKE ${likeContains(q)}` parameters. */
export function likeContains(s: string): string {
  return `%${escapeLike(s)}%`;
}

/** `<escaped>%` — prefix match. */
export function likePrefix(s: string): string {
  return `${escapeLike(s)}%`;
}

export type SearchKind = 'order' | 'phone' | 'tracking' | 'text';

export interface ClassifiedSearch {
  kind: SearchKind;
  /** Trimmed raw query. */
  raw: string;
  /** Order number digits without '#', when it looks like an order number. */
  orderNo?: string;
  /** Phone digits for substring matching (trunk 0 stripped), when phone-like. */
  phoneDigits?: string;
  /** Last 10 national digits — the most format-tolerant phone key. */
  phoneTail?: string;
}

/**
 * Classify a free-text query.
 *  - `#1001` / `1001` (3–7 digits)        → order
 *  - 9+ digits made of phone chars          → phone (0300…, +92300…, 92300…)
 *  - letters+digits, 8+ chars, no spaces    → tracking
 *  - anything else                          → text
 * Callers should still OR the raw text against name fields; the kind only
 * decides which extra normalised matches to add and what to rank first.
 */
export function classifySearch(q: string | null | undefined): ClassifiedSearch {
  const raw = String(q ?? '').trim();
  if (!raw) return { kind: 'text', raw };
  if (/^#?\d{3,7}$/.test(raw)) return { kind: 'order', raw, orderNo: raw.replace(/^#/, '') };
  if (/^[+\d\s\-().]+$/.test(raw)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 9) {
      const phoneDigits = phoneSearchDigits(raw);
      return { kind: 'phone', raw, phoneDigits, phoneTail: digits.slice(-10) };
    }
  }
  if (/^[A-Za-z0-9-]{8,}$/.test(raw) && /\d/.test(raw)) return { kind: 'tracking', raw };
  return { kind: 'text', raw };
}

/** Clamp a free-text query to a sane length (never trust the client). */
export function clampQuery(q: string | null | undefined, max = 100): string {
  return String(q ?? '').trim().slice(0, max);
}
