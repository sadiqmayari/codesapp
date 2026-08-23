/**
 * backfill-customers.ts
 *
 * One-shot CLI to populate the CodesApp-owned `customers` registry from
 * EXISTING data (the middleware + order-sync hooks only capture new writes).
 *
 * Pass A — identity: upsert one customer per (company, phone) from `contacts`.
 * Pass B — order metrics: recompute #orders / LTV / AOV / last-order per
 *          (company, phone) from `shopify_orders` (non-cancelled) and snapshot
 *          onto the customer row (creating it if orders exist for a phone that
 *          has no contact).
 *
 * origin_company_deleted_at is NEVER set here (only super-admin delete sets it).
 *
 * USAGE:
 *   # Dry-run (DEFAULT — prints counts, makes NO writes):
 *   cd backend && npx ts-node scripts/backfill-customers.ts
 *
 *   # Apply:
 *   cd backend && npx ts-node scripts/backfill-customers.ts --apply
 *
 *   # Limit to one company:
 *   cd backend && npx ts-node scripts/backfill-customers.ts --company=3 --apply
 */

import { PrismaClient, Prisma } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const COMPANY_ARG = process.argv.find((a) => a.startsWith('--company='));
const COMPANY_ID = COMPANY_ARG ? Number(COMPANY_ARG.split('=')[1]) : null;

const BATCH = 500;

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(
      `[backfill-customers] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${
        COMPANY_ID ? `  company=${COMPANY_ID}` : ''
      }`,
    );

    const companies = await prisma.company.findMany({
      select: { id: true, company_name: true },
    });
    const nameOf = new Map(companies.map((c) => [c.id, c.company_name]));

    const whereCompany =
      COMPANY_ID !== null ? { company_id: COMPANY_ID } : {};

    // ── Pass A: identity from contacts ──────────────────────────────────
    let identityCount = 0;
    let lastId = 0;
    for (;;) {
      const contacts = await prisma.contact.findMany({
        where: { ...whereCompany, id: { gt: lastId } },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (contacts.length === 0) break;
      lastId = contacts[contacts.length - 1].id;
      for (const c of contacts) {
        if (!c.phone) continue;
        identityCount++;
        if (!APPLY) continue;
        const originName = nameOf.get(c.company_id) ?? `Company ${c.company_id}`;
        const tags = (Array.isArray(c.tags) ? c.tags : []) as Prisma.InputJsonValue;
        await prisma.customer.upsert({
          where: {
            origin_company_id_phone: {
              origin_company_id: c.company_id,
              phone: c.phone,
            },
          },
          create: {
            phone: c.phone,
            name: c.name ?? null,
            email: c.email ?? null,
            address: c.address ?? null,
            city: c.city ?? null,
            tags,
            origin_company_id: c.company_id,
            origin_company_name: originName,
            first_seen_at: c.created_at ?? new Date(),
            last_seen_at: c.last_message_at ?? null,
          },
          update: {
            name: c.name ?? null,
            email: c.email ?? null,
            address: c.address ?? null,
            city: c.city ?? null,
            tags,
            origin_company_name: originName,
            ...(c.last_message_at ? { last_seen_at: c.last_message_at } : {}),
          },
        });
      }
    }
    console.log(`[backfill-customers] pass A identities: ${identityCount}`);

    // ── Pass B: order metrics from shopify_orders ───────────────────────
    const compFilter =
      COMPANY_ID !== null ? Prisma.sql`AND company_id = ${COMPANY_ID}` : Prisma.empty;

    const aggregates = await prisma.$queryRaw<
      Array<{
        company_id: number;
        phone: string;
        cnt: bigint | number;
        ltv: unknown;
        last_at: Date | null;
        cur: string | null;
      }>
    >(Prisma.sql`
      SELECT company_id, phone, COUNT(*) cnt, COALESCE(SUM(total_price),0) ltv,
             MAX(shopify_created_at) last_at, MAX(currency) cur
        FROM shopify_orders
       WHERE phone IS NOT NULL AND phone <> '' AND cancelled_at IS NULL ${compFilter}
       GROUP BY company_id, phone`);

    // Latest non-cancelled order per (company, phone) → name + identity seed.
    const latest = await prisma.$queryRaw<
      Array<{
        company_id: number;
        phone: string;
        order_name: string | null;
        customer_name: string | null;
        email: string | null;
        city: string | null;
        address1: string | null;
      }>
    >(Prisma.sql`
      SELECT o.company_id, o.phone, o.order_name, o.customer_name, o.email, o.city, o.address1
        FROM shopify_orders o
        JOIN (
          SELECT company_id, phone, MAX(shopify_created_at) mx
            FROM shopify_orders
           WHERE phone IS NOT NULL AND phone <> '' AND cancelled_at IS NULL ${compFilter}
           GROUP BY company_id, phone
        ) m ON m.company_id = o.company_id AND m.phone = o.phone AND m.mx = o.shopify_created_at
       WHERE o.cancelled_at IS NULL`);
    const latestOf = new Map(
      latest.map((l) => [`${l.company_id}|${l.phone}`, l]),
    );

    let metricCount = 0;
    for (const a of aggregates) {
      const cnt = Number(a.cnt ?? 0);
      const ltv = Number(a.ltv ?? 0);
      const aov = cnt > 0 ? ltv / cnt : 0;
      const l = latestOf.get(`${a.company_id}|${a.phone}`);
      metricCount++;
      if (!APPLY) continue;
      const originName =
        nameOf.get(a.company_id) ?? `Company ${a.company_id}`;
      const metrics = {
        orders_count: cnt,
        total_order_value: new Prisma.Decimal(ltv.toFixed(2)),
        avg_order_value: new Prisma.Decimal(aov.toFixed(2)),
        last_order_at: a.last_at ?? null,
        last_order_name: l?.order_name ?? null,
        currency: a.cur ?? null,
      };
      await prisma.customer.upsert({
        where: {
          origin_company_id_phone: {
            origin_company_id: a.company_id,
            phone: a.phone,
          },
        },
        create: {
          phone: a.phone,
          name: l?.customer_name ?? null,
          email: l?.email ?? null,
          city: l?.city ?? null,
          address: l?.address1 ?? null,
          tags: [] as unknown as Prisma.InputJsonValue,
          origin_company_id: a.company_id,
          origin_company_name: originName,
          first_seen_at: a.last_at ?? new Date(),
          last_seen_at: a.last_at ?? null,
          ...metrics,
        },
        update: metrics,
      });
    }
    console.log(`[backfill-customers] pass B order-metric rows: ${metricCount}`);
    console.log(
      `[backfill-customers] done${APPLY ? '' : ' (dry-run — no writes)'}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
