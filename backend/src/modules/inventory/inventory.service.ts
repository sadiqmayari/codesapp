import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureService } from '../../common/services/feature.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { UpdateVariantDto } from './dto/inventory.dto';

type StockStatus = 'in' | 'low' | 'out';

interface RawRow {
  id: number;
  shopify_store_id: number;
  shopify_variant_gid: string;
  sku: string | null;
  barcode: string | null;
  variant_title: string | null;
  price: string | number | null;
  shopify_qty: number;
  local_qty: number;
  reorder_level: number;
  cost_price: string | number | null;
  shelf_location: string | null;
  category: string | null;
  notes: string | null;
  item_code: string | null;
  alias: string | null;
  qty_synced_at: Date | null;
  last_pushed_at: Date | null;
  product_title: string;
  image_url: string | null;
  handle: string | null;
  product_type: string | null;
  vendor: string | null;
}

const num = (v: string | number | null): number | null =>
  v == null ? null : Number(v);

const statusOf = (localQty: number, reorder: number): StockStatus =>
  localQty <= 0 ? 'out' : localQty <= reorder ? 'low' : 'in';

/**
 * Inventory module service. Owns the local mirror tables (CRUD / list / stats /
 * ledger) and enqueues Shopify I/O on the `shopify` queue (ShopifyService does
 * the actual GraphQL). Every query is scoped by company_id. Leaf module — all
 * injected services come from the @Global CommonModule.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feature: FeatureService,
    private readonly jobQueue: JobQueueService,
  ) {}

  async assertEnabled(companyId: number): Promise<void> {
    const on = await this.feature.inventoryEnabled(companyId);
    if (!on) throw new ForbiddenException('Inventory module is not enabled');
  }

  private mapRow(r: RawRow) {
    const localQty = Number(r.local_qty);
    const reorder = Number(r.reorder_level);
    return {
      id: Number(r.id),
      storeId: r.shopify_store_id,
      variantGid: r.shopify_variant_gid,
      productTitle: r.product_title,
      variantTitle: r.variant_title,
      image: r.image_url,
      handle: r.handle,
      productType: r.product_type,
      vendor: r.vendor,
      sku: r.sku,
      barcode: r.barcode,
      price: num(r.price),
      shopifyQty: Number(r.shopify_qty),
      localQty,
      reorderLevel: reorder,
      costPrice: num(r.cost_price),
      shelfLocation: r.shelf_location,
      category: r.category,
      notes: r.notes,
      itemCode: r.item_code,
      alias: r.alias,
      status: statusOf(localQty, reorder),
      dirty: localQty !== Number(r.shopify_qty),
      qtySyncedAt: r.qty_synced_at,
      lastPushedAt: r.last_pushed_at,
    };
  }

  private buildWhere(
    companyId: number,
    opts: { storeId?: number; search?: string; status?: string; category?: string },
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`v.company_id = ${companyId}`];
    if (opts.storeId) parts.push(Prisma.sql`v.shopify_store_id = ${opts.storeId}`);
    if (opts.category) parts.push(Prisma.sql`v.category = ${opts.category}`);
    const q = (opts.search ?? '').trim();
    if (q) {
      const like = `%${q}%`;
      parts.push(
        Prisma.sql`(p.title LIKE ${like} OR v.sku LIKE ${like} OR v.item_code LIKE ${like} OR v.alias LIKE ${like} OR v.barcode LIKE ${like} OR v.variant_title LIKE ${like})`,
      );
    }
    if (opts.status === 'out') parts.push(Prisma.sql`v.local_qty <= 0`);
    else if (opts.status === 'low')
      parts.push(Prisma.sql`(v.local_qty > 0 AND v.local_qty <= v.reorder_level)`);
    else if (opts.status === 'in')
      parts.push(Prisma.sql`v.local_qty > v.reorder_level`);
    return Prisma.join(parts, ' AND ');
  }

  /** Paged list for the Inventory board. Returns the envelope shape with meta. */
  async list(
    companyId: number,
    opts: {
      storeId?: number;
      search?: string;
      status?: string;
      category?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 50));
    const offset = (page - 1) * limit;
    const where = this.buildWhere(companyId, opts);
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT v.id, v.shopify_store_id, v.shopify_variant_gid, v.sku, v.barcode,
             v.variant_title, v.price, v.shopify_qty, v.local_qty, v.reorder_level,
             v.cost_price, v.shelf_location, v.category, v.notes, v.item_code,
             v.alias, v.qty_synced_at, v.last_pushed_at,
             p.title AS product_title, p.image_url, p.handle, p.product_type, p.vendor
      FROM inventory_variants v
      JOIN inventory_products p ON v.product_id = p.id
      WHERE ${where}
      ORDER BY p.title ASC, v.id ASC
      LIMIT ${limit} OFFSET ${offset}`;
    const countRows = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM inventory_variants v
      JOIN inventory_products p ON v.product_id = p.id
      WHERE ${where}`;
    const total = Number(countRows[0]?.cnt ?? 0);
    return {
      success: true,
      data: rows.map((r) => this.mapRow(r)),
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async stats(companyId: number, storeId?: number) {
    const storeFilter = storeId
      ? Prisma.sql`AND v.shopify_store_id = ${storeId}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        skus: bigint;
        units: bigint | number | null;
        out_count: bigint | number | null;
        low_count: bigint | number | null;
        stock_value: string | number | null;
      }[]
    >`
      SELECT
        COUNT(*) AS skus,
        COALESCE(SUM(GREATEST(v.local_qty, 0)), 0) AS units,
        COALESCE(SUM(CASE WHEN v.local_qty <= 0 THEN 1 ELSE 0 END), 0) AS out_count,
        COALESCE(SUM(CASE WHEN v.local_qty > 0 AND v.local_qty <= v.reorder_level THEN 1 ELSE 0 END), 0) AS low_count,
        COALESCE(SUM(GREATEST(v.local_qty, 0) * COALESCE(v.cost_price, 0)), 0) AS stock_value
      FROM inventory_variants v
      WHERE v.company_id = ${companyId} ${storeFilter}`;
    const r = rows[0];
    return {
      skus: Number(r?.skus ?? 0),
      units: Number(r?.units ?? 0),
      outCount: Number(r?.out_count ?? 0),
      lowCount: Number(r?.low_count ?? 0),
      stockValue: Number(r?.stock_value ?? 0),
    };
  }

  async categories(companyId: number, storeId?: number): Promise<string[]> {
    const rows = await this.prisma.inventoryVariant.findMany({
      where: {
        company_id: companyId,
        ...(storeId ? { shopify_store_id: storeId } : {}),
        category: { not: null },
      },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
      take: 500,
    });
    return rows
      .map((r) => (r.category ?? '').trim())
      .filter((c) => c.length > 0);
  }

  /** Variant hits for the inbox create-order modal (search by code/alias/sku). */
  async lookup(companyId: number, q: string, storeId?: number) {
    const term = (q ?? '').trim();
    if (!term) return [];
    const where = this.buildWhere(companyId, { storeId, search: term });
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT v.id, v.shopify_store_id, v.shopify_variant_gid, v.sku, v.barcode,
             v.variant_title, v.price, v.shopify_qty, v.local_qty, v.reorder_level,
             v.cost_price, v.shelf_location, v.category, v.notes, v.item_code,
             v.alias, v.qty_synced_at, v.last_pushed_at,
             p.title AS product_title, p.image_url, p.handle, p.product_type, p.vendor
      FROM inventory_variants v
      JOIN inventory_products p ON v.product_id = p.id
      WHERE ${where}
      ORDER BY p.title ASC
      LIMIT 20`;
    return rows.map((r) => {
      const m = this.mapRow(r);
      return {
        variantId: m.variantGid,
        productTitle: m.productTitle,
        variantTitle: m.variantTitle,
        price: m.price != null ? String(m.price) : null,
        sku: m.sku,
        itemCode: m.itemCode,
        alias: m.alias,
        image: m.image,
        localQty: m.localQty,
        status: m.status,
        available: m.localQty > 0,
      };
    });
  }

  /** Single variant + its movement timeline. */
  async getVariant(companyId: number, id: number) {
    const v = await this.prisma.inventoryVariant.findFirst({
      where: { id, company_id: companyId },
      include: { product: true },
    });
    if (!v) throw new NotFoundException('Variant not found');
    const movements = await this.prisma.inventoryMovement.findMany({
      where: { company_id: companyId, variant_id: id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      id: v.id,
      storeId: v.shopify_store_id,
      variantGid: v.shopify_variant_gid,
      productTitle: v.product.title,
      variantTitle: v.variant_title,
      image: v.product.image_url,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price != null ? Number(v.price) : null,
      shopifyQty: v.shopify_qty,
      localQty: v.local_qty,
      reorderLevel: v.reorder_level,
      costPrice: v.cost_price != null ? Number(v.cost_price) : null,
      shelfLocation: v.shelf_location,
      category: v.category,
      notes: v.notes,
      itemCode: v.item_code,
      alias: v.alias,
      status: statusOf(v.local_qty, v.reorder_level),
      dirty: v.local_qty !== v.shopify_qty,
      qtySyncedAt: v.qty_synced_at,
      lastPushedAt: v.last_pushed_at,
      movements: movements.map((mv) => ({
        id: mv.id,
        delta: mv.delta,
        qtyAfter: mv.qty_after,
        reason: mv.reason,
        ref: mv.ref,
        actorUserId: mv.actor_user_id,
        createdAt: mv.created_at,
      })),
    };
  }

  private cleanStr(v: string | null | undefined): string | null {
    if (v == null) return null;
    const t = v.trim();
    return t.length ? t : null;
  }

  /**
   * Update a variant's CodesApp fields and/or local_qty. A qty change writes a
   * manual_adjust movement and enqueues a Shopify push (two-way sync, push leg).
   */
  async updateVariant(
    companyId: number,
    id: number,
    dto: UpdateVariantDto,
    actorUserId?: number,
  ) {
    const v = await this.prisma.inventoryVariant.findFirst({
      where: { id, company_id: companyId },
    });
    if (!v) throw new NotFoundException('Variant not found');

    const data: Prisma.InventoryVariantUpdateInput = {};
    if (dto.item_code !== undefined) data.item_code = this.cleanStr(dto.item_code);
    if (dto.alias !== undefined) data.alias = this.cleanStr(dto.alias);
    if (dto.reorder_level !== undefined) data.reorder_level = dto.reorder_level;
    if (dto.cost_price !== undefined)
      data.cost_price = dto.cost_price == null ? null : dto.cost_price;
    if (dto.shelf_location !== undefined)
      data.shelf_location = this.cleanStr(dto.shelf_location);
    if (dto.category !== undefined) data.category = this.cleanStr(dto.category);
    if (dto.notes !== undefined) data.notes = this.cleanStr(dto.notes);

    let qtyChanged = false;
    if (dto.local_qty !== undefined && dto.local_qty !== v.local_qty) {
      data.local_qty = dto.local_qty;
      qtyChanged = true;
    }

    await this.prisma.inventoryVariant.update({ where: { id: v.id }, data });

    if (qtyChanged) {
      await this.prisma.inventoryMovement.create({
        data: {
          company_id: companyId,
          shopify_store_id: v.shopify_store_id,
          variant_id: v.id,
          delta: dto.local_qty! - v.local_qty,
          qty_after: dto.local_qty!,
          reason: 'manual_adjust',
          actor_user_id: actorUserId ?? null,
        },
      });
      await this.enqueuePush(companyId, v.id);
    }
    return this.getVariant(companyId, id);
  }

  private async enqueuePush(companyId: number, variantId: number) {
    await this.jobQueue.enqueue(
      'shopify',
      { kind: 'pushQty', companyId, variantId },
      { dedupKey: `inv-push:${variantId}`, maxAttempts: 2 },
    );
  }

  /** Explicit per-row push (re-send local_qty even if already in sync). */
  async pushVariant(companyId: number, id: number) {
    const v = await this.prisma.inventoryVariant.findFirst({
      where: { id, company_id: companyId },
      select: { id: true },
    });
    if (!v) throw new NotFoundException('Variant not found');
    await this.enqueuePush(companyId, id);
    return { queued: true };
  }

  /** Push every variant whose local_qty differs from the last-known Shopify qty. */
  async pushChanged(companyId: number, storeId?: number) {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT v.id FROM inventory_variants v
      WHERE v.company_id = ${companyId}
        ${storeId ? Prisma.sql`AND v.shopify_store_id = ${storeId}` : Prisma.empty}
        AND v.local_qty <> v.shopify_qty
      LIMIT 2000`;
    for (const r of rows) await this.enqueuePush(companyId, Number(r.id));
    return { queued: rows.length };
  }

  /** Kick off a background catalogue sync (never inline — exceeds HTTP timeout). */
  async requestSync(companyId: number, storeId?: number) {
    await this.jobQueue.enqueue(
      'shopify',
      { kind: 'syncInventory', companyId, storeId: storeId ?? null },
      { dedupKey: `inv-sync:${companyId}:${storeId ?? 'primary'}`, maxAttempts: 1 },
    );
    return { started: true };
  }

  async syncStatus(companyId: number, storeId?: number) {
    const where = {
      company_id: companyId,
      ...(storeId ? { shopify_store_id: storeId } : {}),
    };
    const [products, variants, last] = await Promise.all([
      this.prisma.inventoryProduct.count({ where }),
      this.prisma.inventoryVariant.count({ where }),
      this.prisma.inventoryVariant.findFirst({
        where,
        orderBy: { qty_synced_at: 'desc' },
        select: { qty_synced_at: true },
      }),
    ]);
    return { products, variants, lastSyncedAt: last?.qty_synced_at ?? null };
  }

  /** CSV export of the whole catalogue (or one store). */
  async exportCsv(companyId: number, storeId?: number): Promise<string> {
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT v.id, v.shopify_store_id, v.shopify_variant_gid, v.sku, v.barcode,
             v.variant_title, v.price, v.shopify_qty, v.local_qty, v.reorder_level,
             v.cost_price, v.shelf_location, v.category, v.notes, v.item_code,
             v.alias, v.qty_synced_at, v.last_pushed_at,
             p.title AS product_title, p.image_url, p.handle, p.product_type, p.vendor
      FROM inventory_variants v
      JOIN inventory_products p ON v.product_id = p.id
      WHERE v.company_id = ${companyId}
        ${storeId ? Prisma.sql`AND v.shopify_store_id = ${storeId}` : Prisma.empty}
      ORDER BY p.title ASC`;
    const header = [
      'Product',
      'Variant',
      'SKU',
      'Item Code',
      'Alias',
      'Category',
      'Shelf',
      'Price',
      'Cost',
      'Reorder level',
      'Shopify qty',
      'CodesApp qty',
      'Status',
    ];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      const m = this.mapRow(r);
      lines.push(
        [
          m.productTitle,
          m.variantTitle,
          m.sku,
          m.itemCode,
          m.alias,
          m.category,
          m.shelfLocation,
          m.price,
          m.costPrice,
          m.reorderLevel,
          m.shopifyQty,
          m.localQty,
          m.status,
        ]
          .map(esc)
          .join(','),
      );
    }
    return lines.join('\n');
  }
}
