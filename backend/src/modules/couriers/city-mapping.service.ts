import { Injectable } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { COURIER_TYPES } from './courier-registry.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
        AND city_name LIKE ${q + '%'}
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
