import { PrismaService } from '../../prisma/prisma.service';
import { RAPIDXPK_DEFAULT_SERVICE, rapidxpkExternalBase } from './adapters/rapidxpk.adapter';
import { courierTrackingUrl } from './couriers.constants';
import { RapidxpkLabelData } from './rapidxpk-slip.util';

/** Tenant-local YYYY-MM-DD. */
export function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Everything RapidXpk's label + loadsheet print, per parcel, in the order the
 * tracking numbers were given. Sources:
 *  - order_id / external_id / tracking_url → the stored booking reply (or later
 *    webhook body — same shape) in shipments.raw_last_webhook; falls back to
 *    the order number / constructed URL,
 *  - deliver_to → the order mirror (address2 = landmark),
 *  - COD vs PREPAID → outstanding balance (0 = prepaid),
 *  - brand → the order's store label, else the company name.
 */
export async function loadRapidxpkParcels(
  prisma: PrismaService,
  companyId: number,
  trackingNumbers: string[],
  service?: string,
): Promise<RapidxpkLabelData[]> {
  const tns = [...new Set(trackingNumbers.filter(Boolean))];
  if (!tns.length) return [];
  const shipments = await prisma.shipment.findMany({
    where: { company_id: companyId, courier_type: 'rapidxpk', courier_tracking_number: { in: tns } },
  });
  const gids = [...new Set(shipments.map((s) => s.shopify_order_gid))];
  const storeIds = [
    ...new Set(shipments.map((s) => s.shopify_store_id).filter((x): x is number => x != null)),
  ];
  const [mirrors, company, stores] = await Promise.all([
    prisma.shopifyOrder.findMany({ where: { company_id: companyId, shopify_order_gid: { in: gids } } }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, timezone: true },
    }),
    storeIds.length
      ? prisma.shopifyStore.findMany({
          where: { company_id: companyId, id: { in: storeIds } },
          select: { id: true, label: true },
        })
      : Promise.resolve([] as { id: number; label: string | null }[]),
  ]);
  const byGid = new Map(mirrors.map((m) => [m.shopify_order_gid, m]));
  const storeName = new Map(stores.map((s) => [s.id, s.label]));
  const tz = company?.timezone || 'Asia/Karachi';
  const byTn = new Map(shipments.map((s) => [s.courier_tracking_number as string, s]));

  const out: RapidxpkLabelData[] = [];
  for (const tn of tns) {
    const s = byTn.get(tn);
    if (!s) continue;
    const m = byGid.get(s.shopify_order_gid);
    const raw = (s.raw_last_webhook ?? {}) as Record<string, unknown>;

    const items: { name: string; qty: number }[] = [];
    let pieces = 0;
    try {
      const li = typeof m?.line_items === 'string' ? JSON.parse(m.line_items) : m?.line_items;
      if (Array.isArray(li)) {
        for (const it of li as Array<Record<string, unknown>>) {
          const title = String(it?.title ?? it?.name ?? 'Item').trim() || 'Item';
          const variant = String(it?.variantTitle ?? it?.variant_title ?? '').trim();
          const qty = Number(it?.currentQuantity ?? it?.quantity ?? 1) || 1;
          items.push({
            name: variant && variant !== 'Default Title' ? `${title} - ${variant}` : title,
            qty,
          });
          pieces += qty;
        }
      }
    } catch {
      /* malformed line_items */
    }
    if (!items.length && m?.line_items_summary) items.push({ name: m.line_items_summary, qty: 1 });
    if (pieces <= 0) pieces = 1;

    const cod = Math.max(0, Number(m?.total_outstanding ?? 0));
    const brand =
      (s.shopify_store_id != null ? storeName.get(s.shopify_store_id) : null) ||
      company?.company_name ||
      '';
    out.push({
      orderId: tn,
      trackingUrl:
        (typeof raw.tracking_url === 'string' && raw.tracking_url) ||
        courierTrackingUrl('rapidxpk', tn) ||
        '',
      externalId:
        (typeof raw.external_id === 'string' && raw.external_id) ||
        rapidxpkExternalBase(s.shopify_order_name || m?.order_name || ''),
      service: service?.trim() || RAPIDXPK_DEFAULT_SERVICE,
      date: ymdInTz(s.booked_at ?? s.created_at, tz),
      brand,
      name: m?.customer_name || '',
      phone: m?.phone || '',
      address: m?.address1 || s.destination_address || '',
      landmark: m?.address2 || '',
      city: s.destination_city || m?.city || s.courier_city_code || '',
      codAmount: cod,
      payment: cod > 0 ? 'COD' : 'PREPAID',
      pieces,
      items,
      notes: '',
    });
  }
  return out;
}
