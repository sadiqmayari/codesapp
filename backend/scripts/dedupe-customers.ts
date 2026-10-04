/**
 * dedupe-customers.ts
 *
 * One-shot CLI to fix the "customers doubling" bug. Historically the registry
 * keyed each row on (origin_company_id, phone) using the RAW phone string, and
 * the two capture paths saw the same person in different formats (contact
 * wa_id "923…" vs Shopify "+923…" / local "0300…"), so one person could hold
 * TWO customer rows. CustomerRegistryService now folds every write through a
 * canonical +E.164 key; this script retro-fits existing rows:
 *
 *   For each (origin_company_id, canonicalPhone) group:
 *     - pick a survivor (most orders, then highest LTV, then already-canonical,
 *       then lowest id),
 *     - merge identity + extents from the others (fill nulls, min first_seen,
 *       max last_seen / last_order),
 *     - delete the other rows,
 *     - rewrite the survivor's phone to the canonical form.
 *   A lone row whose phone is not canonical is simply rewritten.
 *
 * Metrics are NOT recomputed here — the survivor keeps the richest snapshot in
 * the group (the order-sync row). The live snapshotOrder()/backfill recompute
 * them accurately on the canonical key afterwards.
 *
 * USAGE:
 *   cd backend && npx ts-node scripts/dedupe-customers.ts            # dry-run
 *   cd backend && npx ts-node scripts/dedupe-customers.ts --apply
 *   cd backend && npx ts-node scripts/dedupe-customers.ts --company=3 --apply
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { normalizePhone } from '../src/common/utils/phone';

const APPLY = process.argv.includes('--apply');
const COMPANY_ARG = process.argv.find((a) => a.startsWith('--company='));
const COMPANY_ID = COMPANY_ARG ? Number(COMPANY_ARG.split('=')[1]) : null;

const canon = (raw: string | null | undefined): string => {
  const t = (raw ?? '').trim();
  if (!t) return '';
  return normalizePhone(t) || t;
};

type Row = {
  id: number;
  origin_company_id: number;
  phone: string;
  name: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  orders_count: number;
  total_order_value: Prisma.Decimal;
  avg_order_value: Prisma.Decimal;
  last_order_at: Date | null;
  last_order_name: string | null;
  currency: string | null;
  first_seen_at: Date | null;
  last_seen_at: Date | null;
};

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(
      `[dedupe-customers] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${
        COMPANY_ID ? `  company=${COMPANY_ID}` : ''
      }`,
    );

    const rows = (await prisma.customer.findMany({
      where: COMPANY_ID !== null ? { origin_company_id: COMPANY_ID } : {},
      orderBy: { id: 'asc' },
    })) as unknown as Row[];

    // Group by company + canonical phone.
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.origin_company_id}|${canon(r.phone)}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }

    let merged = 0;
    let deleted = 0;
    let rewritten = 0;

    for (const [key, g] of groups) {
      const canonical = key.split('|')[1];
      if (!canonical) continue;

      if (g.length === 1) {
        // Lone row — rewrite only if its stored phone isn't canonical yet.
        const only = g[0];
        if (only.phone !== canonical) {
          rewritten++;
          if (APPLY) {
            await prisma.customer.update({
              where: { id: only.id },
              data: { phone: canonical },
            });
          }
        }
        continue;
      }

      // Survivor: most orders → highest LTV → already-canonical → lowest id.
      const sorted = [...g].sort((a, b) => {
        if (b.orders_count !== a.orders_count)
          return b.orders_count - a.orders_count;
        const lv = Number(b.total_order_value) - Number(a.total_order_value);
        if (lv !== 0) return lv;
        const ac = a.phone === canonical ? 0 : 1;
        const bc = b.phone === canonical ? 0 : 1;
        if (ac !== bc) return ac - bc;
        return a.id - b.id;
      });
      const survivor = sorted[0];
      const losers = sorted.slice(1);

      // Merge: fill survivor nulls from losers; widen date extents.
      const pick = <K extends keyof Row>(field: K): Row[K] => {
        if (survivor[field] != null && survivor[field] !== '')
          return survivor[field];
        for (const l of losers)
          if (l[field] != null && l[field] !== '') return l[field];
        return survivor[field];
      };
      const minDate = (a: Date | null, b: Date | null) =>
        !a ? b : !b ? a : a < b ? a : b;
      const maxDate = (a: Date | null, b: Date | null) =>
        !a ? b : !b ? a : a > b ? a : b;

      let firstSeen = survivor.first_seen_at;
      let lastSeen = survivor.last_seen_at;
      for (const l of losers) {
        firstSeen = minDate(firstSeen, l.first_seen_at);
        lastSeen = maxDate(lastSeen, l.last_seen_at);
      }

      const data = {
        phone: canonical,
        name: pick('name'),
        email: pick('email'),
        address: pick('address'),
        city: pick('city'),
        first_seen_at: firstSeen,
        last_seen_at: lastSeen,
      };

      merged++;
      deleted += losers.length;
      console.log(
        `  company ${survivor.origin_company_id}: ${g
          .map((r) => r.phone)
          .join(' + ')}  ->  ${canonical}  (keep #${survivor.id}, drop ${losers
          .map((l) => `#${l.id}`)
          .join(', ')})`,
      );

      if (APPLY) {
        await prisma.$transaction([
          prisma.customer.deleteMany({
            where: { id: { in: losers.map((l) => l.id) } },
          }),
          prisma.customer.update({ where: { id: survivor.id }, data }),
        ]);
      }
    }

    console.log(
      `[dedupe-customers] groups merged: ${merged}, rows deleted: ${deleted}, lone rows re-canonicalized: ${rewritten}`,
    );
    console.log(
      `[dedupe-customers] done${APPLY ? '' : ' (dry-run — no writes)'}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
