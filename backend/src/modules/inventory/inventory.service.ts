import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampQuery, likeContains } from '../../common/utils/search';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InventoryLedgerService, INVENTORY_QUEUE } from './core/inventory-ledger.service';
import { ADJUST_REASONS, buildable, daysCover, isMovementReason, limitingComponents, MovementReason, statusOf, StockStatus } from './core/stock-math';
import { unitCostOf } from './core/cost-math';
import { resolveInventorySettings } from './core/settings';
import { toCsv } from './core/csv';

export interface ItemFilters {
  storeId?: number;
  locationId?: number;
  search?: string;
  status?: string; // in | low | out | incoming | unlinked | attention | untracked | bundle
  category?: string;
  page?: number;
  limit?: number;
  sort?: string;
  dir?: string;
}

interface ItemRow {
  id: number;
  title: string;
  variant_title: string | null;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  item_code: string | null;
  alias: string | null;
  category: string | null;
  shelf_location: string | null;
  reorder_level: number;
  avg_cost: string | number | null;
  track: number | boolean;
  allow_backorder: number | boolean;
  is_bundle: number | boolean;
  bundle_components: unknown;
  available: string | number;
  committed: string | number;
  incoming: string | number;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const b = (v: unknown) => !!Number(v);

/**
 * Inventory v2 read model + every person-driven change (adjust, set, edit,
 * link, bulk, import, settings). Stock writes go through the ledger; store
 * I/O is queued on the `inventory` queue (ShopifyInventoryService).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly jobQueue: JobQueueService,
  ) {}

  // ── Board ────────────────────────────────────────────────────────────────

  private whereSql(companyId: number, f: ItemFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`i.company_id = ${companyId}`, Prisma.sql`i.archived_at IS NULL`];
    if (f.storeId) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM inventory_variants sv WHERE sv.item_id = i.id AND sv.shopify_store_id = ${f.storeId})`);
    }
    if (f.category) parts.push(Prisma.sql`i.category = ${f.category}`);
    const q = clampQuery(f.search);
    if (q) {
      const like = likeContains(q);
      parts.push(Prisma.sql`(i.title LIKE ${like} OR i.variant_title LIKE ${like} OR i.sku LIKE ${like} OR i.item_code LIKE ${like}
        OR i.alias LIKE ${like} OR i.barcode LIKE ${like} OR i.shelf_location LIKE ${like}
        OR EXISTS (SELECT 1 FROM inventory_variants qv WHERE qv.item_id = i.id AND (qv.sku LIKE ${like} OR qv.barcode LIKE ${like})))`);
    }
    if (f.status === 'unlinked') {
      parts.push(Prisma.sql`(SELECT COUNT(DISTINCT uv.shopify_store_id) FROM inventory_variants uv WHERE uv.item_id = i.id)
        < (SELECT COUNT(*) FROM shopify_stores ss WHERE ss.company_id = ${companyId} AND ss.status = 'active')`);
    } else if (f.status === 'attention') {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM inventory_variants av WHERE av.item_id = i.id AND
        (av.qty_push_status = 'error' OR av.price_push_status = 'error' OR av.cost_push_status = 'error'))`);
    } else if (f.status === 'untracked') {
      parts.push(Prisma.sql`i.track = 0`);
    } else if (f.status === 'bundle') {
      parts.push(Prisma.sql`i.is_bundle = 1`);
    }
    return Prisma.join(parts, ' AND ');
  }

  private havingSql(f: ItemFilters): Prisma.Sql {
    // bundles have no own stock: they pass the stock filters here and are
    // filtered after their buildable count is computed
    const avail = Prisma.sql`COALESCE(SUM(l.available), 0)`;
    if (f.status === 'out') return Prisma.sql`HAVING (MAX(i.is_bundle) = 1 OR ${avail} <= 0)`;
    if (f.status === 'low')
      return Prisma.sql`HAVING (MAX(i.is_bundle) = 1 OR (${avail} > 0 AND ${avail} <= MAX(i.reorder_level)))`;
    if (f.status === 'in') return Prisma.sql`HAVING (MAX(i.is_bundle) = 1 OR ${avail} > MAX(i.reorder_level))`;
    if (f.status === 'incoming') return Prisma.sql`HAVING COALESCE(SUM(l.incoming), 0) > 0`;
    return Prisma.empty;
  }

  private orderSql(sort?: string, dir?: string): Prisma.Sql {
    const cols: Record<string, string> = {
      title: 'i.title',
      sku: 'i.sku',
      item_code: 'i.item_code',
      category: 'i.category',
      shelf: 'i.shelf_location',
      cost: 'i.avg_cost',
      available: 'available',
      committed: 'committed',
      incoming: 'incoming',
      updated: 'i.updated_at',
    };
    const col = cols[sort ?? ''] ?? 'i.title';
    const d = dir === 'desc' ? 'DESC' : 'ASC';
    // NULLs last for nullable columns; stable tie-breakers
    return Prisma.raw(`(${col} IS NULL) ASC, ${col} ${d}, i.title ASC, i.variant_title ASC, i.id ASC`);
  }

  async list(companyId: number, f: ItemFilters) {
    const page = Math.max(1, Math.floor(Number(f.page) || 1));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(f.limit) || 50)));
    const where = this.whereSql(companyId, f);
    const having = this.havingSql(f);
    const locJoin = f.locationId ? Prisma.sql`AND l.location_id = ${f.locationId}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT i.id, i.title, i.variant_title, i.sku, i.barcode, i.image_url, i.item_code, i.alias, i.category,
             i.shelf_location, i.reorder_level, i.avg_cost, i.track, i.allow_backorder, i.is_bundle, i.bundle_components,
             COALESCE(SUM(l.available), 0) AS available, COALESCE(SUM(l.committed), 0) AS committed,
             COALESCE(SUM(l.incoming), 0) AS incoming
      FROM inventory_items i
      LEFT JOIN inventory_levels l ON l.item_id = i.id ${locJoin}
      WHERE ${where}
      GROUP BY i.id
      ${having}
      ORDER BY ${this.orderSql(f.sort, f.dir)}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const cnt = await this.prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM (
        SELECT i.id FROM inventory_items i
        LEFT JOIN inventory_levels l ON l.item_id = i.id ${locJoin}
        WHERE ${where} GROUP BY i.id ${having}
      ) x`;
    const data = await this.hydrate(companyId, rows, f.locationId);
    const filtered =
      f.status === 'out' || f.status === 'low' || f.status === 'in'
        ? data.filter((d) => !d.isBundle || d.status === f.status)
        : data;
    return { success: true, data: filtered, message: 'OK', meta: { page, limit, total: Number(cnt[0]?.c ?? 0) } };
  }

  /** Listings, store chips, bundle buildable, conflicts, velocity for a page of items. */
  private async hydrate(companyId: number, rows: ItemRow[], locationId?: number) {
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const [listings, stores, sales, levels] = await Promise.all([
      this.prisma.inventoryVariant.findMany({
        where: { company_id: companyId, item_id: { in: ids } },
        select: {
          id: true, item_id: true, shopify_store_id: true, provider: true, sku: true, price: true, compare_at_price: true,
          cost_price: true, shopify_unit_cost: true, link_source: true,
          qty_push_status: true, qty_push_error: true, price_push_status: true, price_push_error: true,
          cost_push_status: true, cost_push_error: true,
          product: { select: { id: true, status: true, status_push_status: true, status_push_error: true, shopify_product_gid: true, handle: true } },
          pushState: { select: { location_link_id: true, last_seen: true, status: true, link: { select: { location_id: true } } } },
        },
      }),
      this.prisma.shopifyStore.findMany({
        where: { company_id: companyId },
        select: { id: true, label: true, shop_domain: true, provider: true, base_url: true },
      }),
      this.prisma.$queryRaw<{ item_id: number; sold: string | number }[]>`
        SELECT item_id, SUM(-delta) AS sold FROM inventory_movements
        WHERE company_id = ${companyId} AND item_id IN (${Prisma.join(ids)}) AND reason = 'sale'
          AND created_at >= NOW() - INTERVAL 30 DAY
        GROUP BY item_id`,
      this.prisma.inventoryLevel.findMany({
        where: { company_id: companyId, item_id: { in: ids } },
        select: { item_id: true, location_id: true, available: true },
      }),
    ]);
    const storeBy = new Map(stores.map((s) => [s.id, s]));
    const soldBy = new Map(sales.map((s) => [Number(s.item_id), n(s.sold)]));
    const poolBy = new Map(levels.map((l) => [`${l.item_id}:${l.location_id}`, l.available]));

    // bundle components → their availability
    const compIds = new Set<number>();
    for (const r of rows) if (b(r.is_bundle)) for (const c of this.components(r.bundle_components)) compIds.add(c.itemId);
    const compRows = compIds.size
      ? await this.prisma.$queryRaw<{ id: number; title: string; variant_title: string | null; sku: string | null; available: string | number }[]>`
          SELECT i.id, i.title, i.variant_title, i.sku, COALESCE(SUM(l.available), 0) AS available
          FROM inventory_items i LEFT JOIN inventory_levels l ON l.item_id = i.id
          ${locationId ? Prisma.sql`AND l.location_id = ${locationId}` : Prisma.empty}
          WHERE i.company_id = ${companyId} AND i.id IN (${Prisma.join([...compIds])}) GROUP BY i.id`
      : [];
    const compBy = new Map(compRows.map((c) => [Number(c.id), c]));

    return rows.map((r) => {
      const ls = listings.filter((l) => l.item_id === Number(r.id));
      let available = n(r.available);
      let components: Array<{ itemId: number; title: string; sku: string | null; quantity: number; available: number; limiting: boolean }> | null = null;
      if (b(r.is_bundle)) {
        const raw = this.components(r.bundle_components).map((c) => {
          const cr = compBy.get(c.itemId);
          return {
            itemId: c.itemId,
            title: cr ? [cr.title, cr.variant_title].filter(Boolean).join(' · ') : 'Unknown item',
            sku: cr?.sku ?? null,
            quantity: c.quantity,
            available: n(cr?.available),
          };
        });
        const lim = new Set(limitingComponents(raw));
        components = raw.map((c, i) => ({ ...c, limiting: lim.has(i) }));
        available = buildable(raw);
      }
      const conflict =
        !b(r.is_bundle) &&
        ls.some((l) =>
          l.pushState.some(
            (s) => {
              const pool = poolBy.get(`${r.id}:${s.link.location_id}`) ?? 0;
              return s.status !== 'error' && s.last_seen != null && s.last_seen !== pool && !(s.last_seen <= 0 && pool <= 0);
            },
          ),
        );
      const sold30 = soldBy.get(Number(r.id)) ?? 0;
      const firstCost = ls.map((l) => unitCostOf({ costPrice: l.cost_price, shopifyUnitCost: l.shopify_unit_cost })).find((c) => c != null) ?? null;
      const prices = ls.map((l) => (l.price == null ? null : Number(l.price))).filter((p): p is number => p != null);
      const status: StockStatus = statusOf(available, Number(r.reorder_level));
      return {
        id: Number(r.id),
        title: r.title,
        variantTitle: r.variant_title,
        sku: r.sku,
        barcode: r.barcode,
        image: r.image_url,
        itemCode: r.item_code,
        alias: r.alias,
        category: r.category,
        shelfLocation: r.shelf_location,
        reorderLevel: Number(r.reorder_level),
        avgCost: r.avg_cost != null ? Number(r.avg_cost) : firstCost,
        track: b(r.track),
        allowBackorder: b(r.allow_backorder),
        isBundle: b(r.is_bundle),
        available,
        committed: n(r.committed),
        incoming: n(r.incoming),
        onHand: available + n(r.committed),
        status,
        components,
        conflict,
        sold30,
        daysCover: daysCover(available, sold30 / 30),
        priceMin: prices.length ? Math.min(...prices) : null,
        priceMax: prices.length ? Math.max(...prices) : null,
        listings: ls.map((l) => {
          const s = storeBy.get(l.shopify_store_id);
          return {
            id: l.id,
            storeId: l.shopify_store_id,
            storeLabel: s?.label || s?.shop_domain || s?.base_url || `Store ${l.shopify_store_id}`,
            provider: l.provider,
            linkSource: l.link_source,
            productId: l.product?.id ?? null,
            productStatus: l.product?.status ?? null,
            productStatusPush: l.product?.status_push_status ?? null,
            productStatusError: l.product?.status_push_error ?? null,
            price: l.price != null ? Number(l.price) : null,
            compareAtPrice: l.compare_at_price != null ? Number(l.compare_at_price) : null,
            storeQty: l.pushState.reduce((a, x) => a + (x.last_seen ?? 0), 0),
            qtyPushStatus: l.qty_push_status,
            qtyPushError: l.qty_push_error,
            pricePushStatus: l.price_push_status,
            pricePushError: l.price_push_error,
            costPushStatus: l.cost_push_status,
            costPushError: l.cost_push_error,
          };
        }),
      };
    });
  }

