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
import { COURIER_TYPES } from './courier-registry.service';
import {
  SetCourierCredentialsDto,
  UpsertCityMappingDto,
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
  ) {}

  @Get()
  async status(@CurrentUser() user: { companyId: number }) {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: user.companyId },
      select: { courier_type: true, is_active: true, webhook_key: true, updated_at: true },
    });
    const byType = new Map(rows.map((r) => [r.courier_type, r]));
    return COURIER_TYPES.map((courierType) => {
      const row = byType.get(courierType);
      return {
        courierType,
        configured: !!row,
        isActive: row?.is_active ?? false,
        webhookUrl: row ? `/webhooks/couriers/${courierType}/${row.webhook_key}` : null,
        updatedAt: row?.updated_at ?? null,
      };
    });
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
    const credentialsEncrypted = this.encryption.encrypt(JSON.stringify(dto.credentials));
    const webhookSecretEncrypted = dto.webhookSecret
      ? this.encryption.encrypt(dto.webhookSecret)
      : undefined;

    const existing = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
    });

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
}
