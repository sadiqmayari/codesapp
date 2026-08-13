import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CourierType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { COURIER_TYPES, CourierRegistryService } from './courier-registry.service';
import { TraxAdapter, TraxCredentials } from './adapters/trax.adapter';
import { CityMappingService } from './city-mapping.service';

/**
 * Which credential keys are SECRET per courier. Secret keys are never echoed
 * back by GET (only a set/not-set flag) and, on save, a blank value is IGNORED
 * so an edit to some other field never wipes the stored secret. Every other key
 * (pickup address, product type, insurance toggle, etc.) is echoed so the form
 * pre-fills and can be edited in isolation.
 */
const SECRET_CRED_KEYS: Record<CourierType, string[]> = {
  trax: ['bearerToken'],
  leopards: ['apiKey', 'apiPassword'],
  postex: ['token'],
  rocket: ['token'],
};
import {
  SetCourierCredentialsDto,
  UpsertCityMappingDto,
  BulkSetDefaultCourierDto,
  ClearDefaultCourierDto,
} from './dto/courier.dto';

/**
 * Owner/admin-only credential + city-mapping management, mirroring
 * SettingsShopifyController's pattern. Credentials are never echoed back —
 * GET only reports which couriers are configured + their webhook URL.
 */
@Controller('settings/couriers')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class SettingsCouriersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly cityMapping: CityMappingService,
    private readonly registry: CourierRegistryService,
  ) {}

  @Get()
  async status(@CurrentUser() user: { companyId: number }) {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: user.companyId },
      select: {
        courier_type: true,
        is_active: true,
        webhook_key: true,
        updated_at: true,
        credentials_encrypted: true,
      },
    });
    const byType = new Map(rows.map((r) => [r.courier_type, r]));
    return COURIER_TYPES.map((courierType) => {
      const row = byType.get(courierType);
      // Split the stored blob into echo-able (non-secret) values + set flags for
      // secrets, so the settings form pre-fills without ever exposing a secret.
      const savedValues: Record<string, string> = {};
      const secretSet: Record<string, boolean> = {};
      const secretKeys = SECRET_CRED_KEYS[courierType] ?? [];
      if (row?.credentials_encrypted) {
        try {
          const creds = JSON.parse(
            this.encryption.decrypt(row.credentials_encrypted),
          ) as Record<string, unknown>;
          for (const [k, v] of Object.entries(creds)) {
            if (secretKeys.includes(k)) {
              secretSet[k] = !!(typeof v === 'string' ? v.trim() : v);
            } else {
              savedValues[k] = v == null ? '' : String(v);
            }
          }
        } catch {
          // Undecryptable blob (e.g. rotated key) — treat as no saved values.
        }
      }
      return {
        courierType,
        configured: !!row,
        isActive: row?.is_active ?? false,
        webhookUrl: row ? `/webhooks/couriers/${courierType}/${row.webhook_key}` : null,
        updatedAt: row?.updated_at ?? null,
        savedValues,
        secretSet,
      };
    });
  }

  /** Trax pickup addresses (Sonic GET /pickup_addresses) so Settings can render
   *  a dropdown. Requires the Trax token to already be saved. */
  @Get('trax/pickup-addresses')
  async traxPickupAddresses(@CurrentUser() user: { companyId: number }) {
    const { creds } = await this.registry.requireCredentials(user.companyId, 'trax');
    const adapter = this.registry.getAdapter('trax') as TraxAdapter;
    return adapter.getPickupAddresses(creds as TraxCredentials);
  }

  @Put(':courierType')
  async setCredentials(
    @CurrentUser() user: { companyId: number },
    @Param('courierType') courierType: CourierType,
    @Body() dto: SetCourierCredentialsDto,
  ) {
    if (!COURIER_TYPES.includes(courierType)) {
      throw new Error(`Unknown courier type: ${courierType}`);
    }

    const existing = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
    });

    // MERGE onto whatever is already stored so editing one field never wipes the
    // others. Secret fields keep their saved value when submitted blank; every
    // other field is overwritten with the submitted value (including empty, so a
    // field can be cleared intentionally).
    const secretKeys = SECRET_CRED_KEYS[courierType] ?? [];
    let base: Record<string, string> = {};
    if (existing?.credentials_encrypted) {
      try {
        base = JSON.parse(this.encryption.decrypt(existing.credentials_encrypted));
      } catch {
        base = {};
      }
    }
    const merged: Record<string, string> = { ...base };
    for (const [k, raw] of Object.entries(dto.credentials ?? {})) {
      const val = typeof raw === 'string' ? raw : String(raw ?? '');
      if (secretKeys.includes(k)) {
        if (val.trim()) merged[k] = val.trim(); // blank secret = keep existing
      } else {
        merged[k] = val;
      }
    }
    const credentialsEncrypted = this.encryption.encrypt(JSON.stringify(merged));
    const webhookSecretEncrypted = dto.webhookSecret
      ? this.encryption.encrypt(dto.webhookSecret)
      : undefined;

    const row = await this.prisma.courierCredential.upsert({
      where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
      create: {
        company_id: user.companyId,
        courier_type: courierType,
        credentials_encrypted: credentialsEncrypted,
        webhook_secret_encrypted: webhookSecretEncrypted,
        webhook_key: existing?.webhook_key ?? randomBytes(24).toString('hex'),
      },
      update: {
        credentials_encrypted: credentialsEncrypted,
        ...(webhookSecretEncrypted ? { webhook_secret_encrypted: webhookSecretEncrypted } : {}),
        is_active: true,
      },
    });
    return {
      courierType,
      configured: true,
      webhookUrl: `/webhooks/couriers/${courierType}/${row.webhook_key}`,
    };
  }

  @Delete(':courierType')
  async removeCredentials(
    @CurrentUser() user: { companyId: number },
    @Param('courierType') courierType: CourierType,
  ) {
    await this.prisma.courierCredential
      .delete({
        where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
      })
      .catch(() => null);
    return { courierType, configured: false };
  }

  @Get('city-mappings')
  async listCityMappings(@CurrentUser() user: { companyId: number }) {
    return this.prisma.courierCityMapping.findMany({
      where: { OR: [{ company_id: user.companyId }, { company_id: null }] },
      orderBy: [{ courier_type: 'asc' }, { city_name: 'asc' }],
    });
  }

  @Put('city-mappings')
  async upsertCityMapping(
    @CurrentUser() user: { companyId: number },
    @Body() dto: UpsertCityMappingDto,
  ) {
    const cityName = dto.cityName.trim().toLowerCase();
    return this.prisma.courierCityMapping.upsert({
      where: {
        company_id_courier_type_city_name: {
          company_id: user.companyId,
          courier_type: dto.courierType,
          city_name: cityName,
        },
      },
      create: {
        company_id: user.companyId,
        courier_type: dto.courierType,
        city_name: cityName,
        city_code: dto.cityCode,
        is_default_courier: !!dto.isDefaultCourier,
      },
      update: {
        city_code: dto.cityCode,
        is_default_courier: !!dto.isDefaultCourier,
      },
    });
  }

  /** Per-city courier coverage for the tenant's own order cities (drives the
   *  City mapping screen: chips per courier + current default + order volume). */
  @Get('city-coverage')
  async cityCoverage(@CurrentUser() user: { companyId: number }) {
    const active = await this.registry.getActiveCouriers(user.companyId);
    return this.cityMapping.coverage(user.companyId, active);
  }

  /** Bulk: make a courier the default for many cities at once (both entry
   *  points — "cities → courier" and "courier → cities" — hit this). */
  @Put('city-mappings/bulk-default')
  async bulkSetDefault(
    @CurrentUser() user: { companyId: number },
    @Body() dto: BulkSetDefaultCourierDto,
  ) {
    return this.cityMapping.bulkSetDefault(user.companyId, dto.courierType, dto.cities);
  }

  /** Bulk: clear the default-courier choice for many cities. */
  @Put('city-mappings/clear-default')
  async clearDefault(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ClearDefaultCourierDto,
  ) {
    return this.cityMapping.clearDefault(user.companyId, dto.cities);
  }
}