  private components(raw: unknown): Array<{ itemId: number; quantity: number }> {
    return Array.isArray(raw)
      ? (raw as Array<{ itemId?: number; quantity?: number }>)
          .filter((c) => Number(c?.itemId) > 0)
          .map((c) => ({ itemId: Number(c.itemId), quantity: Math.max(1, Number(c.quantity) || 1) }))
      : [];
  }

  async summary(companyId: number, storeId?: number, locationId?: number) {
    const storeSql = storeId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM inventory_variants sv WHERE sv.item_id = i.id AND sv.shopify_store_id = ${storeId})`
      : Prisma.empty;
    const locSql = locationId ? Prisma.sql`AND l.location_id = ${locationId}` : Prisma.empty;
    const [agg] = await this.prisma.$queryRaw<
      Array<{ skus: bigint; units: string | number; value: string | number; low: string | number; out_c: string | number; incoming: string | number; no_cost: string | number }>
    >`
      SELECT COUNT(*) AS skus,
             COALESCE(SUM(GREATEST(x.avail, 0)), 0) AS units,
             COALESCE(SUM(GREATEST(x.avail + x.comm, 0) * COALESCE(x.cost, 0)), 0) AS value,
             COALESCE(SUM(CASE WHEN x.avail > 0 AND x.avail <= x.reorder THEN 1 ELSE 0 END), 0) AS low,
             COALESCE(SUM(CASE WHEN x.avail <= 0 THEN 1 ELSE 0 END), 0) AS out_c,
             COALESCE(SUM(x.inc), 0) AS incoming,
             COALESCE(SUM(CASE WHEN x.cost IS NULL THEN 1 ELSE 0 END), 0) AS no_cost
      FROM (
        SELECT i.id, i.reorder_level AS reorder,
               COALESCE(i.avg_cost, (SELECT COALESCE(cv.cost_price, cv.shopify_unit_cost) FROM inventory_variants cv
                                     WHERE cv.item_id = i.id AND COALESCE(cv.cost_price, cv.shopify_unit_cost) IS NOT NULL LIMIT 1)) AS cost,
               COALESCE(SUM(l.available), 0) AS avail, COALESCE(SUM(l.committed), 0) AS comm, COALESCE(SUM(l.incoming), 0) AS inc
        FROM inventory_items i
        LEFT JOIN inventory_levels l ON l.item_id = i.id ${locSql}
        WHERE i.company_id = ${companyId} AND i.archived_at IS NULL AND i.is_bundle = 0 AND i.track = 1 ${storeSql}
        GROUP BY i.id
      ) x`;
    const [attn] = await this.prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(DISTINCT v.item_id) AS c FROM inventory_variants v
      WHERE v.company_id = ${companyId} AND v.item_id IS NOT NULL
        AND (v.qty_push_status = 'error' OR v.price_push_status = 'error' OR v.cost_push_status = 'error')`;
    const conflicts = await this.conflicts(companyId);
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_v2_at: true } });
    const unlinked = await this.prisma.inventoryVariant.count({ where: { company_id: companyId, item_id: null } });
    const [cur] = await this.prisma.$queryRaw<Array<{ currency: string | null }>>`
      SELECT currency FROM shopify_orders WHERE company_id = ${companyId} AND currency IS NOT NULL
      GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1`.catch(() => [{ currency: null }]);
    return {
      ready: !!company?.inventory_v2_at,
      currency: cur?.currency ?? null,
      skus: Number(agg?.skus ?? 0),
      availableUnits: n(agg?.units),
      stockValue: n(agg?.value),
      lowCount: n(agg?.low),
      outCount: n(agg?.out_c),
      incomingUnits: n(agg?.incoming),
      itemsWithoutCost: n(agg?.no_cost),
      pushFailed: Number(attn?.c ?? 0),
      conflicts: conflicts.length,
      unlinkedListings: unlinked,
    };
  }

  async categories(companyId: number): Promise<string[]> {
    const rows = await this.prisma.inventoryItem.findMany({
      where: { company_id: companyId, archived_at: null, category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
      take: 500,
    });
    return rows.map((r) => (r.category ?? '').trim()).filter(Boolean);
  }

  // ── Item sheet ───────────────────────────────────────────────────────────

  async getItem(companyId: number, id: number) {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id, company_id: companyId },
      include: { supplier: { select: { id: true, name: true } } },
    });
    if (!item) throw new NotFoundException('Item not found');
    const [row] = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT i.id, i.title, i.variant_title, i.sku, i.barcode, i.image_url, i.item_code, i.alias, i.category,
             i.shelf_location, i.reorder_level, i.avg_cost, i.track, i.allow_backorder, i.is_bundle, i.bundle_components,
             COALESCE(SUM(l.available), 0) AS available, COALESCE(SUM(l.committed), 0) AS committed, COALESCE(SUM(l.incoming), 0) AS incoming
      FROM inventory_items i LEFT JOIN inventory_levels l ON l.item_id = i.id
      WHERE i.id = ${id} AND i.company_id = ${companyId} GROUP BY i.id`;
    const [base] = await this.hydrate(companyId, [row]);
    const locations = await this.prisma.inventoryLocation.findMany({
      where: { company_id: companyId },
      orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      include: { levels: { where: { item_id: id } }, links: { select: { store_id: true, sync_enabled: true } } },
    });
    const costHistory = await this.prisma.inventoryCostHistory.findMany({
      where: { company_id: companyId, item_id: id },
      orderBy: { created_at: 'desc' },
      take: 20,
    });
    const settings = await this.settings(companyId);
    return {
      ...base,
      reorderQty: item.reorder_qty,
      leadTimeDays: item.lead_time_days,
      notes: item.notes,
      supplier: item.supplier,
      targetCoverDays: settings.targetCoverDays,
      locations: locations.map((l) => {
        const lv = l.levels[0];
        return {
          id: l.id,
          name: l.name,
          isActive: l.is_active,
          isDefault: l.is_default,
          storeIds: [...new Set(l.links.filter((k) => k.sync_enabled).map((k) => k.store_id))],
          available: lv?.available ?? 0,
          committed: lv?.committed ?? 0,
          incoming: lv?.incoming ?? 0,
          onHand: (lv?.available ?? 0) + (lv?.committed ?? 0),
          version: lv?.version ?? 0,
        };
      }),
      costHistory: costHistory.map((c) => ({
        at: c.created_at,
        oldCost: c.old_cost != null ? Number(c.old_cost) : null,
        newCost: c.new_cost != null ? Number(c.new_cost) : null,
        source: c.source,
        ref: c.ref,
      })),
    };
  }

  /** Resolve a legacy variant id (old /inventory/<id> deep links) to its item. */
  async itemForVariant(companyId: number, variantId: number) {
    const v = await this.prisma.inventoryVariant.findFirst({
      where: { id: variantId, company_id: companyId },
      select: { item_id: true },
    });
    if (!v?.item_id) throw new NotFoundException('Item not found');
    return { itemId: v.item_id };
  }

  async updateItem(
    companyId: number,
    id: number,
    dto: {
      item_code?: string | null; alias?: string | null; category?: string | null; shelf_location?: string | null;
      reorder_level?: number; reorder_qty?: number | null; lead_time_days?: number | null; avg_cost?: number | null;
      track?: boolean; allow_backorder?: boolean; notes?: string | null; supplier_id?: number | null; title?: string;
    },
    actorUserId?: number,
  ) {
    const item = await this.prisma.inventoryItem.findFirst({ where: { id, company_id: companyId } });
    if (!item) throw new NotFoundException('Item not found');
    const clean = (s: string | null | undefined) => (s == null ? null : s.trim() || null);
    const data: Prisma.InventoryItemUpdateInput = {};
    if (dto.title !== undefined && dto.title.trim()) data.title = dto.title.trim().slice(0, 400);
    if (dto.item_code !== undefined) {
      const code = clean(dto.item_code);
      if (code) {
        const dup = await this.prisma.inventoryItem.findFirst({
          where: { company_id: companyId, item_code: code, id: { not: id }, archived_at: null },
          select: { title: true, variant_title: true },
        });
        if (dup) throw new BadRequestException(`Item code ${code} is already used by ${[dup.title, dup.variant_title].filter(Boolean).join(' · ')}.`);
      }
      data.item_code = code;
    }
    if (dto.alias !== undefined) data.alias = clean(dto.alias);
    if (dto.category !== undefined) data.category = clean(dto.category);
    if (dto.shelf_location !== undefined) data.shelf_location = clean(dto.shelf_location);
    if (dto.notes !== undefined) data.notes = clean(dto.notes);
    if (dto.reorder_level !== undefined) data.reorder_level = Math.max(0, Math.trunc(dto.reorder_level));
    if (dto.reorder_qty !== undefined) data.reorder_qty = dto.reorder_qty == null ? null : Math.max(1, Math.trunc(dto.reorder_qty));
    if (dto.lead_time_days !== undefined) data.lead_time_days = dto.lead_time_days == null ? null : Math.max(0, Math.trunc(dto.lead_time_days));
    if (dto.track !== undefined) data.track = dto.track;
    if (dto.allow_backorder !== undefined) data.allow_backorder = dto.allow_backorder;
    if (dto.supplier_id !== undefined) {
      if (dto.supplier_id != null) {
        const s = await this.prisma.supplier.findFirst({ where: { id: dto.supplier_id, company_id: companyId } });
        if (!s) throw new BadRequestException('Supplier not found');
        data.supplier = { connect: { id: s.id } };
      } else data.supplier = { disconnect: true };
    }
    let costChanged = false;
    if (dto.avg_cost !== undefined) {
      const next = dto.avg_cost == null ? null : Math.round(dto.avg_cost * 100) / 100;
      const prev = item.avg_cost == null ? null : Number(item.avg_cost);
      if (next !== prev) {
        data.avg_cost = next;
        costChanged = true;
      }
    }
    await this.prisma.inventoryItem.update({ where: { id }, data });
    if (costChanged) {
      await this.prisma.inventoryCostHistory.create({
        data: {
          company_id: companyId, item_id: id,
          old_cost: item.avg_cost, new_cost: dto.avg_cost ?? null, source: 'manual', actor_user_id: actorUserId ?? null,
        },
      });
      if (dto.avg_cost != null) {
        await this.prisma.inventoryVariant.updateMany({
          where: { company_id: companyId, item_id: id, provider: 'shopify' },
          data: { cost_push_status: 'pending', cost_push_error: null },
        });
        await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'pushCost', companyId, itemId: id }, { dedupKey: `inv2-cost:${id}`, maxAttempts: 2 });
      }
    }
    if (dto.track === true && !item.track) await this.ledger.queuePush(companyId, id);
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: [id], edit: true });
    return this.getItem(companyId, id);
  }

  async adjust(
    companyId: number,
    id: number,
    dto: { locationId: number; delta: number; reason: string; note?: string | null },
    actorUserId?: number,
  ) {
    await this.assertItem(companyId, id);
    await this.assertLocation(companyId, dto.locationId);
    if (!ADJUST_REASONS.includes(dto.reason as MovementReason)) throw new BadRequestException('Pick a reason for the adjustment');
    const delta = Math.trunc(dto.delta);
    if (!delta) throw new BadRequestException('Change must not be 0');
    await this.ledger.apply(
      companyId,
      [{ itemId: id, locationId: dto.locationId, delta }],
      { reason: dto.reason as MovementReason, note: dto.note ?? null, refType: 'manual', actorUserId: actorUserId ?? null },
    );
    return this.getItem(companyId, id);
  }

  async setAvailable(
    companyId: number,
    id: number,
    dto: { locationId?: number; available: number; seen?: number | null },
    actorUserId?: number,
  ) {
    await this.assertItem(companyId, id);
    const locationId = dto.locationId ?? (await this.defaultLocation(companyId));
    if (!locationId) throw new BadRequestException('Add a location first (Settings → Inventory).');
    await this.assertLocation(companyId, locationId);
    await this.ledger.setAvailable(companyId, id, locationId, dto.available, dto.seen, {
      reason: 'set', refType: 'manual', actorUserId: actorUserId ?? null,
    });
    return this.getItem(companyId, id);
  }

  async pushNow(companyId: number, id: number) {
    await this.assertItem(companyId, id);
    await this.ledger.queuePush(companyId, id);
    return { queued: true };
  }

  async updateListing(companyId: number, listingId: number, dto: { price?: number; compare_at_price?: number | null }) {
    const l = await this.prisma.inventoryVariant.findFirst({ where: { id: listingId, company_id: companyId } });
    if (!l) throw new NotFoundException('Listing not found');
    const price = dto.price !== undefined ? dto.price : l.price != null ? Number(l.price) : null;
    const cmp = dto.compare_at_price !== undefined ? dto.compare_at_price : l.compare_at_price != null ? Number(l.compare_at_price) : null;
    if (price != null && !(price > 0)) throw new BadRequestException('Sale price must be more than 0');
    if (cmp != null && cmp > 0 && price != null && cmp <= price) {
      throw new BadRequestException('Compare-at price must be higher than the sale price');
    }
    await this.prisma.inventoryVariant.update({
      where: { id: listingId },
      data: {
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.compare_at_price !== undefined ? { compare_at_price: dto.compare_at_price } : {}),
        price_push_status: 'pending',
        price_push_error: null,
      },
    });
    await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'pushPrice', companyId, variantId: listingId }, { dedupKey: `inv2-price:${listingId}`, maxAttempts: 2 });
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: l.item_id ? [l.item_id] : [] });
    return { queued: true };
  }

  // ── Linking ──────────────────────────────────────────────────────────────

  /** Move a listing onto another item (merge two stores' products into one pool). */
  async linkListing(companyId: number, itemId: number, listingId: number) {
    const [item, listing] = await Promise.all([
      this.prisma.inventoryItem.findFirst({ where: { id: itemId, company_id: companyId }, include: { listings: { select: { shopify_store_id: true, id: true } } } }),
      this.prisma.inventoryVariant.findFirst({ where: { id: listingId, company_id: companyId } }),
    ]);
    if (!item || !listing) throw new NotFoundException('Not found');
    if (listing.item_id === itemId) return this.getItem(companyId, itemId);
    if (item.listings.some((l) => l.shopify_store_id === listing.shopify_store_id)) {
      throw new BadRequestException('This item already has a listing in that store — unlink it first.');
    }
    const oldItemId = listing.item_id;
    await this.prisma.inventoryVariant.update({ where: { id: listingId }, data: { item_id: itemId, link_source: 'manual' } });
    // the old item loses its listing; archive it when it has none left
    if (oldItemId) {
      const left = await this.prisma.inventoryVariant.count({ where: { item_id: oldItemId } });
      if (!left) await this.prisma.inventoryItem.update({ where: { id: oldItemId }, data: { archived_at: new Date() } });
    }
    // the store now follows the pool
    await this.ledger.queuePush(companyId, itemId);
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: [itemId, oldItemId].filter(Boolean) });
    return this.getItem(companyId, itemId);
  }

  /** Split a listing off into its own item (its store keeps its current stock as the new pool). */
  async unlinkListing(companyId: number, listingId: number) {
    const listing = await this.prisma.inventoryVariant.findFirst({
      where: { id: listingId, company_id: companyId },
      include: { product: { select: { title: true, image_url: true } }, item: true, pushState: { include: { link: true } } },
    });
    if (!listing?.item) throw new NotFoundException('Listing not found');
    const others = await this.prisma.inventoryVariant.count({ where: { item_id: listing.item_id, id: { not: listingId } } });
    if (!others) throw new BadRequestException('This is the item’s only listing.');
    const created = await this.prisma.inventoryItem.create({
      data: {
        company_id: companyId,
        title: listing.product.title.slice(0, 400),
        variant_title: listing.variant_title,
        image_url: listing.product.image_url,
        avg_cost: listing.item.avg_cost,
        reorder_level: listing.item.reorder_level,
      },
    });
    await this.prisma.inventoryVariant.update({ where: { id: listingId }, data: { item_id: created.id, link_source: 'manual' } });
    for (const s of listing.pushState) {
      if (s.last_seen != null && s.last_seen !== 0) {
        await this.ledger.apply(
          companyId,
          [{ itemId: created.id, locationId: s.link.location_id, delta: s.last_seen, variantId: listingId }],
          { reason: 'bootstrap', note: 'Unlinked — kept the store’s own stock' },
          { push: false },
        );
      }
    }
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: [listing.item_id, created.id] });
    return { itemId: created.id };
  }

  /** Unlinked listings of OTHER stores that look like this item (for "Link another store's product"). */
  async linkCandidates(companyId: number, itemId: number, q?: string) {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id: itemId, company_id: companyId },
      include: { listings: { select: { shopify_store_id: true } } },
    });
    if (!item) throw new NotFoundException('Item not found');
    const taken = item.listings.map((l) => l.shopify_store_id);
    const term = clampQuery(q) || item.title.split(/\s+/).slice(0, 3).join(' ');
    const rows = await this.prisma.inventoryVariant.findMany({
      where: {
        company_id: companyId,
        shopify_store_id: { notIn: taken.length ? taken : [-1] },
        OR: [{ sku: { contains: term } }, { variant_title: { contains: term } }, { product: { title: { contains: term } } }],
      },
      include: { product: { select: { title: true, image_url: true } } },
      take: 25,
    });
    return rows.map((r) => ({
      listingId: r.id, storeId: r.shopify_store_id, title: r.product.title, variantTitle: r.variant_title,
      sku: r.sku, image: r.product.image_url, itemId: r.item_id,
    }));
  }

  // ── Conflicts (linked stores disagree with the pool) ─────────────────────

  async conflicts(companyId: number) {
    const rows = await this.prisma.$queryRaw<
      Array<{ item_id: number; title: string; variant_title: string | null; location_id: number; location: string; pool: number; variant_id: number; store_id: number; store_qty: number }>
    >`
      SELECT i.id AS item_id, i.title, i.variant_title, k.location_id, loc.name AS location,
             COALESCE(l.available, 0) AS pool, v.id AS variant_id, v.shopify_store_id AS store_id, ps.last_seen AS store_qty
      FROM listing_push_state ps
      JOIN inventory_variants v ON v.id = ps.variant_id
      JOIN inventory_items i ON i.id = v.item_id AND i.track = 1 AND i.is_bundle = 0 AND i.archived_at IS NULL
      JOIN inventory_location_links k ON k.id = ps.location_link_id AND k.sync_enabled = 1
      JOIN inventory_locations loc ON loc.id = k.location_id
      LEFT JOIN inventory_levels l ON l.item_id = i.id AND l.location_id = k.location_id
      WHERE ps.company_id = ${companyId} AND ps.last_seen IS NOT NULL
        AND ps.last_seen <> COALESCE(l.available, 0)
        AND NOT (ps.last_seen <= 0 AND COALESCE(l.available, 0) <= 0)
        AND (ps.status IS NULL OR ps.status <> 'error')
      ORDER BY i.title
      LIMIT 500`;
    const byKey = new Map<string, { itemId: number; title: string; locationId: number; location: string; pool: number; stores: Array<{ storeId: number; listingId: number; qty: number }> }>();
    for (const r of rows) {
      const k = `${r.item_id}:${r.location_id}`;
      if (!byKey.has(k)) {
        byKey.set(k, {
          itemId: Number(r.item_id), title: [r.title, r.variant_title].filter(Boolean).join(' · '),
          locationId: Number(r.location_id), location: r.location, pool: Number(r.pool), stores: [],
        });
      }
      byKey.get(k)!.stores.push({ storeId: Number(r.store_id), listingId: Number(r.variant_id), qty: Number(r.store_qty) });
    }
    return [...byKey.values()];
  }

  /** Resolve: set the pool to the chosen number and push it to every linked store. */
  async resolveConflict(companyId: number, dto: { itemId: number; locationId: number; available: number }, actorUserId?: number) {
    await this.assertItem(companyId, dto.itemId);
    await this.ledger.setAvailable(companyId, dto.itemId, dto.locationId, dto.available, undefined, {
      reason: 'adjust_recount', note: 'Conflict resolved', refType: 'manual', actorUserId: actorUserId ?? null,
    });
    await this.ledger.queuePush(companyId, dto.itemId);
    return { ok: true };
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────

  async bulk(
    companyId: number,
    dto: { itemIds: number[]; action: string; locationId?: number; delta?: number; reason?: string; note?: string; category?: string | null; reorderLevel?: number; track?: boolean },
    actorUserId?: number,
  ) {
    const ids = [...new Set((dto.itemIds ?? []).map(Number).filter((x) => x > 0))].slice(0, 2000);
    if (!ids.length) throw new BadRequestException('Select at least one item');
    const owned = await this.prisma.inventoryItem.findMany({ where: { company_id: companyId, id: { in: ids } }, select: { id: true } });
    const ok = owned.map((o) => o.id);
    switch (dto.action) {
      case 'adjust': {
        if (!dto.locationId) throw new BadRequestException('Pick a location');
        await this.assertLocation(companyId, dto.locationId);
        if (!ADJUST_REASONS.includes(dto.reason as MovementReason)) throw new BadRequestException('Pick a reason');
        const delta = Math.trunc(dto.delta ?? 0);
        if (!delta) throw new BadRequestException('Change must not be 0');
        await this.ledger.apply(
          companyId,
          ok.map((itemId) => ({ itemId, locationId: dto.locationId!, delta })),
          { reason: dto.reason as MovementReason, note: dto.note ?? null, refType: 'manual', actorUserId: actorUserId ?? null },
        );
        break;
      }
      case 'category':
        await this.prisma.inventoryItem.updateMany({ where: { company_id: companyId, id: { in: ok } }, data: { category: dto.category?.trim() || null } });
        break;
      case 'reorder':
        await this.prisma.inventoryItem.updateMany({
          where: { company_id: companyId, id: { in: ok } },
          data: { reorder_level: Math.max(0, Math.trunc(dto.reorderLevel ?? 0)) },
        });
        break;
      case 'track':
        await this.prisma.inventoryItem.updateMany({ where: { company_id: companyId, id: { in: ok } }, data: { track: !!dto.track } });
        break;
      case 'push':
        for (const id of ok) await this.ledger.queuePush(companyId, id);
        break;
      default:
        throw new BadRequestException('Unknown bulk action');
    }
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: ok, bulk: dto.action });
    return { updated: ok.length };
  }

  // ── Ledger ───────────────────────────────────────────────────────────────

  async movements(
    companyId: number,
    f: { itemId?: number; locationId?: number; reason?: string; from?: string; to?: string; page?: number; limit?: number },
  ) {
    const page = Math.max(1, Number(f.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const where: Prisma.InventoryMovementWhereInput = {
      company_id: companyId,
      item_id: f.itemId ? f.itemId : { not: null },
      ...(f.locationId ? { location_id: f.locationId } : {}),
      ...(f.reason && isMovementReason(f.reason) ? { reason: f.reason } : {}),
      ...(f.from || f.to
        ? { created_at: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lt: new Date(f.to) } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { item: { select: { title: true, variant_title: true, sku: true } } },
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.actor_user_id).filter((x): x is number => !!x))];
    const locIds = [...new Set(rows.map((r) => r.location_id).filter((x): x is number => !!x))];
    const [users, locs] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds }, company_id: companyId }, select: { id: true, name: true } }) : [],
      locIds.length ? this.prisma.inventoryLocation.findMany({ where: { id: { in: locIds } }, select: { id: true, name: true } }) : [],
    ]);
    const uBy = new Map(users.map((u) => [u.id, u.name]));
    const lBy = new Map(locs.map((l) => [l.id, l.name]));
    return {
      success: true,
      message: 'OK',
      meta: { page, limit, total },
      data: rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        itemId: r.item_id,
        item: r.item ? [r.item.title, r.item.variant_title].filter(Boolean).join(' · ') : null,
        sku: r.item?.sku ?? null,
        location: r.location_id ? lBy.get(r.location_id) ?? null : null,
        delta: r.delta,
        after: r.qty_after,
        reason: r.reason,
        ref: r.ref,
        refType: r.ref_type,
        note: r.note,
        by: r.actor_user_id ? uBy.get(r.actor_user_id) ?? 'Team member' : null,
      })),
    };
  }

  async exportMovements(companyId: number, f: { itemId?: number; locationId?: number; reason?: string; from?: string; to?: string }) {
    const all: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= 50; p++) {
      const r = await this.movements(companyId, { ...f, page: p, limit: 200 });
      all.push(...r.data);
      if (r.data.length < 200) break;
    }
    return toCsv(
      ['When', 'Item', 'SKU', 'Location', 'Change', 'After', 'Reason', 'Reference', 'Note', 'By'],
      all.map((m) => [
        (m.at as Date).toISOString(), m.item, m.sku, m.location, m.delta, m.after, m.reason, m.ref, m.note, m.by,
      ]),
    );
  }

  async exportItems(companyId: number, f: ItemFilters) {
    const out: unknown[][] = [];
    for (let p = 1; p <= 100; p++) {
      const r = await this.list(companyId, { ...f, page: p, limit: 200 });
      for (const i of r.data) {
        out.push([
          i.title, i.variantTitle, i.sku, i.itemCode, i.barcode, i.category, i.shelfLocation,
          i.listings.map((l) => l.storeLabel).join(' | '),
          i.available, i.committed, i.incoming, i.onHand, i.reorderLevel, i.avgCost, i.priceMin, i.status, i.sold30,
        ]);
      }
      if (r.data.length < 200) break;
    }
    return toCsv(
      ['Product', 'Variant', 'SKU', 'Item code', 'Barcode', 'Category', 'Shelf', 'Stores', 'Available', 'Committed', 'Incoming', 'On hand', 'Reorder at', 'Avg cost', 'Price', 'Status', 'Sold 30d'],
      out,
    );
  }

  // ── Locations ────────────────────────────────────────────────────────────

  async locations(companyId: number) {
    const [locs, stores] = await Promise.all([
      this.prisma.inventoryLocation.findMany({
        where: { company_id: companyId },
        include: { links: true },
        orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.shopifyStore.findMany({ where: { company_id: companyId }, select: { id: true, label: true, shop_domain: true, provider: true } }),
    ]);
    const sBy = new Map(stores.map((s) => [s.id, s]));
    return locs.map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      isActive: l.is_active,
      isDefault: l.is_default,
      links: l.links.map((k) => ({
        id: k.id,
        storeId: k.store_id,
        storeLabel: sBy.get(k.store_id)?.label || sBy.get(k.store_id)?.shop_domain || `Store ${k.store_id}`,
        externalName: k.external_name,
        syncEnabled: k.sync_enabled,
      })),
    }));
  }

  async saveLocation(companyId: number, id: number | null, dto: { name?: string; address?: string | null; isActive?: boolean; isDefault?: boolean }) {
    if (id) await this.assertLocation(companyId, id);
    const data = {
      ...(dto.name !== undefined ? { name: dto.name.trim().slice(0, 120) || 'Location' } : {}),
      ...(dto.address !== undefined ? { address: dto.address?.trim() || null } : {}),
      ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
    };
    const loc = id
      ? await this.prisma.inventoryLocation.update({ where: { id }, data })
      : await this.prisma.inventoryLocation.create({ data: { company_id: companyId, name: dto.name?.trim() || 'New location', address: dto.address ?? null } });
    if (dto.isDefault) {
      await this.prisma.inventoryLocation.updateMany({ where: { company_id: companyId }, data: { is_default: false } });
      await this.prisma.inventoryLocation.update({ where: { id: loc.id }, data: { is_default: true } });
    }
    return this.locations(companyId);
  }

  /** Re-map a store location onto another of our locations, or stop syncing it. */
  async updateLink(companyId: number, linkId: number, dto: { locationId?: number; syncEnabled?: boolean }) {
    const link = await this.prisma.inventoryLocationLink.findFirst({ where: { id: linkId, company_id: companyId } });
    if (!link) throw new NotFoundException('Link not found');
    if (dto.locationId) await this.assertLocation(companyId, dto.locationId);
    await this.prisma.inventoryLocationLink.update({
      where: { id: linkId },
      data: {
        ...(dto.locationId ? { location_id: dto.locationId } : {}),
        ...(dto.syncEnabled !== undefined ? { sync_enabled: dto.syncEnabled } : {}),
      },
    });
    // re-read the store so the (new) location's pool reflects it
    await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'syncStore', companyId, storeId: link.store_id }, { dedupKey: `inv2-sync:${companyId}:${link.store_id}` });
    return this.locations(companyId);
  }

  // ── Sync + settings ──────────────────────────────────────────────────────

  async requestSync(companyId: number, storeId?: number) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_v2_at: true } });
    if (!company?.inventory_v2_at) {
      await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'bootstrap', companyId }, { dedupKey: `inv2-boot:${companyId}` });
      return { started: true, bootstrap: true };
    }
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: companyId, status: 'active', ...(storeId ? { id: storeId } : {}) },
      select: { id: true },
    });
    for (const s of stores) {
      await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'syncStore', companyId, storeId: s.id }, { dedupKey: `inv2-sync:${companyId}:${s.id}` });
    }
    return { started: true, stores: stores.length };
  }

  async syncStatus(companyId: number) {
    const [company, stores, jobs] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_v2_at: true } }),
      this.prisma.$queryRaw<Array<{ store_id: number; last: Date | null }>>`
        SELECT p.shopify_store_id AS store_id, MAX(p.synced_at) AS last FROM inventory_products p
        WHERE p.company_id = ${companyId} GROUP BY p.shopify_store_id`,
      this.prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*) AS c FROM jobs WHERE queue_name = 'inventory' AND status IN ('pending','processing')
          AND JSON_EXTRACT(payload, '$.companyId') = ${companyId}
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.kind')) IN ('bootstrap','syncStore')`.catch(() => [{ c: BigInt(0) }]),
    ]);
    return {
      ready: !!company?.inventory_v2_at,
      running: Number(jobs[0]?.c ?? 0) > 0,
      stores: stores.map((s) => ({ storeId: Number(s.store_id), lastSyncedAt: s.last })),
    };
  }

  async settings(companyId: number) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_settings: true, inventory_restock_returns: true } });
    return { ...resolveInventorySettings(c?.inventory_settings), restockReturns: !!c?.inventory_restock_returns };
  }

  async saveSettings(companyId: number, patch: Record<string, unknown>) {
    const cur = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_settings: true } });
    const { restockReturns, ...rest } = patch;
    const merged = resolveInventorySettings({ ...((cur?.inventory_settings as object) ?? {}), ...rest });
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        inventory_settings: merged as unknown as Prisma.InputJsonValue,
        ...(typeof restockReturns === 'boolean' ? { inventory_restock_returns: restockReturns } : {}),
      },
    });
    return this.settings(companyId);
  }

  // ── Lookup (agents: create-order modal, item editor, AI) ─────────────────

  /**
   * Store-scoped stock for selling surfaces. With variantGids, returns the
   * pool availability for those exact store variants (keyed by gid).
   */
  async availability(companyId: number, opts: { storeId?: number; variantGids?: string[]; q?: string }) {
    const settings = await this.settings(companyId);
    const where: Prisma.InventoryVariantWhereInput = {
      company_id: companyId,
      item_id: { not: null },
      ...(opts.storeId ? { shopify_store_id: opts.storeId } : {}),
      ...(opts.variantGids?.length ? { shopify_variant_gid: { in: opts.variantGids.slice(0, 200) } } : {}),
    };
    if (!opts.variantGids?.length) {
      const q = clampQuery(opts.q);
      if (!q) return { allowBackorder: settings.allowBackorder, items: [] };
      where.OR = [
        { sku: { contains: q } },
        { barcode: { contains: q } },
        { item: { item_code: { contains: q } } },
        { item: { alias: { contains: q } } },
        { product: { title: { contains: q } } },
      ];
    }
    const rows = await this.prisma.inventoryVariant.findMany({
      where,
      take: 50,
      include: {
        product: { select: { title: true, image_url: true, status: true } },
        item: { select: { id: true, item_code: true, alias: true, shelf_location: true, track: true, allow_backorder: true, is_bundle: true, bundle_components: true } },
      },
    });
    const itemIds = [...new Set(rows.map((r) => r.item_id!))];
    const bundleComp = new Set<number>();
    rows.forEach((r) => r.item?.is_bundle && this.components(r.item.bundle_components).forEach((c) => bundleComp.add(c.itemId)));
    const allIds = [...new Set([...itemIds, ...bundleComp])];
    const lv = allIds.length
      ? await this.prisma.inventoryLevel.groupBy({ by: ['item_id'], where: { item_id: { in: allIds } }, _sum: { available: true } })
      : [];
    const avBy = new Map(lv.map((l) => [l.item_id, l._sum.available ?? 0]));
    return {
      allowBackorder: settings.allowBackorder,
      items: rows.map((r) => {
        const it = r.item!;
        const available = it.is_bundle
          ? buildable(this.components(it.bundle_components).map((c) => ({ quantity: c.quantity, available: avBy.get(c.itemId) ?? 0 })))
          : avBy.get(it.id) ?? 0;
        return {
          variantId: r.shopify_variant_gid,
          storeId: r.shopify_store_id,
          itemId: it.id,
          productTitle: r.product.title,
          variantTitle: r.variant_title,
          sku: r.sku,
          itemCode: it.item_code,
          alias: it.alias,
          shelf: it.shelf_location,
          image: r.product.image_url,
          price: r.price != null ? String(r.price) : null,
          tracked: it.track,
          available,
          sellable: !it.track || available > 0 || it.allow_backorder || settings.allowBackorder,
          productStatus: r.product.status,
        };
      }),
    };
  }

  // ── Back-in-stock waitlist ───────────────────────────────────────────────

  /** A customer asked for an out-of-stock item (from a chat). Idempotent. */
  async addToWaitlist(companyId: number, dto: { variantGid?: string; itemId?: number; conversationId?: number; contactId?: number }, userId: number) {
    let itemId = dto.itemId ?? null;
    if (!itemId && dto.variantGid) {
      const v = await this.prisma.inventoryVariant.findFirst({
        where: { company_id: companyId, shopify_variant_gid: dto.variantGid, item_id: { not: null } },
        select: { item_id: true },
      });
      itemId = v?.item_id ?? null;
    }
    if (!itemId) throw new BadRequestException('This product is not in inventory yet');
    let contactId = dto.contactId ?? null;
    if (!contactId && dto.conversationId) {
      const c = await this.prisma.conversation.findFirst({ where: { id: dto.conversationId, company_id: companyId }, select: { contact_id: true } });
      contactId = c?.contact_id ?? null;
    }
    if (!contactId) throw new BadRequestException('No customer to add');
    await this.prisma.stockWaitlist.upsert({
      where: { company_id_item_id_contact_id: { company_id: companyId, item_id: itemId, contact_id: contactId } },
      create: { company_id: companyId, item_id: itemId, contact_id: contactId, added_by: userId },
      update: { notified_at: null },
    });
    return { ok: true, itemId };
  }

  async waitlist(companyId: number, itemId: number) {
    const rows = await this.prisma.stockWaitlist.findMany({
      where: { company_id: companyId, item_id: itemId, notified_at: null },
      orderBy: { created_at: 'asc' },
      take: 500,
    });
    const contacts = rows.length
      ? await this.prisma.contact.findMany({ where: { company_id: companyId, id: { in: rows.map((r) => r.contact_id) } }, select: { id: true, name: true, phone: true } })
      : [];
    const cBy = new Map(contacts.map((c) => [c.id, c]));
    return rows.map((r) => ({ contactId: r.contact_id, name: cBy.get(r.contact_id)?.name ?? null, phone: cBy.get(r.contact_id)?.phone ?? null, since: r.created_at }));
  }

  /** After messaging them (broadcast), clear the list. */
  async markWaitlistNotified(companyId: number, itemId: number) {
    const r = await this.prisma.stockWaitlist.updateMany({ where: { company_id: companyId, item_id: itemId, notified_at: null }, data: { notified_at: new Date() } });
    return { cleared: r.count };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async assertItem(companyId: number, id: number) {
    const it = await this.prisma.inventoryItem.findFirst({ where: { id, company_id: companyId }, select: { id: true } });
    if (!it) throw new NotFoundException('Item not found');
  }

  private async assertLocation(companyId: number, id: number) {
    const l = await this.prisma.inventoryLocation.findFirst({ where: { id, company_id: companyId }, select: { id: true } });
    if (!l) throw new BadRequestException('Location not found');
  }

  async defaultLocation(companyId: number): Promise<number | null> {
    const l = await this.prisma.inventoryLocation.findFirst({
      where: { company_id: companyId, is_active: true },
      orderBy: [{ is_default: 'desc' }, { id: 'asc' }],
      select: { id: true },
    });
    return l?.id ?? null;
  }
}
