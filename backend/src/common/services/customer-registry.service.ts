import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';

/**
 * CustomerRegistryService — keeps the CodesApp-owned `customers` table
 * (platform-level, survives tenant deletion) populated automatically.
 *
 * Two capture paths, both BEST-EFFORT / NEVER-THROWING (a registry failure must
 * never break a contact write or an order sync):
 *   1) Identity mirror — a Prisma `$use` middleware on Contact create/update/
 *      upsert. The middleware's `result` is the full contact row, so every one
 *      of the ~8 scattered contact write sites (inbound webhook, Shopify sync,
 *      CSV import, agent edits, courier, bots) is captured in ONE place with no
 *      extra read.
 *   2) Order metrics — `snapshotOrder()` is called by ShopifyOrderSyncService
 *      after each order upsert; it recomputes #orders / LTV / AOV / last-order
 *      from shopify_orders and SNAPSHOTS them onto the customer row so they
 *      persist after the tenant's orders are hard-deleted.
 *
 * The middleware is registered here (not in PrismaService) so the dependency
 * stays one-way (registry -> prisma) with no DI cycle.
 */
@Injectable()
export class CustomerRegistryService implements OnModuleInit {
  private readonly logger = new Logger(CustomerRegistryService.name);
  private static readonly IDENTITY_FIELDS = [
    'name',
    'email',
    'address',
    'city',
    'phone',
    'tags',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    this.prisma.$use(async (params, next) => {
      const result = await next(params);
      if (
        params.model === 'Contact' &&
        (params.action === 'create' ||
          params.action === 'update' ||
          params.action === 'upsert')
      ) {
        // Fire-and-forget: never block (or fail) the contact write.
        this.mirrorContact(params, result).catch((e) =>
          this.logger.debug(
            `customer identity mirror failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
      }
      return result;
    });
    this.logger.log('Customer registry: Contact identity middleware registered');
  }

  /** Tenant name (denormalized onto the customer row), short-cached. */
  private async companyName(companyId: number): Promise<string> {
    const key = `custreg:company-name:${companyId}`;
    const hit = this.cache.get<string>(key);
    if (hit !== undefined) return hit;
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true },
    });
    const name = c?.company_name ?? `Company ${companyId}`;
    this.cache.set(key, name, 600);
    return name;
  }

  private isIdentityWrite(params: Prisma.MiddlewareParams): boolean {
    if (params.action === 'create' || params.action === 'upsert') return true;
    const data = (params.args?.data ?? {}) as Record<string, unknown>;
    return CustomerRegistryService.IDENTITY_FIELDS.some((k) => k in data);
  }

  /** Upsert identity from a written contact row. */
  private async mirrorContact(
    params: Prisma.MiddlewareParams,
    contact: unknown,
  ): Promise<void> {
    const c = contact as {
      company_id?: number;
      phone?: string | null;
      name?: string | null;
      email?: string | null;
      address?: string | null;
      city?: string | null;
      tags?: unknown;
      last_message_at?: Date | null;
      created_at?: Date | null;
    } | null;
    if (!c || typeof c.company_id !== 'number' || !c.phone) return;
    const phone = c.phone;
    const lastSeen = c.last_message_at ?? undefined;

    // A pure last_message_at bump (the inbound hot path) is a cheap last_seen
    // touch — no upsert, no create — so the registry doesn't double every
    // message write. Identity edits / creates do the full upsert.
    if (!this.isIdentityWrite(params)) {
      if (lastSeen) {
        await this.prisma.customer.updateMany({
          where: { origin_company_id: c.company_id, phone },
          data: { last_seen_at: lastSeen },
        });
      }
      return;
    }

    const originName = await this.companyName(c.company_id);
    const tags = (Array.isArray(c.tags) ? c.tags : []) as Prisma.InputJsonValue;
    await this.prisma.customer.upsert({
      where: {
        origin_company_id_phone: { origin_company_id: c.company_id, phone },
      },
      create: {
        phone,
        name: c.name ?? null,
        email: c.email ?? null,
        address: c.address ?? null,
        city: c.city ?? null,
        tags,
        origin_company_id: c.company_id,
        origin_company_name: originName,
        first_seen_at: c.created_at ?? new Date(),
        last_seen_at: lastSeen ?? null,
      },
      update: {
        name: c.name ?? null,
        email: c.email ?? null,
        address: c.address ?? null,
        city: c.city ?? null,
        tags,
        origin_company_name: originName,
        ...(lastSeen ? { last_seen_at: lastSeen } : {}),
      },
    });
  }

  /**
   * Recompute + snapshot a customer's order metrics from shopify_orders.
   * Called by ShopifyOrderSyncService after every order upsert. Also seeds the
   * customer row from the order's own identity if no contact mirror has run yet
   * (so an order always yields a customer). Best-effort / never throws.
   */
  async snapshotOrder(
    companyId: number,
    o: {
      phone?: string | null;
      name?: string | null;
      email?: string | null;
      city?: string | null;
      address1?: string | null;
    },
  ): Promise<void> {
    const phone = o.phone?.trim();
    if (!phone) return;
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{
          cnt: bigint | number;
          ltv: unknown;
          last_at: Date | null;
          cur: string | null;
        }>
      >(
        `SELECT COUNT(*) cnt, COALESCE(SUM(total_price), 0) ltv,
                MAX(shopify_created_at) last_at, MAX(currency) cur
           FROM shopify_orders
          WHERE company_id = ? AND phone = ? AND cancelled_at IS NULL`,
        companyId,
        phone,
      );
      const r = rows?.[0];
      const cnt = Number(r?.cnt ?? 0);
      const ltv = Number(r?.ltv ?? 0);
      const aov = cnt > 0 ? ltv / cnt : 0;
      const lastAt = r?.last_at ?? null;
      const currency = r?.cur ?? null;

      let lastName: string | null = null;
      if (cnt > 0) {
        const nm = await this.prisma.$queryRawUnsafe<
          Array<{ order_name: string | null }>
        >(
          `SELECT order_name FROM shopify_orders
            WHERE company_id = ? AND phone = ? AND cancelled_at IS NULL
            ORDER BY shopify_created_at DESC LIMIT 1`,
          companyId,
          phone,
        );
        lastName = nm?.[0]?.order_name ?? null;
      }

      const originName = await this.companyName(companyId);
      const metrics = {
        orders_count: cnt,
        total_order_value: new Prisma.Decimal(ltv.toFixed(2)),
        avg_order_value: new Prisma.Decimal(aov.toFixed(2)),
        last_order_at: lastAt,
        last_order_name: lastName,
        currency,
      };
      await this.prisma.customer.upsert({
        where: {
          origin_company_id_phone: { origin_company_id: companyId, phone },
        },
        create: {
          phone,
          name: o.name ?? null,
          email: o.email ?? null,
          city: o.city ?? null,
          address: o.address1 ?? null,
          tags: [] as unknown as Prisma.InputJsonValue,
          origin_company_id: companyId,
          origin_company_name: originName,
          first_seen_at: lastAt ?? new Date(),
          last_seen_at: lastAt ?? null,
          ...metrics,
        },
        // Identity is owned by the contact mirror — order sync only refreshes
        // the metrics on an existing row.
        update: metrics,
      });
    } catch (e) {
      this.logger.debug(
        `customer order snapshot failed (company ${companyId}, phone ${phone}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
