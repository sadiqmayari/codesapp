/**
 * backfill-order-store.ts
 *
 * One-shot CLI (Multi-Store) to stamp `shopify_orders.shopify_store_id` on
 * LEGACY orders that predate multi-store (shopify_store_id IS NULL). Each such
 * order is stamped with its company's PRIMARY store id — legacy single-store
 * orders all belong to the original (now primary) store. This lets the order
 * board / drawer show a store pill and keeps per-store reconcile complete.
 *
 * Idempotent: only touches NULL rows; re-running does nothing once stamped.
 * Companies with no `shopify_stores` row (never migrated) are skipped — their
 * orders stay NULL and use the legacy single-store code path.
 *
 * USAGE:
 *   # Dry-run (DEFAULT — prints counts, makes NO writes):
 *   cd backend && npx ts-node scripts/backfill-order-store.ts
 *
 *   # Apply:
 *   cd backend && npx ts-node scripts/backfill-order-store.ts --apply
 *
 *   # Limit to one company:
 *   cd backend && npx ts-node scripts/backfill-order-store.ts --company=3 --apply
 */

import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const COMPANY_ARG = process.argv.find((a) => a.startsWith('--company='));
const COMPANY_ID = COMPANY_ARG ? Number(COMPANY_ARG.split('=')[1]) : null;

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(
      `[backfill-order-store] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${
        COMPANY_ID ? `  company=${COMPANY_ID}` : ''
      }`,
    );

    // Companies that have a primary store (the stamp target).
    const primaries = await prisma.shopifyStore.findMany({
      where: {
        is_primary: true,
        ...(COMPANY_ID ? { company_id: COMPANY_ID } : {}),
      },
      select: { company_id: true, id: true },
    });

    let totalStamped = 0;
    for (const p of primaries) {
      const nullCount = await prisma.shopifyOrder.count({
        where: { company_id: p.company_id, shopify_store_id: null },
      });
      if (nullCount === 0) continue;
      console.log(
        `  company ${p.company_id}: ${nullCount} un-stamped order(s) → primary store ${p.id}`,
      );
      if (APPLY) {
        const res = await prisma.shopifyOrder.updateMany({
          where: { company_id: p.company_id, shopify_store_id: null },
          data: { shopify_store_id: p.id },
        });
        totalStamped += res.count;
      } else {
        totalStamped += nullCount;
      }
    }

    console.log(
      `[backfill-order-store] ${APPLY ? 'stamped' : 'would stamp'} ${totalStamped} order(s) across ${primaries.length} compan(ies).`,
    );
    if (!APPLY) console.log('[backfill-order-store] DRY-RUN — pass --apply to write.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
