import { Injectable } from '@nestjs/common';
import { CourierType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { COURIER_TYPES } from './courier-registry.service';
import { likePrefix } from '../../common/utils/search';
import { CacheService } from '../../common/services/cache.service';
import { rtoSql } from '../../common/utils/shipment-outcome';

function normalizeCity(city: string): string {
  return city.trim().toLowerCase();
}

/** Display-friendly casing for stored lowercase city names ("dg khan" -> "Dg Khan"). */
function titleCaseCity(name: string): string {
  return name.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

export interface CourierSuggestion {
  courierType: CourierType;
  cityCode: string;
  isDefault: boolean;
}

/**
 * City name -> per-courier city code lookup, with tenant overrides taking
 * precedence over the platform seed (company_id IS NULL) rows. Replaces the
 * sheet's 4 separate city-lookup tabs and the manual "type a courier name
 * into a cell" step.
 */
@Injectable()
export class CityMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * How each courier has actually performed in each of the tenant's order
   * cities — drives the Settings → Couriers "City → courier" grid (delivery
   * rate per cell + "best pick").
   *
   * - City key = `LOWER(TRIM(shopify_orders.city))`, the SAME key `coverage()`
   *   uses as `cityName`, so the frontend joins the two exactly.
   * - Only SETTLED parcels count: booked 21–180 days ago (returns take ~14 d to
   *   come back; recent parcels would inflate the rate — same rule as Growth's
   *   `SETTLE_DAYS`). A parcel is a return per the app-wide `rtoSql` rule;
   *   cancelled-before-dispatch (no receipt) and `address_issue` are excluded
   *   (not courier outcomes). Manual shipments are excluded (no courier).
   * - `rate` = delivered ÷ (delivered + returned) over those settled parcels.
   * - Also returns each city's 90-day order count + value (non-cancelled) so
   *   the UI can rank unmapped cities by money at stake.
   * Read-only, cached 5 min per tenant.
   */
  async performance(companyId: number): Promise<{
    windowDays: { from: number; to: number };
    cities: Array<{
      cityName: string;
      orders90d: number;
      value90d: number;
      couriers: Array<{
        courierType: CourierType;
        parcels: number;
        delivered: number;
        returned: number;
        rate: number | null;
      }>;
    }>;
  }> {
    const key = `city-perf:${companyId}`;
    const hit = this.cache.get<Awaited<ReturnType<CityMappingService['performance']>>>(key);
    if (hit) return hit;

    const SETTLE_DAYS = 21;
    const WINDOW_DAYS = 180;
    const n = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));

    type PerfRow = {
      city: string;
      courier: CourierType;
      delivered: bigint | number;
      returned: bigint | number;
    };
    const perf = await this.prisma.$queryRaw<PerfRow[]>(Prisma.sql`
      SELECT LOWER(TRIM(o.city)) AS city, s.courier_type AS courier,
        SUM(s.status = 'delivered' AND s.received_at IS NULL) AS delivered,
        SUM(${Prisma.raw(rtoSql('s'))}) AS returned
      FROM shipments s
      JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.courier_type <> 'manual'
        AND s.booked_at >= NOW() - INTERVAL ${WINDOW_DAYS} DAY
        AND s.booked_at <  NOW() - INTERVAL ${SETTLE_DAYS} DAY
        AND o.city IS NOT NULL AND TRIM(o.city) <> ''
        AND ((s.status = 'delivered' AND s.received_at IS NULL) OR ${Prisma.raw(rtoSql('s'))})
      GROUP BY LOWER(TRIM(o.city)), s.courier_type
    `);

    type ValRow = { city: string; orders: bigint | number; value: number | string | null };
    const vals = await this.prisma.$queryRaw<ValRow[]>(Prisma.sql`
      SELECT LOWER(TRIM(o.city)) AS city, COUNT(*) AS orders,
        COALESCE(SUM(o.total_price), 0) AS value
      FROM shopify_orders o
      WHERE o.company_id = ${companyId}
        AND o.cancelled_at IS NULL
        AND o.shopify_created_at >= NOW() - INTERVAL 90 DAY
        AND o.city IS NOT NULL AND TRIM(o.city) <> ''
      GROUP BY LOWER(TRIM(o.city))
    `);

    const byCity = new Map<
      string,
      {
        cityName: string;
        orders90d: number;
        value90d: number;
        couriers: Array<{
          courierType: CourierType;
          parcels: number;
          delivered: number;
          returned: number;
          rate: number | null;
        }>;
      }
    >();
    const entry = (city: string) => {
      let e = byCity.get(city);
      if (!e) {
        e = { cityName: city, orders90d: 0, value90d: 0, couriers: [] };
        byCity.set(city, e);
      }
      return e;
    };
    for (const v of vals) {
      const e = entry(v.city);
      e.orders90d = n(v.orders);
      e.value90d = Math.round(Number(v.value ?? 0));
    }
    for (const p of perf) {
      const delivered = n(p.delivered);
      const returned = n(p.returned);
      const parcels = delivered + returned;
      entry(p.city).couriers.push({
        courierType: p.courier,
        parcels,
        delivered,
        returned,
        rate: parcels ? delivered / parcels : null,
      });
    }

    const out = {
      windowDays: { from: WINDOW_DAYS, to: SETTLE_DAYS },
      cities: Array.from(byCity.values()),
    };
    this.cache.set(key, out, 300);
    return out;
  }

  /** Resolve a single courier's city code for a destination city. Throws
   *  nothing — returns null when unresolved so callers can decide (throw for
   *  booking, or just skip that courier for suggestion purposes). */
  async resolve(
    companyId: number,
    courierType: CourierType,
    city: string,
  ): Promise<string | null> {
    const name = normalizeCity(city);
    const tenantRow = await this.prisma.courierCityMapping.findUnique({
      where: {
        company_id_courier_type_city_name: {
          company_id: companyId,
          courier_type: courierType,
          city_name: name,
        },
      },
    });
    if (tenantRow) return tenantRow.city_code;

    const seedRow = await this.prisma.courierCityMapping.findFirst({
      where: { company_id: null, courier_type: courierType, city_name: name },
    });
    return seedRow?.city_code ?? null;
  }

  async requireCode(
    companyId: number,
    courierType: CourierType,
    city: string,
  ): Promise<string> {
    const code = await this.resolve(companyId, courierType, city);
    if (!code) {
      throw new Error(
        `No ${courierType} city code configured for "${city}" — add it in Settings > Courier > City Mapping.`,
      );
    }
    return code;
  }

  /** Suggest a courier for a destination city, ranked by is_default_courier,
   *  restricted to couriers the tenant actually has active credentials for. */
  async suggestCourier(
    companyId: number,
    city: string,
    activeCouriers: CourierType[],
  ): Promise<CourierSuggestion[]> {
    const name = normalizeCity(city);
    const results: CourierSuggestion[] = [];
    for (const courierType of activeCouriers.length ? activeCouriers : COURIER_TYPES) {
      const tenantRow = await this.prisma.courierCityMapping.findUnique({
        where: {
          company_id_courier_type_city_name: {
            company_id: companyId,
            courier_type: courierType,
            city_name: name,
          },
        },
      });
      const row =
        tenantRow ??
        (await this.prisma.courierCityMapping.findFirst({
          where: { company_id: null, courier_type: courierType, city_name: name },
        }));
      if (row) {
        results.push({
          courierType,
          cityCode: row.city_code,
          isDefault: row.is_default_courier,
        });
      }
    }
    // Default-flagged couriers first, otherwise stable input order.
    return results.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  /**
   * Per-city courier coverage for the tenant's OWN order cities (from the
   * mirror), so the mapping UI shows exactly the cities that matter with, per
   * city: which couriers serve it (tenant override ?? platform seed), which one
   * is the tenant's chosen default, and the order volume. Case/whitespace
   * duplicates collapse into one row. Two bulk queries, computed in-process.
   */
  async coverage(
    companyId: number,
    activeCouriers: CourierType[],
  ): Promise<
    Array<{
      city: string;
      cityName: string;
      orders: number;
      defaultCourier: CourierType | null;
      couriers: Array<{
        courierType: CourierType;
        serves: boolean;
        cityCode: string | null;
        isDefault: boolean;
        active: boolean;
      }>;
    }>
  > {
    // 1. Distinct order cities + counts, collapsed by normalized name.
    const grouped = await this.prisma.shopifyOrder.groupBy({
      by: ['city'],
      where: { company_id: companyId, cancelled_at: null },
      _count: { _all: true },
    });
    const cityAgg = new Map<string, { display: string; orders: number }>();
    for (const g of grouped) {
      const raw = (g.city ?? '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const prev = cityAgg.get(key);
      const orders = (prev?.orders ?? 0) + g._count._all;
      // Prefer a Title-ish display: keep the longest raw spelling seen.
      const display = prev && prev.display.length >= raw.length ? prev.display : raw;
      cityAgg.set(key, { display, orders });
    }
    const cityNames = Array.from(cityAgg.keys());
    if (!cityNames.length) return [];

    // 2. All relevant mappings (tenant + platform seed) in one query.
    const mappings = await this.prisma.courierCityMapping.findMany({
      where: {
        OR: [{ company_id: companyId }, { company_id: null }],
        city_name: { in: cityNames },
      },
    });
    // perCity -> perCourier -> { tenant?, seed? }
    type Cell = { code: string; isDefault: boolean };
    const tenantMap = new Map<string, Map<CourierType, Cell>>();
    const seedMap = new Map<string, Map<CourierType, Cell>>();
    for (const m of mappings) {
      const target = m.company_id == null ? seedMap : tenantMap;
      if (!target.has(m.city_name)) target.set(m.city_name, new Map());
      target
        .get(m.city_name)!
        .set(m.courier_type, { code: m.city_code, isDefault: m.is_default_courier });
    }

    const activeSet = new Set(activeCouriers);
    const rows = cityNames.map((name) => {
      const agg = cityAgg.get(name)!;
      let defaultCourier: CourierType | null = null;
      const couriers = COURIER_TYPES.map((ct) => {
        const t = tenantMap.get(name)?.get(ct);
        const s = seedMap.get(name)?.get(ct);
        const cell = t ?? s;
        const isDefault = !!t?.isDefault;
        if (isDefault) defaultCourier = ct;
        return {
          courierType: ct,
          serves: !!cell,
          cityCode: cell?.code ?? null,
          isDefault,
          active: activeSet.has(ct),
        };
      });
      return {
        city: agg.display,
        cityName: name,
        orders: agg.orders,
        defaultCourier,
        couriers,
      };
    });
    // Busiest cities first — that's where a good mapping matters most.
    rows.sort((a, b) => b.orders - a.orders);
    return rows;
  }

  /**
   * Make `courierType` the tenant's default courier for each of `cities`.
   * Idempotent + single-default-per-city: upserts the tenant row (using the
   * courier's resolved city_code) with is_default_courier=true, and clears the
   * flag on the tenant's OTHER courier rows for that same city. Cities the
   * courier doesn't serve (no code anywhere) are skipped and reported.
   */
  async bulkSetDefault(
    companyId: number,
    courierType: CourierType,
    cities: string[],
  ): Promise<{ set: number; skipped: string[] }> {
    let set = 0;
    const skipped: string[] = [];
    for (const raw of cities) {
      const name = normalizeCity(raw);
      if (!name) continue;
      const code = await this.resolve(companyId, courierType, name);
      if (!code) {
        skipped.push(raw);
        continue;
      }
      await this.prisma.courierCityMapping.upsert({
        where: {
          company_id_courier_type_city_name: {
            company_id: companyId,
            courier_type: courierType,
            city_name: name,
          },
        },
        create: {
          company_id: companyId,
          courier_type: courierType,
          city_name: name,
          city_code: code,
          is_default_courier: true,
        },
        update: { is_default_courier: true },
      });
      // Exactly one default per city: unflag other couriers' tenant rows.
      await this.prisma.courierCityMapping.updateMany({
        where: {
          company_id: companyId,
          city_name: name,
          courier_type: { not: courierType },
          is_default_courier: true,
        },
        data: { is_default_courier: false },
      });
      set++;
    }
    return { set, skipped };
  }

  /**
   * Type-ahead city search for the address / create-order forms. Returns
   * distinct, title-cased city names from the known courier cities (platform
   * seed + this tenant's overrides) whose name starts with `query`. Tenant
   * agnostic (no hardcoded lists); cap keeps the dropdown snappy. Still allows
   * free text on the frontend — this only powers suggestions.
   */
  async searchCities(companyId: number, query: string, limit = 20): Promise<string[]> {
    const q = normalizeCity(query || '');
    if (q.length < 2) return [];
    // DISTINCT + LIMIT in SQL so we get up to `limit` UNIQUE names (Prisma's
    // in-memory distinct would cap before de-duping across couriers).
    const rows = await this.prisma.$queryRaw<Array<{ city_name: string }>>`
      SELECT DISTINCT city_name
      FROM courier_city_mappings
      WHERE (company_id = ${companyId} OR company_id IS NULL)
        AND city_name LIKE ${likePrefix(q)}
      ORDER BY city_name ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => titleCaseCity(r.city_name));
  }

  /** Clear the tenant's default-courier flag for each of `cities`. */
  async clearDefault(companyId: number, cities: string[]): Promise<{ cleared: number }> {
    const names = cities.map(normalizeCity).filter(Boolean);
    if (!names.length) return { cleared: 0 };
    const res = await this.prisma.courierCityMapping.updateMany({
      where: {
        company_id: companyId,
        city_name: { in: names },
        is_default_courier: true,
      },
      data: { is_default_courier: false },
    });
    return { cleared: res.count };
  }
}
