/**
 * rewrite-legacy-invoices.ts
 *
 * One-shot CLI to update PRE-billing-lifecycle invoices to the new
 * activation-anchored format introduced in migration
 * `20260527000000_billing_lifecycle`.
 *
 * What "legacy" means here: any invoice whose `invoice_number` does NOT
 * match the canonical post-migration pattern
 *   INV-{companyId}-{YYYYMMDD}        (cycle invoice)
 *   INV-{companyId}-OFF-{YYMMDD-...}  (one-off — Phase 3)
 *
 * For each legacy invoice, the script:
 *   1. Looks up `companies.activated_at` (the cycle anchor).
 *   2. Computes the cycle that contained the invoice's `created_at`
 *      (`Math.floor((created_at - activated_at) / 30d)`).
 *   3. Rewrites:
 *        - invoice_number → `INV-{companyId}-{cycleStartYYYYMMDD}`
 *        - period         → cycleStart YYYY-MM
 *        - due_date       → cycleStart + 7d  (matches new generator)
 *        - description    → "<plan> plan — cycle starting YYYY-MM-DD"
 *        - plan_snapshot  → adds {cycle_index, cycle_start} (preserves
 *                            any existing fields)
 *
 * Status / paid_at / amount are NEVER touched.
 *
 * Skips:
 *   - Invoices whose company has no `activated_at` (never activated → we
 *     can't reanchor; leave alone).
 *   - Invoices whose computed `invoice_number` would collide with an
 *     EXISTING invoice on the same company (e.g. the new generator
 *     already created a cycle invoice for that cycle → don't overwrite).
 *
 * USAGE:
 *   # Dry-run (DEFAULT — prints what would change, makes NO writes):
 *   cd backend && npx ts-node scripts/rewrite-legacy-invoices.ts
 *
 *   # Apply the changes:
 *   cd backend && npx ts-node scripts/rewrite-legacy-invoices.ts --apply
 *
 *   # Limit to one company (useful for staging-then-production):
 *   cd backend && npx ts-node scripts/rewrite-legacy-invoices.ts --company=12 --apply
 */

import { PrismaClient } from '@prisma/client';

const CYCLE_DAYS = 30;
const DUE_DAYS = 7;
const DAY_MS = 86_400_000;

const APPLY = process.argv.includes('--apply');
const COMPANY_ARG = process.argv.find((a) => a.startsWith('--company='));
const COMPANY_ID = COMPANY_ARG ? Number(COMPANY_ARG.split('=')[1]) : null;

// Canonical post-migration patterns. Anything else = legacy.
const RE_CYCLE = /^INV-\d+-\d{8}$/;
const RE_OFFCYCLE = /^INV-\d+-OFF-/;

function isLegacy(invoiceNumber: string | null): boolean {
  if (!invoiceNumber) return true;
  return !RE_CYCLE.test(invoiceNumber) && !RE_OFFCYCLE.test(invoiceNumber);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(
      `[rewrite-legacy-invoices] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${
        COMPANY_ID ? `  company=${COMPANY_ID}` : ''
      }`,
    );

    const whereCompany =
      COMPANY_ID !== null ? { company_id: COMPANY_ID } : {};

    const invoices = await prisma.invoice.findMany({
      where: whereCompany,
      include: {
        company: {
          select: {
            id: true,
            company_name: true,
            activated_at: true,
            subscription: { select: { plan_name: true } },
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    let inspected = 0;
    let toUpdate = 0;
    let skipped = 0;
    let updated = 0;
    const collisions: Array<{ id: number; collidesWith: number }> = [];

    for (const inv of invoices) {
      inspected++;
      if (!isLegacy(inv.invoice_number)) continue;

      const c = inv.company;
      const activatedAt = c?.activated_at;
      if (!activatedAt) {
        skipped++;
        console.log(
          `  - skip #${inv.id} (${c?.company_name ?? '?'}): no activated_at on company`,
        );
        continue;
      }

      const createdAt = inv.created_at;
      const elapsed = createdAt.getTime() - activatedAt.getTime();
      const cycleIndex = Math.max(0, Math.floor(elapsed / (CYCLE_DAYS * DAY_MS)));
      const cycleStart = new Date(
        activatedAt.getTime() + cycleIndex * CYCLE_DAYS * DAY_MS,
      );
      const newInvoiceNumber = `INV-${inv.company_id}-${ymd(cycleStart)}`;
      const newDueDate = new Date(cycleStart.getTime() + DUE_DAYS * DAY_MS);
      const newPeriod = cycleStart.toISOString().slice(0, 7);
      const planName = c?.subscription?.plan_name ?? 'Subscription';
      const newDescription = `${planName} plan — cycle starting ${cycleStart
        .toISOString()
        .slice(0, 10)}`;

      // Collision check: does another invoice already use this number?
      const collision = await prisma.invoice.findFirst({
        where: { invoice_number: newInvoiceNumber, id: { not: inv.id } },
        select: { id: true },
      });
      if (collision) {
        collisions.push({ id: inv.id, collidesWith: collision.id });
        skipped++;
        console.log(
          `  - skip #${inv.id} (${c?.company_name}): target number ${newInvoiceNumber} already taken by #${collision.id}`,
        );
        continue;
      }

      const oldSnapshot =
        (inv.plan_snapshot as Record<string, unknown> | null) ?? {};
      const newSnapshot = {
        ...oldSnapshot,
        cycle_index: cycleIndex,
        cycle_start: cycleStart.toISOString(),
      };

      toUpdate++;
      console.log(
        `  ✎ #${inv.id} (${c?.company_name})  ${
          inv.invoice_number ?? '(no number)'
        }  →  ${newInvoiceNumber}  ·  due ${newDueDate
          .toISOString()
          .slice(0, 10)}  ·  period ${newPeriod}`,
      );

      if (APPLY) {
        try {
          await prisma.invoice.update({
            where: { id: inv.id },
            data: {
              invoice_number: newInvoiceNumber,
              due_date: newDueDate,
              period: newPeriod,
              description: newDescription,
              plan_snapshot: newSnapshot,
            },
          });
          updated++;
        } catch (err) {
          console.error(`    ✗ FAILED to update #${inv.id}:`, err);
        }
      }
    }

    console.log(
      [
        '',
        `Summary (mode=${APPLY ? 'APPLY' : 'DRY-RUN'}):`,
        `  invoices inspected : ${inspected}`,
        `  candidates         : ${toUpdate}`,
        `  skipped            : ${skipped} (no activated_at or number collisions)`,
        APPLY ? `  actually updated   : ${updated}` : `  (no writes — re-run with --apply to write)`,
        collisions.length
          ? `  ⚠ collisions (${collisions.length}): ${JSON.stringify(collisions)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[rewrite-legacy-invoices] FATAL:', err);
  process.exit(1);
});
