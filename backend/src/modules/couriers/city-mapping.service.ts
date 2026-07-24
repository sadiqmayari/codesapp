import { Injectable } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { COURIER_TYPES } from './courier-registry.service';

function normalizeCity(city: string): string {
  return city.trim().toLowerCase();
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
}
