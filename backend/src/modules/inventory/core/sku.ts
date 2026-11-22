/**
 * Inventory v2 — linking store listings to master items. Pure + unit-tested.
 *
 * Order of evidence (strongest first): exact SKU → exact barcode → exact
 * product title + variant title. A listing never links to another listing of
 * the SAME store (two variants of one store are always two items).
 */

export type LinkSource = 'sku' | 'barcode' | 'title' | 'manual' | 'created';

export function normSku(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t.length ? t : null;
}

export function normBarcode(v: string | null | undefined): string | null {
  const t = (v ?? '').replace(/[\s-]/g, '');
  return t.length >= 6 ? t : null;
}

/** "Lawn Kurta — Embroidered" + "Medium" → "lawn kurta embroidered|medium". */
export function titleKey(title: string | null | undefined, variant: string | null | undefined): string | null {
  const clean = (s: string | null | undefined) =>
    (s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
      .trim();
  const t = clean(title);
  if (!t) return null;
  const v = clean(variant);
  // Shopify's placeholder variant title for single-variant products.
  const vv = v === 'default title' ? '' : v;
  return `${t}|${vv}`;
}

export interface ListingForLink {
  id: number;
  storeId: number;
  sku: string | null;
  barcode: string | null;
  title: string;
  variantTitle: string | null;
  qty: number;
}

export interface LinkGroup {
  listingIds: number[];
  source: LinkSource;
  /** Quantities disagreed across stores (pool took the max). */
  conflict: boolean;
  qty: number;
}

/**
 * Group listings into master items. Union-find over the three keys, refusing
 * any merge that would put two listings of the same store into one group.
 */
export function groupListings(listings: ListingForLink[]): LinkGroup[] {
  const parent = new Map<number, number>();
  const stores = new Map<number, Set<number>>(); // root → store ids in group
  const source = new Map<number, LinkSource>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const l of listings) {
    parent.set(l.id, l.id);
    stores.set(l.id, new Set([l.storeId]));
  }
  const union = (a: number, b: number, why: LinkSource) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const sa = stores.get(ra)!;
    const sb = stores.get(rb)!;
    for (const s of sb) if (sa.has(s)) return; // same-store clash → keep apart
    parent.set(rb, ra);
    sb.forEach((s) => sa.add(s));
    stores.delete(rb);
    const rank: LinkSource[] = ['sku', 'barcode', 'title'];
    const cur = source.get(ra) ?? source.get(rb);
    // a group's source = the WEAKEST evidence used to build it
    const weakest = [cur, why].filter(Boolean).sort((x, y) => rank.indexOf(y!) - rank.indexOf(x!))[0];
    source.set(ra, weakest ?? why);
  };
  const byKey = (keyOf: (l: ListingForLink) => string | null, why: LinkSource) => {
    const first = new Map<string, number>();
    // stable order: by id so re-runs link the same way
    for (const l of [...listings].sort((a, b) => a.id - b.id)) {
      const k = keyOf(l);
      if (!k) continue;
      const f = first.get(k);
      if (f == null) first.set(k, l.id);
      else union(f, l.id, why);
    }
  };
  byKey((l) => normSku(l.sku), 'sku');
  byKey((l) => normBarcode(l.barcode), 'barcode');
  byKey((l) => titleKey(l.title, l.variantTitle), 'title');

  const groups = new Map<number, ListingForLink[]>();
  for (const l of listings) {
    const r = find(l.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(l);
  }
  return [...groups.entries()]
    .map(([root, ls]) => {
      const qtys = ls.map((l) => l.qty);
      return {
        listingIds: ls.map((l) => l.id).sort((a, b) => a - b),
        source: ls.length > 1 ? source.get(root) ?? 'sku' : ('created' as LinkSource),
        conflict: new Set(qtys).size > 1,
        qty: Math.max(...qtys),
      };
    })
    .sort((a, b) => a.listingIds[0] - b.listingIds[0]);
}
