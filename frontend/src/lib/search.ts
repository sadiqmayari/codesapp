/**
 * Frontend twin of backend `common/utils/search.ts` `classifySearch` — used
 * ONLY to label what a query was recognised as (the SearchInput "Order # /
 * Phone / Tracking" chip). The server does the real matching; keep the two
 * rule sets in sync.
 */
export type SearchKind = 'order' | 'phone' | 'tracking' | 'text';

export function classifySearch(q: string): SearchKind | null {
  const raw = q.trim();
  if (!raw) return null;
  if (/^#?\d{3,7}$/.test(raw)) return 'order';
  if (/^[+\d\s\-().]+$/.test(raw) && raw.replace(/\D/g, '').length >= 9) return 'phone';
  if (/^[A-Za-z0-9-]{8,}$/.test(raw) && /\d/.test(raw)) return 'tracking';
  return 'text';
}

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  order: 'Order #',
  phone: 'Phone',
  tracking: 'Tracking',
  text: '',
};
