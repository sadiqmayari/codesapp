/**
 * backfill-return-received.ts
 *
 * One-shot CLI to stamp `shipments.received_at` on HISTORICAL returns that were
 * physically received back BEFORE the receive flow started recording the
 * received timestamp.
 *
 * Why: a return is marked "received" by `ShipmentService.processReturn`, which
 * (a) sets the shipment `status` to a failed-delivery state, (b) stamps
 * `cancelled_at`, and (c) — only since the receive-timestamp change — stamps
 * `received_at`. Older received returns therefore have `cancelled_at` set but
 * `received_at` NULL, so the courier scorecard's "X received" sub-count and the
 * "Returned" labels undercount them. This backfill sets `received_at` =
 * `cancelled_at` for those rows so the physical-receipt fact is recorded.
 *
 * Candidate = a shipment that went through the return-receive path:
 *     received_at  IS NULL
 *     cancelled_at IS NOT NULL          (processReturn stamped this)
 *     status IN ('failed','returned')   (an RTO outcome, NOT a voided booking
 *                                         which is status='cancelled')
 *
 * It writes received_at = cancelled_at (the closest timestamp we have for when
 * the parcel was handled). Nothing else is touched. It is idempotent — a second
 * run finds nothing because received_at is now set.
 *
 * USAGE:
 *   # Dry-run (DEFAULT — prints counts + a sample, makes NO writes):
 *   cd backend && npx ts-node scripts/backfill-return-received.ts
 *
 *   # Apply:
 *   cd backend && npx ts-node scripts/backfill-return-received.ts --apply
 *
 *   # Limit to one company (staging-then-production):
 *   cd backend && npx ts-node scripts/backfill-return-received.ts --company=12 --apply
 */

import { PrismaClient, type ShipmentStatus } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const COMPANY_ARG = process.argv.find((a) => a.startsWith('--company='));
const COMPANY_ID = COMPANY_ARG ? Number(COMPANY_ARG.split('=')[1]) : null;

const RETURN_STATUSES: ShipmentStatus[] = ['failed', 'returned'];

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(
      `[backfill-return-received] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${
        COMPANY_ID !== null ? `  company=${COMPANY_ID}` : ''
      }`,
    );

    const where = {
      received_at: null,
      cancelled_at: { not: null },
      status: { in: RETURN_STATUSES },
      ...(COMPANY_ID !== null ? { company_id: COMPANY_ID } : {}),
    } as const;

    const candidates = await prisma.shipment.count({ where });
    console.log(`  candidates (received_at NULL, cancelled, RTO): ${candidates}`);

    if (candidates === 0) {
      console.log('  nothing to do.');
      return;
    }

    // Per-company breakdown + a small sample, for sanity before applying.
    const sample = await prisma.shipment.findMany({
      where,
      select: {
        id: true,
        company_id: true,
        status: true,
        cancelled_at: true,
        shopify_order_name: true,
        courier_type: true,
      },
      orderBy: { cancelled_at: 'desc' },
      take: 10,
    });
    console.log('  sample (newest 10):');
    for (const s of sample) {
      console.log(
        `    #${s.id} co=${s.company_id} ${s.courier_type} ${s.status} ` +
          `${s.shopify_order_name ?? ''} cancelled_at=${s.cancelled_at?.toISOString() ?? '?'}`,
      );
    }

    if (!APPLY) {
      console.log('  DRY-RUN — no writes. Re-run with --apply to stamp received_at = cancelled_at.');
      return;
    }

    // Set received_at = cancelled_at for every candidate in one statement.
    const statusList = RETURN_STATUSES.map((s) => `'${s}'`).join(',');
    const updated = COMPANY_ID !== null
      ? await prisma.$executeRawUnsafe(
          `UPDATE shipments
              SET received_at = cancelled_at
            WHERE received_at IS NULL
              AND cancelled_at IS NOT NULL
              AND status IN (${statusList})
              AND company_id = ?`,
          COMPANY_ID,
        )
      : await prisma.$executeRawUnsafe(
          `UPDATE shipments
              SET received_at = cancelled_at
            WHERE received_at IS NULL
              AND cancelled_at IS NOT NULL
              AND status IN (${statusList})`,
        );

    console.log(`  APPLIED — stamped received_at on ${updated} shipment(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill-return-received] FAILED:', err);
  process.exit(1);
});
