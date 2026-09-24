import { BadRequestException, Injectable } from '@nestjs/common';
import { CourierType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
import { COURIER_DISPLAY_NAME } from './couriers.constants';
import {
  buildReturnsSheetPdf,
  type ReturnsParcelRow,
  type ReturnsPickRow,
} from './returns-sheet-pdf.util';

interface ParsedItem {
  product: string;
  variant: string | null;
  qty: number;
}

/**
 * Builds the "Returns Received" sheet (RTO goods-inward) as a downloadable PDF or
 * CSV — a per-parcel manifest grouped by courier + an aggregated restock
 * picklist. Two scopes: an explicit list of scanned shipment ids ("this batch",
 * regardless of received_at so it works the instant you scan), or all returns
 * physically received (received_at set, status failed/returned) in a date range.
 */
@Injectable()
export class ReturnsSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  private parseItems(lineItems: unknown): ParsedItem[] {
    if (!Array.isArray(lineItems)) return [];
    return lineItems.map((raw) => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const product = String(it.title ?? it.name ?? 'Item').trim() || 'Item';
      const vRaw = (it.variantTitle ?? it.variant_title ?? null) as string | null;
      const variant =
        vRaw && String(vRaw).trim() && !/default title/i.test(String(vRaw))
          ? String(vRaw).trim()
          : null;
      const qty = Number(it.quantity ?? it.qty ?? 1) || 1;
      return { product, variant, qty };
    });
  }

  private itemsText(items: ParsedItem[], fallback: string | null): string {
    if (!items.length) return (fallback ?? '').trim() || '—';
    return items
      .map((i) => `${i.qty}x ${i.product}${i.variant ? ` (${i.variant})` : ''}`)
      .join(' · ');
  }

  /** Returns `{ url }` for the generated file (PDF or CSV). */
  async build(
    companyId: number,
    opts: {
      format: 'pdf' | 'csv';
      shipmentIds?: number[];
      from?: Date;
      to?: Date;
    },
  ): Promise<{ url: string; parcels: number; units: number }> {
    const ids = (opts.shipmentIds ?? []).filter((n) => Number.isFinite(n));

    const where: Prisma.ShipmentWhereInput = { company_id: companyId };
    if (ids.length) {
      where.id = { in: ids };
    } else {
      // Date-range scope → only parcels actually received back.
      where.status = { in: ['failed', 'returned'] };
      where.received_at = {
        not: null,
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    const shipments = await this.prisma.shipment.findMany({
      where,
      select: {
        shopify_order_gid: true,
        shopify_order_name: true,
        courier_type: true,
        courier_tracking_number: true,
        received_at: true,
      },
      orderBy: [{ courier_type: 'asc' }, { shopify_order_name: 'asc' }],
    });
    if (!shipments.length) {
      throw new BadRequestException(
        ids.length
          ? 'None of these parcels could be found.'
          : 'No returns were received in this period.',
      );
    }

    const gids = [...new Set(shipments.map((s) => s.shopify_order_gid))];
    const orders = await this.prisma.shopifyOrder.findMany({
      where: { company_id: companyId, shopify_order_gid: { in: gids } },
      select: {
        shopify_order_gid: true,
        customer_name: true,
        city: true,
        line_items: true,
        line_items_summary: true,
      },
    });
    const orderByGid = new Map(orders.map((o) => [o.shopify_order_gid, o]));
    const [company] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { company_name: true },
      }),
    ]);

    // Per-parcel rows (manifest) + aggregation (picklist).
    const parcels: ReturnsParcelRow[] = [];
    const pick = new Map<
      string,
      { product: string; variant: string | null; units: number; byCourier: Map<string, number> }
    >();
    const courierSet = new Set<string>();

    for (const s of shipments) {
      const o = orderByGid.get(s.shopify_order_gid);
      const items = this.parseItems(o?.line_items);
      const units = items.reduce((a, i) => a + i.qty, 0);
      const courierName = COURIER_DISPLAY_NAME[s.courier_type as CourierType] ?? s.courier_type;
      courierSet.add(courierName);
      parcels.push({
        orderName: s.shopify_order_name ?? '—',
        tracking: s.courier_tracking_number ?? '—',
        courier: courierName,
        customer: o?.customer_name ?? '—',
        city: o?.city ?? '—',
        items: this.itemsText(items, o?.line_items_summary ?? null),
        units: items.length ? units : null,
      });
      for (const it of items) {
        const key = `${it.product.toLowerCase()}|||${(it.variant ?? '').toLowerCase()}`;
        const cur =
          pick.get(key) ??
          pick.set(key, { product: it.product, variant: it.variant, units: 0, byCourier: new Map() }).get(key)!;
        cur.units += it.qty;
        cur.byCourier.set(courierName, (cur.byCourier.get(courierName) ?? 0) + it.qty);
      }
    }

    const pickRows: ReturnsPickRow[] = [...pick.values()]
      .sort((a, b) => b.units - a.units || a.product.localeCompare(b.product))
      .map((p) => ({
        product: p.product,
        variant: p.variant,
        units: p.units,
        couriers: [...p.byCourier.entries()].map(([c, n]) => `${c} ${n}`).join(' · '),
      }));

    const totalUnits = parcels.reduce((a, p) => a + (p.units ?? 0), 0);
    const totals = {
      parcels: parcels.length,
      units: totalUnits,
      couriers: courierSet.size,
      skus: pickRows.length,
    };

    const dateLabel = ids.length
      ? `Scan batch · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : `${opts.from ? opts.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…'} – ${opts.to ? opts.to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…'}`;
    const companyName = company?.company_name || 'Returns';

    let buf: Buffer;
    let mime: string;
    if (opts.format === 'csv') {
      buf = Buffer.from(this.buildCsv(parcels, pickRows, totals, dateLabel), 'utf8');
      mime = 'text/csv';
    } else {
      buf = await buildReturnsSheetPdf({ companyName, dateLabel, parcels, pickRows, totals });
      mime = 'application/pdf';
    }

    const saved = this.media.saveBuffer(buf, mime, companyId);
    const rel = saved.path.split(/storage[\\/]media[\\/]/)[1];
    const url = rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
    if (!url) throw new BadRequestException('Failed to build the returns sheet.');
    return { url, parcels: totals.parcels, units: totals.units };
  }

  private buildCsv(
    parcels: ReturnsParcelRow[],
    pickRows: ReturnsPickRow[],
    totals: { parcels: number; units: number; couriers: number; skus: number },
    dateLabel: string,
  ): string {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rowify = (arr: unknown[]) => arr.map(esc).join(',');
    const lines: string[] = [];
    lines.push(`Returns Received,${esc(dateLabel)}`);
    lines.push(`Parcels,${totals.parcels},Units,${totals.units},Couriers,${totals.couriers},SKUs,${totals.skus}`);
    lines.push('');
    lines.push('MANIFEST');
    lines.push(rowify(['Courier', 'Order', 'AWB / CN', 'Customer', 'City', 'Items', 'Units']));
    for (const p of parcels) {
      lines.push(rowify([p.courier, p.orderName, p.tracking, p.customer, p.city, p.items, p.units ?? '']));
    }
    lines.push('');
    lines.push('RESTOCK PICKLIST');
    lines.push(rowify(['Product', 'Variant', 'Units', 'From couriers']));
    for (const r of pickRows) {
      lines.push(rowify([r.product, r.variant ?? '', r.units, r.couriers]));
    }
    return lines.join('\n');
  }
}
