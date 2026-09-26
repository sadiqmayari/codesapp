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

  /** Current UTC offset for an IANA tz, as { str: '+05:00', min: 300 }. Falls
   *  back to Pakistan (+05:00) when unknown. No DST subtlety needed for PK. */
  private tzOffset(tz: string | null | undefined): { str: string; min: number } {
    const fallback = { str: '+05:00', min: 300 };
    if (!tz) return fallback;
    try {
      const now = new Date();
      const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const min = Math.round((local.getTime() - utc.getTime()) / 60000);
      const sign = min >= 0 ? '+' : '-';
      const a = Math.abs(min);
      const str = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
      return { str, min };
    } catch {
      return fallback;
    }
  }

  /**
   * A browsable record of returns received, grouped by (tenant-local) day. Built
   * LIVE from the shipments (no stored files) so it's always accurate and every
   * day is re-downloadable via the returns-sheet endpoint using the day's
   * from/to. Returns newest day first.
   */
  async history(
    companyId: number,
    opts: { from?: Date; to?: Date },
  ): Promise<{
    days: Array<{
      day: string; // tenant-local YYYY-MM-DD
      from: string; // ISO UTC — the day's start (for re-download)
      to: string; // ISO UTC — the day's end
      parcels: number;
      couriers: Array<{ courier: string; count: number }>;
    }>;
    totalParcels: number;
  }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
    const off = this.tzOffset(company?.timezone);

    // MariaDB DATE(...) comes back as a JS Date (UTC midnight of that calendar
    // day) via $queryRaw — normalize to a 'YYYY-MM-DD' string.
    const ymd = (v: unknown): string =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ day: Date | string; courier_type: string; c: bigint }>
    >(
      // received_at IS NOT NULL alone = a physically-received return (that field
      // is only ever stamped by the RTO receive flow); the status may be
      // cancelled/failed/returned, so we must NOT filter on status.
      `SELECT DATE(CONVERT_TZ(received_at, '+00:00', '${off.str}')) day,
              courier_type, COUNT(*) c
         FROM shipments
        WHERE company_id = ? AND received_at IS NOT NULL
          ${opts.from ? 'AND received_at >= ?' : ''}
          ${opts.to ? 'AND received_at <= ?' : ''}
        GROUP BY day, courier_type
        ORDER BY day DESC`,
      companyId,
      ...(opts.from ? [opts.from] : []),
      ...(opts.to ? [opts.to] : []),
    );

    const byDay = new Map<
      string,
      { parcels: number; couriers: Map<string, number> }
    >();
    for (const r of rows) {
      if (!r.day) continue;
      const key = ymd(r.day);
      const d = byDay.get(key) ?? { parcels: 0, couriers: new Map() };
      const n = Number(r.c);
      d.parcels += n;
      const cname =
        COURIER_DISPLAY_NAME[r.courier_type as CourierType] ?? r.courier_type;
      d.couriers.set(cname, (d.couriers.get(cname) ?? 0) + n);
      byDay.set(key, d);
    }

    const days = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, d]) => {
        // Tenant-local midnight of `day` in UTC = day 00:00Z minus the offset.
        const startZ = Date.parse(`${day}T00:00:00.000Z`) - off.min * 60000;
        return {
          day,
          from: new Date(startZ).toISOString(),
          to: new Date(startZ + 86400000 - 1).toISOString(),
          parcels: d.parcels,
          couriers: [...d.couriers.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([courier, count]) => ({ courier, count })),
        };
      });

    return { days, totalParcels: days.reduce((s, d) => s + d.parcels, 0) };
  }

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
      // Date-range scope → parcels actually received back. `received_at` is set
      // ONLY by the RTO receive flow, so it alone identifies a received return —
      // regardless of the resulting status (an RTO receive cancels+archives the
      // order, so most end up `cancelled`, not `failed`/`returned`).
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
        total_price: true,
        currency: true,
      },
    });
    const currency = orders.find((o) => o.currency)?.currency || 'PKR';
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
        amount: o?.total_price != null ? Number(o.total_price) : null,
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
    const totalAmount = parcels.reduce((a, p) => a + (p.amount ?? 0), 0);
    const totals = {
      parcels: parcels.length,
      units: totalUnits,
      couriers: courierSet.size,
      skus: pickRows.length,
      amount: totalAmount,
    };

    const dateLabel = ids.length
      ? `Scan batch · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : `${opts.from ? opts.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…'} – ${opts.to ? opts.to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…'}`;
    const companyName = company?.company_name || 'Returns';

    let buf: Buffer;
    let mime: string;
    if (opts.format === 'csv') {
      buf = Buffer.from(this.buildCsv(parcels, pickRows, totals, dateLabel, currency), 'utf8');
      mime = 'text/csv';
    } else {
      buf = await buildReturnsSheetPdf({ companyName, dateLabel, parcels, pickRows, totals, currency });
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
    totals: { parcels: number; units: number; couriers: number; skus: number; amount: number },
    dateLabel: string,
    currency: string,
  ): string {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rowify = (arr: unknown[]) => arr.map(esc).join(',');
    const lines: string[] = [];
    lines.push(`Returns Received,${esc(dateLabel)}`);
    lines.push(
      `Parcels,${totals.parcels},Units,${totals.units},Couriers,${totals.couriers},SKUs,${totals.skus},Value (${esc(currency)}),${Math.round(totals.amount)}`,
    );
    lines.push('');
    lines.push('MANIFEST');
    lines.push(
      rowify(['Courier', 'Order', 'AWB / CN', 'Customer', 'City', 'Items', 'Units', `Amount (${currency})`]),
    );
    for (const p of parcels) {
      lines.push(
        rowify([
          p.courier,
          p.orderName,
          p.tracking,
          p.customer,
          p.city,
          p.items,
          p.units ?? '',
          p.amount == null ? '' : Math.round(p.amount),
        ]),
      );
    }
    lines.push(rowify(['', 'TOTAL', '', '', '', '', totals.units, Math.round(totals.amount)]));
    lines.push('');
    lines.push('RESTOCK PICKLIST');
    lines.push(rowify(['Product', 'Variant', 'Units', 'From couriers']));
    for (const r of pickRows) {
      lines.push(rowify([r.product, r.variant ?? '', r.units, r.couriers]));
    }
    return lines.join('\n');
  }
}
