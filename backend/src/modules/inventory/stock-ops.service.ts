import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { clampQuery, likeContains } from '../../common/utils/search';
import { InventoryLedgerService, INVENTORY_QUEUE } from './core/inventory-ledger.service';
import { spreadLanded, weightedAverage } from './core/cost-math';
import { suggestReorder } from './core/stock-math';
import { normBarcode, normSku } from './core/sku';
import { resolveInventorySettings } from './core/settings';

const money = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * Warehouse operations on top of the ledger: stock counts, transfers between
 * locations, CSV stock import, suppliers, purchase orders + receiving
 * (landed + weighted-average cost) and reorder suggestions.
 */
@Injectable()
export class StockOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly cache: CacheService,
    private readonly jobQueue: JobQueueService,
  ) {}

  // ── shared ───────────────────────────────────────────────────────────────

  private async nextNumber(companyId: number, prefix: string, table: 'stock_counts' | 'stock_transfers' | 'purchase_orders' | 'goods_receipts'): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: string | null }>>(
      `SELECT MAX(CAST(SUBSTRING(number, ${prefix.length + 2}) AS UNSIGNED)) AS n FROM ${table} WHERE company_id = ? AND number LIKE ?`,
      companyId,
      `${prefix}-%`,
    );
    const next = Number(rows[0]?.n ?? 0) + 1;
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  private async assertLocation(companyId: number, id: number) {
    const l = await this.prisma.inventoryLocation.findFirst({ where: { id, company_id: companyId }, select: { id: true, name: true } });
    if (!l) throw new BadRequestException('Location not found');
    return l;
  }

  /** Scan / typed code → item (barcode, SKU, item code; master item or any listing). */
  async resolveCode(companyId: number, code: string) {
    const c = (code ?? '').trim();
    if (!c) return null;
    const sku = normSku(c);
    const bc = normBarcode(c);
    const item = await this.prisma.inventoryItem.findFirst({
      where: {
        company_id: companyId,
        archived_at: null,
        OR: [{ item_code: c }, ...(sku ? [{ sku }] : []), ...(bc ? [{ barcode: bc }, { barcode: c }] : [])],
      },
      select: { id: true },
    });
    if (item) return item.id;
    const listing = await this.prisma.inventoryVariant.findFirst({
      where: { company_id: companyId, item_id: { not: null }, OR: [{ sku: c }, { barcode: c }, ...(bc ? [{ barcode: bc }] : [])] },
      select: { item_id: true },
    });
    return listing?.item_id ?? null;
  }

  private async itemNames(companyId: number, ids: number[]) {
    if (!ids.length) return new Map<number, { title: string; sku: string | null; image: string | null; shelf: string | null; avgCost: number | null }>();
    const rows = await this.prisma.inventoryItem.findMany({
      where: { company_id: companyId, id: { in: ids } },
      select: { id: true, title: true, variant_title: true, sku: true, image_url: true, shelf_location: true, avg_cost: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: [r.title, r.variant_title && r.variant_title !== 'Default Title' ? r.variant_title : null].filter(Boolean).join(' · '),
          sku: r.sku,
          image: r.image_url,
          shelf: r.shelf_location,
          avgCost: r.avg_cost != null ? Number(r.avg_cost) : null,
        },
      ]),
    );
  }

  private async onHandAt(itemId: number, locationId: number): Promise<number> {
    const l = await this.prisma.inventoryLevel.findUnique({
      where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
      select: { available: true, committed: true },
    });
    return (l?.available ?? 0) + (l?.committed ?? 0);
  }

  /** Lightweight item search for warehouse screens (no cost / prices). */
  async stockSearch(companyId: number, q: string) {
    const term = clampQuery(q);
    if (!term) return [];
    const like = likeContains(term);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: number; title: string; variant_title: string | null; sku: string | null; image_url: string | null; shelf_location: string | null; is_bundle: number; available: string | number }>
    >`
      SELECT i.id, i.title, i.variant_title, i.sku, i.image_url, i.shelf_location, i.is_bundle, COALESCE(SUM(l.available), 0) AS available
      FROM inventory_items i LEFT JOIN inventory_levels l ON l.item_id = i.id
      WHERE i.company_id = ${companyId} AND i.archived_at IS NULL
        AND (i.title LIKE ${like} OR i.variant_title LIKE ${like} OR i.sku LIKE ${like} OR i.item_code LIKE ${like} OR i.barcode LIKE ${like})
      GROUP BY i.id ORDER BY i.title LIMIT 15`;
    return rows.map((r) => ({
      id: Number(r.id), title: r.title, variantTitle: r.variant_title, sku: r.sku, image: r.image_url,
      shelfLocation: r.shelf_location, isBundle: !!Number(r.is_bundle), available: Number(r.available),
    }));
  }

  // ── Stock counts ─────────────────────────────────────────────────────────

  async listCounts(companyId: number) {
    const rows = await this.prisma.stockCount.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { lines: { select: { expected: true, counted: true } } },
    });
    const locs = await this.prisma.inventoryLocation.findMany({ where: { company_id: companyId }, select: { id: true, name: true } });
    const lBy = new Map(locs.map((l) => [l.id, l.name]));
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      location: lBy.get(r.location_id) ?? '—',
      scope: r.scope,
      blind: r.blind,
      lines: r.lines.length,
      counted: r.lines.filter((l) => l.counted != null).length,
      variance: r.lines.reduce((a, l) => a + (l.counted != null ? l.counted - l.expected : 0), 0),
      createdAt: r.created_at,
      appliedAt: r.applied_at,
    }));
  }

  async createCount(companyId: number, dto: { locationId: number; blind?: boolean; scope?: string | null; itemIds?: number[] }, userId: number) {
    await this.assertLocation(companyId, dto.locationId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const number = await this.nextNumber(companyId, 'CNT', 'stock_counts');
        const count = await this.prisma.stockCount.create({
          data: { company_id: companyId, number, location_id: dto.locationId, blind: dto.blind ?? true, scope: dto.scope?.trim() || null, started_by: userId },
        });
        // optional pre-filled scope (e.g. a shelf or the A-class nudge)
        for (const itemId of (dto.itemIds ?? []).slice(0, 2000)) {
          await this.prisma.stockCountLine.create({
            data: { company_id: companyId, count_id: count.id, item_id: itemId, expected: await this.onHandAt(itemId, dto.locationId) },
          }).catch(() => undefined);
        }
        return this.getCount(companyId, count.id, true);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new BadRequestException('Could not number the count — try again');
  }

  async getCount(companyId: number, id: number, privileged: boolean) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, company_id: companyId }, include: { lines: { orderBy: { updated_at: 'desc' } } } });
    if (!c) throw new NotFoundException('Count not found');
    const names = await this.itemNames(companyId, c.lines.map((l) => l.item_id));
    const loc = await this.prisma.inventoryLocation.findUnique({ where: { id: c.location_id }, select: { name: true } });
    // blind: counters never see the expected number until a manager reviews
    const showExpected = !c.blind || privileged || c.status !== 'draft';
    return {
      id: c.id,
      number: c.number,
      status: c.status,
      blind: c.blind,
      scope: c.scope,
      locationId: c.location_id,
      location: loc?.name ?? '—',
      appliedAt: c.applied_at,
      lines: c.lines.map((l) => {
        const n = names.get(l.item_id);
        return {
          itemId: l.item_id,
          title: n?.title ?? 'Item',
          sku: n?.sku ?? null,
          shelf: n?.shelf ?? null,
          image: n?.image ?? null,
          unitCost: n?.avgCost ?? null,
          expected: showExpected ? l.expected : null,
          counted: l.counted,
          variance: showExpected && l.counted != null ? l.counted - l.expected : null,
          reason: l.reason,
        };
      }),
    };
  }

  /** One scan = +1 (or `qty`). Unknown codes 404 with the code so the counter can fix it. */
  async scanCount(companyId: number, id: number, dto: { code?: string; itemId?: number; qty?: number }, privileged: boolean) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, company_id: companyId } });
    if (!c) throw new NotFoundException('Count not found');
    if (c.status !== 'draft') throw new BadRequestException('This count is already closed');
    const itemId = dto.itemId ?? (await this.resolveCode(companyId, dto.code ?? ''));
    if (!itemId) throw new NotFoundException(`No item with code “${(dto.code ?? '').slice(0, 60)}”`);
    const qty = Math.trunc(dto.qty ?? 1) || 1;
    const line = await this.prisma.stockCountLine.findUnique({ where: { count_id_item_id: { count_id: id, item_id: itemId } } });
    if (line) {
      await this.prisma.stockCountLine.update({ where: { id: line.id }, data: { counted: Math.max(0, (line.counted ?? 0) + qty) } });
    } else {
      await this.prisma.stockCountLine.create({
        data: { company_id: companyId, count_id: id, item_id: itemId, expected: await this.onHandAt(itemId, c.location_id), counted: Math.max(0, qty) },
      });
    }
    return this.getCount(companyId, id, privileged);
  }

  async setCountLine(companyId: number, id: number, itemId: number, dto: { counted: number | null; reason?: string | null }, privileged: boolean) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, company_id: companyId } });
    if (!c || c.status !== 'draft') throw new BadRequestException('This count is closed');
    await this.prisma.stockCountLine.upsert({
      where: { count_id_item_id: { count_id: id, item_id: itemId } },
      create: {
        company_id: companyId, count_id: id, item_id: itemId,
        expected: await this.onHandAt(itemId, c.location_id), counted: dto.counted, reason: dto.reason ?? null,
      },
      update: { counted: dto.counted, ...(dto.reason !== undefined ? { reason: dto.reason } : {}) },
    });
    return this.getCount(companyId, id, privileged);
  }

  /** Apply every counted line's variance (counted − snapshot) to the pool, once. */
  async applyCount(companyId: number, id: number, userId: number) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!c) throw new NotFoundException('Count not found');
    if (c.status !== 'draft') throw new BadRequestException('Already applied or cancelled');
    const lines = c.lines.filter((l) => l.counted != null && l.counted !== l.expected);
    if (lines.length) {
      await this.ledger.apply(
        companyId,
        lines.map((l) => ({ itemId: l.item_id, locationId: c.location_id, delta: (l.counted as number) - l.expected })),
        { reason: 'count', ref: c.number, refType: 'count', actorUserId: userId, idemKey: `count:${c.id}` },
      );
    }
    await this.prisma.stockCount.update({ where: { id }, data: { status: 'applied', applied_by: userId, applied_at: new Date() } });
    return { applied: lines.length };
  }

  async cancelCount(companyId: number, id: number) {
    const r = await this.prisma.stockCount.updateMany({ where: { id, company_id: companyId, status: 'draft' }, data: { status: 'cancelled' } });
    if (!r.count) throw new BadRequestException('Only an open count can be cancelled');
    return { ok: true };
  }

  // ── Transfers ────────────────────────────────────────────────────────────

  async listTransfers(companyId: number) {
    const rows = await this.prisma.stockTransfer.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { lines: true },
    });
    const locs = await this.prisma.inventoryLocation.findMany({ where: { company_id: companyId }, select: { id: true, name: true } });
    const lBy = new Map(locs.map((l) => [l.id, l.name]));
    return rows.map((t) => ({
      id: t.id,
      number: t.number,
      status: t.status,
      from: lBy.get(t.from_location_id) ?? '—',
      to: lBy.get(t.to_location_id) ?? '—',
      units: t.lines.reduce((a, l) => a + l.qty, 0),
      lines: t.lines.length,
      note: t.note,
      createdAt: t.created_at,
      sentAt: t.sent_at,
      receivedAt: t.received_at,
    }));
  }

  async createTransfer(companyId: number, dto: { fromLocationId: number; toLocationId: number; note?: string | null; lines: Array<{ itemId: number; qty: number }> }, userId: number) {
    if (dto.fromLocationId === dto.toLocationId) throw new BadRequestException('Pick two different locations');
    await this.assertLocation(companyId, dto.fromLocationId);
    await this.assertLocation(companyId, dto.toLocationId);
    const lines = (dto.lines ?? []).filter((l) => l.itemId && l.qty > 0);
    if (!lines.length) throw new BadRequestException('Add at least one item');
    const number = await this.nextNumber(companyId, 'TR', 'stock_transfers');
    const t = await this.prisma.stockTransfer.create({
      data: {
        company_id: companyId, number, from_location_id: dto.fromLocationId, to_location_id: dto.toLocationId,
        note: dto.note?.trim() || null, created_by: userId,
        lines: { create: lines.map((l) => ({ company_id: companyId, item_id: l.itemId, qty: Math.trunc(l.qty) })) },
      },
    });
    return this.getTransfer(companyId, t.id);
  }

  async getTransfer(companyId: number, id: number) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!t) throw new NotFoundException('Transfer not found');
    const names = await this.itemNames(companyId, t.lines.map((l) => l.item_id));
    const locs = await this.prisma.inventoryLocation.findMany({ where: { id: { in: [t.from_location_id, t.to_location_id] } }, select: { id: true, name: true } });
    const lBy = new Map(locs.map((l) => [l.id, l.name]));
    return {
      id: t.id, number: t.number, status: t.status, note: t.note,
      fromLocationId: t.from_location_id, toLocationId: t.to_location_id,
      from: lBy.get(t.from_location_id) ?? '—', to: lBy.get(t.to_location_id) ?? '—',
      sentAt: t.sent_at, receivedAt: t.received_at,
      lines: t.lines.map((l) => ({ itemId: l.item_id, qty: l.qty, title: names.get(l.item_id)?.title ?? 'Item', sku: names.get(l.item_id)?.sku ?? null })),
    };
  }

  async sendTransfer(companyId: number, id: number, userId: number) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!t || t.status !== 'draft') throw new BadRequestException('Only a draft transfer can be sent');
    await this.ledger.apply(
      companyId,
      t.lines.map((l) => ({ itemId: l.item_id, locationId: t.from_location_id, delta: -l.qty })),
      { reason: 'transfer_out', ref: t.number, refType: 'transfer', actorUserId: userId, idemKey: `transfer-out:${t.id}` },
    );
    await this.prisma.stockTransfer.update({ where: { id }, data: { status: 'in_transit', sent_at: new Date() } });
    return this.getTransfer(companyId, id);
  }

  async receiveTransfer(companyId: number, id: number, userId: number) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!t || t.status !== 'in_transit') throw new BadRequestException('Only an in-transit transfer can be received');
    await this.ledger.apply(
      companyId,
      t.lines.map((l) => ({ itemId: l.item_id, locationId: t.to_location_id, delta: l.qty })),
      { reason: 'transfer_in', ref: t.number, refType: 'transfer', actorUserId: userId, idemKey: `transfer-in:${t.id}` },
    );
    await this.prisma.stockTransfer.update({ where: { id }, data: { status: 'received', received_at: new Date() } });
    return this.getTransfer(companyId, id);
  }

  async cancelTransfer(companyId: number, id: number, userId: number) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!t || (t.status !== 'draft' && t.status !== 'in_transit')) throw new BadRequestException('This transfer can’t be cancelled');
    if (t.status === 'in_transit') {
      // put the stock back where it left
      await this.ledger.apply(
        companyId,
        t.lines.map((l) => ({ itemId: l.item_id, locationId: t.from_location_id, delta: l.qty })),
        { reason: 'transfer_in', ref: t.number, refType: 'transfer', note: 'Transfer cancelled', actorUserId: userId, idemKey: `transfer-cancel:${t.id}` },
      );
    }
    await this.prisma.stockTransfer.update({ where: { id }, data: { status: 'cancelled' } });
    return this.getTransfer(companyId, id);
  }

  // ── CSV import ───────────────────────────────────────────────────────────

  /**
   * Parse + resolve a stock CSV and return a preview (nothing applied).
   * Columns (any order, header aliases): sku | item code | barcode, then
   * available / qty / stock (SET) or change / adjust (ADD), optional cost.
   */
  async previewImport(companyId: number, buf: Buffer, opts: { locationId: number; mode: 'set' | 'adjust' }) {
    await this.assertLocation(companyId, opts.locationId);
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const delimiter = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    let records: Record<string, string>[];
    try {
      records = parse(text, { columns: true, skip_empty_lines: true, trim: true, delimiter, relax_column_count: true, relax_quotes: true });
    } catch {
      throw new BadRequestException('Could not read that file — save it as CSV and try again.');
    }
    if (records.length > 5000) throw new BadRequestException('Up to 5,000 rows per file.');
    const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
    const pick = (r: Record<string, string>, names: string[]) => {
      for (const [k, v] of Object.entries(r)) if (names.includes(key(k))) return (v ?? '').trim();
      return '';
    };
    const rows: Array<{ row: number; code: string; itemId: number | null; title: string | null; current: number | null; value: number | null; delta: number | null; cost: number | null; error: string | null }> = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const code = pick(r, ['sku', 'itemcode', 'code', 'barcode', 'ean', 'upc']);
      const rawQty = opts.mode === 'set' ? pick(r, ['available', 'qty', 'quantity', 'stock', 'onhand', 'count']) : pick(r, ['change', 'adjust', 'delta', 'add', 'qty', 'quantity']);
      const rawCost = pick(r, ['cost', 'unitcost', 'costprice']);
      const base = { row: i + 2, code, itemId: null as number | null, title: null as string | null, current: null as number | null, value: null as number | null, delta: null as number | null, cost: null as number | null, error: null as string | null };
      if (!code) {
        rows.push({ ...base, error: 'No SKU / item code / barcode' });
        continue;
      }
      const itemId = await this.resolveCode(companyId, code);
      if (!itemId) {
        rows.push({ ...base, error: 'No item with this code' });
        continue;
      }
      const lvl = await this.prisma.inventoryLevel.findUnique({ where: { item_id_location_id: { item_id: itemId, location_id: opts.locationId } }, select: { available: true } });
      const current = lvl?.available ?? 0;
      const q = rawQty.replace(/,/g, '');
      if (q !== '' && !(opts.mode === 'set' ? /^\d+$/ : /^-?\d+$/).test(q)) {
        rows.push({ ...base, itemId, current, error: `“${rawQty}” is not a whole number` });
        continue;
      }
      const cost = rawCost === '' ? null : Number(rawCost.replace(/,/g, ''));
      if (cost != null && !(cost >= 0)) {
        rows.push({ ...base, itemId, current, error: `Cost “${rawCost}” is not a number` });
        continue;
      }
      const value = q === '' ? null : Number(q);
      const delta = value == null ? null : opts.mode === 'set' ? value - current : value;
      rows.push({ ...base, itemId, current, value, delta, cost });
    }
    const names = await this.itemNames(companyId, rows.map((r) => r.itemId).filter((x): x is number => !!x));
    rows.forEach((r) => (r.title = r.itemId ? names.get(r.itemId)?.title ?? null : null));
    const token = crypto.randomUUID();
    const ok = rows.filter((r) => !r.error && ((r.delta ?? 0) !== 0 || r.cost != null));
    this.cache.set(`inv-import:${companyId}:${token}`, { locationId: opts.locationId, rows: ok }, 1800);
    return {
      token,
      mode: opts.mode,
      total: rows.length,
      changes: ok.length,
      errors: rows.filter((r) => r.error).length,
      rows: rows.slice(0, 1000),
    };
  }

  async applyImport(companyId: number, token: string, userId: number) {
    const plan = this.cache.get<{ locationId: number; rows: Array<{ itemId: number; delta: number | null; cost: number | null }> }>(`inv-import:${companyId}:${token}`);
    if (!plan) throw new BadRequestException('This preview expired — upload the file again.');
    const lines = plan.rows.filter((r) => r.delta).map((r) => ({ itemId: r.itemId, locationId: plan.locationId, delta: r.delta as number }));
    if (lines.length) {
      await this.ledger.apply(companyId, lines, { reason: 'import', refType: 'import', actorUserId: userId, idemKey: `import:${token}` });
    }
    let costs = 0;
    for (const r of plan.rows.filter((x) => x.cost != null)) {
      const it = await this.prisma.inventoryItem.findFirst({ where: { id: r.itemId, company_id: companyId }, select: { avg_cost: true } });
      if (!it || (it.avg_cost != null && Number(it.avg_cost) === r.cost)) continue;
      await this.prisma.inventoryItem.update({ where: { id: r.itemId }, data: { avg_cost: r.cost } });
      await this.prisma.inventoryCostHistory.create({
        data: { company_id: companyId, item_id: r.itemId, old_cost: it.avg_cost, new_cost: r.cost, source: 'import', actor_user_id: userId },
      });
      await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'pushCost', companyId, itemId: r.itemId }, { dedupKey: `inv2-cost:${r.itemId}` });
      costs++;
    }
    this.cache.del(`inv-import:${companyId}:${token}`);
    return { stockChanges: lines.length, costChanges: costs };
  }

  // ── Suppliers ────────────────────────────────────────────────────────────

  async listSuppliers(companyId: number, q?: string) {
    const term = clampQuery(q);
    const rows = await this.prisma.supplier.findMany({
      where: { company_id: companyId, archived_at: null, ...(term ? { name: { contains: term } } : {}) },
      orderBy: { name: 'asc' },
      include: { orders: { select: { status: true, paid_amount: true, freight: true, lines: { select: { qty_received: true, unit_cost: true } } } }, _count: { select: { items: true } } },
    });
    return rows.map((s) => {
      const received = s.orders.reduce((a, o) => a + o.lines.reduce((x, l) => x + l.qty_received * money(l.unit_cost), 0) + (o.status !== 'draft' ? money(o.freight) : 0), 0);
      const paid = s.orders.reduce((a, o) => a + money(o.paid_amount), 0);
      return {
        id: s.id, name: s.name, contactName: s.contact_name, phone: s.phone, email: s.email, address: s.address,
        notes: s.notes, leadTimeDays: s.lead_time_days, items: s._count.items,
        openOrders: s.orders.filter((o) => ['sent', 'partial'].includes(o.status)).length,
        balance: Math.round((received - paid) * 100) / 100,
      };
    });
  }

  async saveSupplier(companyId: number, id: number | null, dto: { name?: string; contactName?: string | null; phone?: string | null; email?: string | null; address?: string | null; notes?: string | null; leadTimeDays?: number | null; archived?: boolean }) {
    const clean = (s: string | null | undefined) => (s == null ? null : s.trim() || null);
    const data = {
      ...(dto.name !== undefined ? { name: dto.name.trim().slice(0, 160) } : {}),
      ...(dto.contactName !== undefined ? { contact_name: clean(dto.contactName) } : {}),
      ...(dto.phone !== undefined ? { phone: clean(dto.phone) } : {}),
      ...(dto.email !== undefined ? { email: clean(dto.email) } : {}),
      ...(dto.address !== undefined ? { address: clean(dto.address) } : {}),
      ...(dto.notes !== undefined ? { notes: clean(dto.notes) } : {}),
      ...(dto.leadTimeDays !== undefined ? { lead_time_days: dto.leadTimeDays } : {}),
      ...(dto.archived !== undefined ? { archived_at: dto.archived ? new Date() : null } : {}),
    };
    if (id) {
      const s = await this.prisma.supplier.findFirst({ where: { id, company_id: companyId } });
      if (!s) throw new NotFoundException('Supplier not found');
      await this.prisma.supplier.update({ where: { id }, data });
    } else {
      if (!dto.name?.trim()) throw new BadRequestException('Supplier name is required');
      await this.prisma.supplier.create({ data: { company_id: companyId, name: dto.name.trim().slice(0, 160), ...data } });
    }
    return this.listSuppliers(companyId);
  }

  // ── Purchase orders ──────────────────────────────────────────────────────

  async listPOs(companyId: number, f: { status?: string; q?: string }) {
    const term = clampQuery(f.q);
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        company_id: companyId,
        ...(f.status ? { status: f.status === 'open' ? { in: ['draft', 'sent', 'partial'] } : f.status } : {}),
        ...(term ? { OR: [{ number: { contains: term } }, { supplier: { name: { contains: term } } }] } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: 200,
      include: { supplier: { select: { name: true } }, lines: true },
    });
    const locs = await this.prisma.inventoryLocation.findMany({ where: { company_id: companyId }, select: { id: true, name: true } });
    const lBy = new Map(locs.map((l) => [l.id, l.name]));
    return rows.map((p) => ({
      id: p.id,
      number: p.number,
      status: p.status,
      supplier: p.supplier?.name ?? null,
      location: lBy.get(p.location_id) ?? '—',
      units: p.lines.reduce((a, l) => a + l.qty_ordered, 0),
      received: p.lines.reduce((a, l) => a + l.qty_received, 0),
      total: Math.round((p.lines.reduce((a, l) => a + l.qty_ordered * money(l.unit_cost), 0) + money(p.freight)) * 100) / 100,
      expectedAt: p.expected_at,
      createdAt: p.created_at,
    }));
  }

  async getPO(companyId: number, id: number) {
    const p = await this.prisma.purchaseOrder.findFirst({
      where: { id, company_id: companyId },
      include: { supplier: true, lines: true, receipts: { include: { lines: true }, orderBy: { created_at: 'desc' } } },
    });
    if (!p) throw new NotFoundException('Purchase order not found');
    const names = await this.itemNames(companyId, p.lines.map((l) => l.item_id));
    const loc = await this.prisma.inventoryLocation.findUnique({ where: { id: p.location_id }, select: { name: true } });
    const itemsTotal = p.lines.reduce((a, l) => a + l.qty_ordered * money(l.unit_cost), 0);
    return {
      id: p.id,
      number: p.number,
      status: p.status,
      supplier: p.supplier ? { id: p.supplier.id, name: p.supplier.name, phone: p.supplier.phone, email: p.supplier.email } : null,
      locationId: p.location_id,
      location: loc?.name ?? '—',
      expectedAt: p.expected_at,
      sentAt: p.sent_at,
      notes: p.notes,
      freight: money(p.freight),
      paid: money(p.paid_amount),
      itemsTotal: Math.round(itemsTotal * 100) / 100,
      balance: Math.round((itemsTotal + money(p.freight) - money(p.paid_amount)) * 100) / 100,
      createdAt: p.created_at,
      lines: p.lines.map((l) => ({
        itemId: l.item_id,
        title: names.get(l.item_id)?.title ?? 'Item',
        sku: names.get(l.item_id)?.sku ?? null,
        image: names.get(l.item_id)?.image ?? null,
        currentCost: names.get(l.item_id)?.avgCost ?? null,
        ordered: l.qty_ordered,
        received: l.qty_received,
        unitCost: money(l.unit_cost),
      })),
      receipts: p.receipts.map((r) => ({ id: r.id, number: r.number, at: r.created_at, units: r.lines.reduce((a, l) => a + l.qty, 0), note: r.note })),
    };
  }

  async createPO(
    companyId: number,
    dto: { supplierId?: number | null; locationId: number; expectedAt?: string | null; notes?: string | null; freight?: number; lines: Array<{ itemId: number; qty: number; unitCost?: number | null }> },
    userId: number,
  ) {
    await this.assertLocation(companyId, dto.locationId);
    const lines = (dto.lines ?? []).filter((l) => l.itemId && l.qty > 0);
    if (!lines.length) throw new BadRequestException('Add at least one item');
    const names = await this.itemNames(companyId, lines.map((l) => l.itemId));
    if (names.size !== new Set(lines.map((l) => l.itemId)).size) throw new BadRequestException('An item was not found');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const number = await this.nextNumber(companyId, 'PO', 'purchase_orders');
        const po = await this.prisma.purchaseOrder.create({
          data: {
            company_id: companyId, number, supplier_id: dto.supplierId ?? null, location_id: dto.locationId,
            expected_at: dto.expectedAt ? new Date(dto.expectedAt) : null, notes: dto.notes?.trim() || null,
            freight: dto.freight ?? 0, created_by: userId,
            lines: {
              create: lines.map((l) => ({
                company_id: companyId, item_id: l.itemId, qty_ordered: Math.trunc(l.qty),
                unit_cost: l.unitCost ?? names.get(l.itemId)?.avgCost ?? 0,
              })),
            },
          },
        });
        return this.getPO(companyId, po.id);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new BadRequestException('Could not number the order — try again');
  }

  async updatePO(
    companyId: number,
    id: number,
    dto: { supplierId?: number | null; locationId?: number; expectedAt?: string | null; notes?: string | null; freight?: number; lines?: Array<{ itemId: number; qty: number; unitCost?: number | null }> },
  ) {
    const p = await this.prisma.purchaseOrder.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!p) throw new NotFoundException('Purchase order not found');
    if (!['draft', 'sent', 'partial'].includes(p.status)) throw new BadRequestException('This order is closed');
    if (dto.locationId && dto.locationId !== p.location_id) {
      if (p.status !== 'draft') throw new BadRequestException('Change the location before sending the order');
      await this.assertLocation(companyId, dto.locationId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          ...(dto.supplierId !== undefined ? { supplier_id: dto.supplierId } : {}),
          ...(dto.locationId ? { location_id: dto.locationId } : {}),
          ...(dto.expectedAt !== undefined ? { expected_at: dto.expectedAt ? new Date(dto.expectedAt) : null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.freight !== undefined ? { freight: dto.freight } : {}),
        },
      });
      if (dto.lines) {
        const byItem = new Map(p.lines.map((l) => [l.item_id, l]));
        for (const l of dto.lines) {
          const cur = byItem.get(l.itemId);
          if (cur && l.qty < cur.qty_received) throw new BadRequestException('Can’t order fewer than already received');
          if (cur) {
            await tx.purchaseOrderLine.update({
              where: { id: cur.id },
              data: { qty_ordered: Math.trunc(l.qty), ...(l.unitCost != null ? { unit_cost: l.unitCost } : {}) },
            });
          } else if (l.qty > 0) {
            await tx.purchaseOrderLine.create({ data: { company_id: companyId, po_id: id, item_id: l.itemId, qty_ordered: Math.trunc(l.qty), unit_cost: l.unitCost ?? 0 } });
          }
        }
        const keep = new Set(dto.lines.filter((l) => l.qty > 0).map((l) => l.itemId));
        for (const cur of p.lines) {
          if (!keep.has(cur.item_id)) {
            if (cur.qty_received > 0) throw new BadRequestException('Can’t remove an item that was already received');
            await tx.purchaseOrderLine.delete({ where: { id: cur.id } });
          }
        }
      }
    });
    // incoming follows the ordered − received of a sent order
    if (p.status !== 'draft') await this.syncIncoming(companyId, id, p.lines, p.location_id);
    return this.getPO(companyId, id);
  }

  /** Recompute this PO's contribution to `incoming` after line edits. */
  private async syncIncoming(companyId: number, poId: number, before: Array<{ item_id: number; qty_ordered: number; qty_received: number }>, locationId: number) {
    const after = await this.prisma.purchaseOrderLine.findMany({ where: { po_id: poId } });
    const prev = new Map(before.map((l) => [l.item_id, l.qty_ordered - l.qty_received]));
    const next = new Map(after.map((l) => [l.item_id, l.qty_ordered - l.qty_received]));
    for (const itemId of new Set([...prev.keys(), ...next.keys()])) {
      const d = (next.get(itemId) ?? 0) - (prev.get(itemId) ?? 0);
      if (d) await this.ledger.setCounters(companyId, itemId, locationId, { incomingDelta: d });
    }
  }

  async sendPO(companyId: number, id: number) {
    const p = await this.prisma.purchaseOrder.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!p || p.status !== 'draft') throw new BadRequestException('Only a draft order can be sent');
    for (const l of p.lines) await this.ledger.setCounters(companyId, l.item_id, p.location_id, { incomingDelta: l.qty_ordered });
    await this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'sent', sent_at: new Date() } });
    this.ledger.emit(companyId, 'inventory.changed', { itemIds: p.lines.map((l) => l.item_id), po: p.number });
    return this.getPO(companyId, id);
  }

  /**
   * Receive (part of) an order: stock in at the order's location, freight
   * spread by value into a landed unit cost, weighted-average cost updated
   * (and pushed to the stores), incoming reduced, receipt numbered.
   */
  async receivePO(
    companyId: number,
    id: number,
    dto: { lines: Array<{ itemId: number; qty: number; unitCost?: number | null }>; freight?: number; note?: string | null },
    userId: number,
  ) {
    const p = await this.prisma.purchaseOrder.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!p) throw new NotFoundException('Purchase order not found');
    if (p.status === 'draft') await this.sendPO(companyId, id);
    else if (!['sent', 'partial'].includes(p.status)) throw new BadRequestException('This order is closed');
    const byItem = new Map(p.lines.map((l) => [l.item_id, l]));
    const lines = (dto.lines ?? [])
      .filter((l) => l.qty > 0 && byItem.has(l.itemId))
      .map((l) => ({ ...l, qty: Math.trunc(l.qty), unitCost: l.unitCost ?? money(byItem.get(l.itemId)!.unit_cost) }));
    if (!lines.length) throw new BadRequestException('Enter how many arrived');
    const landed = spreadLanded(lines.map((l) => ({ qty: l.qty, unitCost: l.unitCost })), dto.freight ?? 0);
    const number = await this.nextNumber(companyId, 'GRN', 'goods_receipts');
    const receipt = await this.prisma.goodsReceipt.create({
      data: {
        company_id: companyId, po_id: id, number, freight: dto.freight ?? 0, received_by: userId, note: dto.note?.trim() || null,
        lines: { create: lines.map((l, i) => ({ company_id: companyId, item_id: l.itemId, qty: l.qty, unit_cost: l.unitCost, landed_cost: landed[i] })) },
      },
    });
    // weighted-average cost BEFORE the stock lands (old qty = current on hand, all locations)
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const item = await this.prisma.inventoryItem.findFirst({ where: { id: l.itemId, company_id: companyId }, select: { avg_cost: true } });
      const lv = await this.prisma.inventoryLevel.aggregate({ where: { item_id: l.itemId }, _sum: { available: true, committed: true } });
      const oldQty = (lv._sum.available ?? 0) + (lv._sum.committed ?? 0);
      const next = weightedAverage({ oldQty, oldCost: item?.avg_cost != null ? Number(item.avg_cost) : null, inQty: l.qty, inCost: landed[i] });
      if (item && (item.avg_cost == null || Number(item.avg_cost) !== next)) {
        await this.prisma.inventoryItem.update({ where: { id: l.itemId }, data: { avg_cost: next } });
        await this.prisma.inventoryCostHistory.create({
          data: { company_id: companyId, item_id: l.itemId, old_cost: item.avg_cost, new_cost: next, source: 'po', ref: p.number, actor_user_id: userId },
        });
        await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'pushCost', companyId, itemId: l.itemId }, { dedupKey: `inv2-cost:${l.itemId}` });
      }
    }
    await this.ledger.apply(
      companyId,
      lines.map((l) => ({ itemId: l.itemId, locationId: p.location_id, delta: l.qty })),
      { reason: 'po_receive', ref: `po:${p.number}`, refType: 'po', note: number, actorUserId: userId, idemKey: `grn:${receipt.id}` },
    );
    for (const l of lines) {
      const line = byItem.get(l.itemId)!;
      const remaining = Math.max(0, line.qty_ordered - line.qty_received);
      await this.prisma.purchaseOrderLine.update({ where: { id: line.id }, data: { qty_received: { increment: l.qty } } });
      await this.ledger.setCounters(companyId, l.itemId, p.location_id, { incomingDelta: -Math.min(remaining, l.qty) });
    }
    const after = await this.prisma.purchaseOrderLine.findMany({ where: { po_id: id } });
    const done = after.every((l) => l.qty_received >= l.qty_ordered);
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: done ? 'received' : 'partial', ...(dto.freight ? { freight: { increment: dto.freight } } : {}) },
    });
    return this.getPO(companyId, id);
  }

  async cancelPO(companyId: number, id: number) {
    const p = await this.prisma.purchaseOrder.findFirst({ where: { id, company_id: companyId }, include: { lines: true } });
    if (!p || !['draft', 'sent', 'partial'].includes(p.status)) throw new BadRequestException('This order can’t be cancelled');
    if (p.status !== 'draft') {
      for (const l of p.lines) {
        const rem = Math.max(0, l.qty_ordered - l.qty_received);
        if (rem) await this.ledger.setCounters(companyId, l.item_id, p.location_id, { incomingDelta: -rem });
      }
    }
    await this.prisma.purchaseOrder.update({ where: { id }, data: { status: p.status === 'partial' ? 'closed' : 'cancelled' } });
    return this.getPO(companyId, id);
  }

  async recordPayment(companyId: number, id: number, amount: number) {
    const p = await this.prisma.purchaseOrder.findFirst({ where: { id, company_id: companyId } });
    if (!p) throw new NotFoundException('Purchase order not found');
    await this.prisma.purchaseOrder.update({ where: { id }, data: { paid_amount: { increment: amount } } });
    return this.getPO(companyId, id);
  }

  // ── Reorder suggestions ──────────────────────────────────────────────────

  async reorderSuggestions(companyId: number, f: { supplierId?: number; locationId?: number }) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_settings: true } });
    const settings = resolveInventorySettings(c?.inventory_settings);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: number; title: string; variant_title: string | null; sku: string | null; image_url: string | null; reorder_level: number; reorder_qty: number | null;
        lead: number | null; s_lead: number | null; supplier_id: number | null; supplier: string | null; avg_cost: string | number | null;
        available: string | number; incoming: string | number; sold: string | number | null }>
    >`
      SELECT i.id, i.title, i.variant_title, i.sku, i.image_url, i.reorder_level, i.reorder_qty, i.lead_time_days AS lead,
             s.lead_time_days AS s_lead, i.supplier_id, s.name AS supplier, i.avg_cost,
             COALESCE(SUM(l.available), 0) AS available, COALESCE(SUM(l.incoming), 0) AS incoming,
             (SELECT SUM(-m.delta) FROM inventory_movements m WHERE m.company_id = ${companyId} AND m.item_id = i.id
                AND m.reason = 'sale' AND m.created_at >= NOW() - INTERVAL 30 DAY) AS sold
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN inventory_levels l ON l.item_id = i.id ${f.locationId ? Prisma.sql`AND l.location_id = ${f.locationId}` : Prisma.empty}
      WHERE i.company_id = ${companyId} AND i.archived_at IS NULL AND i.track = 1 AND i.is_bundle = 0
        ${f.supplierId ? Prisma.sql`AND i.supplier_id = ${f.supplierId}` : Prisma.empty}
      GROUP BY i.id
      LIMIT 3000`;
    const out = rows
      .map((r) => {
        const perDay = Number(r.sold ?? 0) / 30;
        const available = Number(r.available);
        const incoming = Number(r.incoming);
        const lead = r.lead ?? r.s_lead ?? settings.defaultLeadTimeDays;
        const qty = suggestReorder({ available, incoming, unitsPerDay: perDay, leadTimeDays: lead, coverDays: settings.targetCoverDays, reorderQty: r.reorder_qty });
        const underPoint = available + incoming <= r.reorder_level;
        const final = qty || (underPoint ? Math.max(r.reorder_qty ?? 1, r.reorder_level - available - incoming + 1) : 0);
        return {
          itemId: r.id,
          title: [r.title, r.variant_title && r.variant_title !== 'Default Title' ? r.variant_title : null].filter(Boolean).join(' · '),
          sku: r.sku, image: r.image_url, supplierId: r.supplier_id, supplier: r.supplier,
          available, incoming, soldPerDay: Math.round(perDay * 100) / 100, leadTimeDays: lead,
          daysCover: perDay > 0 ? Math.round(available / perDay) : null,
          suggested: final, unitCost: r.avg_cost != null ? Number(r.avg_cost) : null,
        };
      })
      .filter((r) => r.suggested > 0)
      .sort((a, b) => (a.daysCover ?? 9999) - (b.daysCover ?? 9999));
    return out;
  }
}
