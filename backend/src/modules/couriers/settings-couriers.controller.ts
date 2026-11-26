import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
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
import {
  DEFAULT_SYNC_INTERVAL_MIN,
  MAX_SYNC_INTERVAL_MIN,
  MIN_SYNC_INTERVAL_MIN,
} from './courier-status-sync.service';
import { TraxAdapter, TraxCredentials } from './adapters/trax.adapter';
import { MnpAdapter, MnpCredentials } from './adapters/mnp.adapter';
import { CityMappingService } from './city-mapping.service';
import { RapidxpkSetupService } from './rapidxpk-setup.service';
import { RapidxpkCredentials } from './adapters/rapidxpk.adapter';
import { TcsAdapter, TcsCredentials } from './adapters/tcs.adapter';

/**
 * Which credential keys are SECRET per courier. Secret keys are never echoed
 * back by GET (only a set/not-set flag) and, on save, a blank value is IGNORED
 * so an edit to some other field never wipes the stored secret. Every other key
 * (pickup address, product type, insurance toggle, etc.) is echoed so the form
 * pre-fills and can be edited in isolation.
 */
/** Stored but never sent to the browser (internal token metadata). */
const HIDDEN_CRED_KEYS: Partial<Record<CourierType, string[]>> = {
  tcs: ['ecomToken', 'ecomTokenExpiry', 'environment'],
};

const SECRET_CRED_KEYS: Record<CourierType, string[]> = {
  trax: ['bearerToken'],
  leopards: ['apiKey', 'apiPassword'],
  postex: ['token'],
  rocket: ['token'],
  mnp: ['password', 'webhookToken'],
  manual: [], // no credentials — not a real courier
  rapidxpk: ['apiKey', 'webhookSecret'],
  tcs: ['bearerToken', 'password', 'clientSecret', 'ecomToken'],
};
import {
  SetCourierCredentialsDto,
  SetCourierBookingDto,
  SetCourierSyncScheduleDto,
  UpsertCityMappingDto,
  BulkSetDefaultCourierDto,
  ClearDefaultCourierDto,
} from './dto/courier.dto';
import { ModuleGuard } from '../../common/guards/module.guard';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { PRIVILEGED } from '../../common/auth/roles';

/**
 * Owner/admin-only credential + city-mapping management, mirroring
 * SettingsShopifyController's pattern. Credentials are never echoed back —
 * GET only reports which couriers are configured + their webhook URL.
 */
@Controller('settings/couriers')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@Roles(...PRIVILEGED)
@RequireModule('couriers')
export class SettingsCouriersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly cityMapping: CityMappingService,
    private readonly registry: CourierRegistryService,
    private readonly rapidxpk: RapidxpkSetupService,
  ) {}

  @Get()
  async status(@CurrentUser() user: { companyId: number }) {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: user.companyId },
      select: {
        courier_type: true,
        is_active: true,
        booking_enabled: true,
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
      const hiddenKeys = HIDDEN_CRED_KEYS[courierType] ?? [];
      if (row?.credentials_encrypted) {
        try {
          const creds = JSON.parse(
            this.encryption.decrypt(row.credentials_encrypted),
          ) as Record<string, unknown>;
          for (const [k, v] of Object.entries(creds)) {
            if (hiddenKeys.includes(k)) continue;
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
        // Offered for new bookings. Separate from `configured`/`isActive` —
        // a configured courier can be toggled off for new orders while its
        // existing orders keep syncing. Defaults to true for a configured row.
        bookingEnabled: row ? row.booking_enabled : false,
        webhookUrl: row ? `/webhooks/couriers/${courierType}/${row.webhook_key}` : null,
        updatedAt: row?.updated_at ?? null,
        savedValues,
        secretSet,
        // TCS saved before the bearer-token change (Client ID/Secret only).
        needsReconnect: courierType === 'tcs' && !!row && !secretSet.bearerToken,
      };
    });
  }

  /**
   * Per-tenant courier status-sync (= shipper-advice + delivery-status) cadence.
   * Returns the configured interval (null = platform default), the effective
   * interval actually used, the default + bounds, and when the next sync is due.
   */
  @Get('sync-schedule')
  async getSyncSchedule(@CurrentUser() user: { companyId: number }) {
    const c = await this.prisma.company.findUnique({
      where: { id: user.companyId },
      select: { courier_sync_interval_minutes: true, courier_sync_last_at: true },
    });
    const intervalMinutes = c?.courier_sync_interval_minutes ?? null;
    const effectiveMinutes = intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MIN;
    const lastRunAt = c?.courier_sync_last_at ?? null;
    const nextDueAt = lastRunAt
      ? new Date(lastRunAt.getTime() + effectiveMinutes * 60_000)
      : null;
    return {
      intervalMinutes,
      effectiveMinutes,
      defaultMinutes: DEFAULT_SYNC_INTERVAL_MIN,
      minMinutes: MIN_SYNC_INTERVAL_MIN,
      maxMinutes: MAX_SYNC_INTERVAL_MIN,
      lastRunAt,
      nextDueAt,
    };
  }

  /** Set this tenant's courier-sync cadence. null = use the platform default;
   *  any value is clamped to [MIN, MAX] minutes. */
  @Put('sync-schedule')
  async setSyncSchedule(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetCourierSyncScheduleDto,
  ) {
    const raw = dto.intervalMinutes;
    const intervalMinutes =
      raw == null
        ? null
        : Math.min(MAX_SYNC_INTERVAL_MIN, Math.max(MIN_SYNC_INTERVAL_MIN, Math.trunc(raw)));
    await this.prisma.company.update({
      where: { id: user.companyId },
      data: { courier_sync_interval_minutes: intervalMinutes },
    });
    return { intervalMinutes };
  }

  /** Trax pickup addresses (Sonic GET /pickup_addresses) so Settings can render
   *  a dropdown. Requires the Trax token to already be saved. */
  @Get('trax/pickup-addresses')
  async traxPickupAddresses(@CurrentUser() user: { companyId: number }) {
    const { creds } = await this.registry.requireCredentials(user.companyId, 'trax');
    const adapter = this.registry.getAdapter('trax') as TraxAdapter;
    return adapter.getPickupAddresses(creds as TraxCredentials);
  }

  /** M&P origin/return locations (Get_locations) so Settings can render the
   *  locationID / returnLocation dropdowns. Requires M&P creds already saved. */
  @Get('mnp/locations')
  async mnpLocations(@CurrentUser() user: { companyId: number }) {
    const { creds } = await this.registry.requireCredentials(user.companyId, 'mnp');
    const adapter = this.registry.getAdapter('mnp') as MnpAdapter;
    return adapter.getLocations(creds as MnpCredentials);
  }

  /**
   * ONE-TIME: fetch M&P's destination-city list via API and seed it into
   * courier_city_mappings as platform (company_id=null) rows — the same shape
   * the static seeder writes for the other couriers. M&P has no numeric city
   * code, so city_code stores the exact API city name (trimmed) and city_name
   * the normalized (lowercased) match key. Idempotent: replaces the mnp seed set
   * on each run. Requires M&P creds already saved. Owner/admin only.
   */
  @Post('mnp/seed-cities')
  async mnpSeedCities(@CurrentUser() user: { companyId: number }) {
    const { creds } = await this.registry.requireCredentials(user.companyId, 'mnp');
    const adapter = this.registry.getAdapter('mnp') as MnpAdapter;
    const names = await adapter.listCities(creds as MnpCredentials);
    // Dedupe by normalized name (M&P returns near-dup names w/ trailing spaces).
    const byKey = new Map<string, string>();
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, name);
    }
    const data = Array.from(byKey.entries()).map(([cityName, original]) => ({
      company_id: null as unknown as number,
      courier_type: 'mnp' as CourierType,
      city_name: cityName,
      city_code: original,
      is_default_courier: false,
    }));
    // Replace the platform mnp seed set (leaves tenant-override rows untouched).
    await this.prisma.courierCityMapping.deleteMany({
      where: { company_id: null, courier_type: 'mnp' },
    });
    if (data.length) {
      await this.prisma.courierCityMapping.createMany({ data, skipDuplicates: true });
    }
    return { seeded: data.length };
  }

  // ── TCS helpers (owner/admin) ─────────────────────────────────────────────

  private async tcs(companyId: number): Promise<{ adapter: TcsAdapter; creds: TcsCredentials }> {
    const { creds } = await this.registry.requireCredentials(companyId, 'tcs');
    return { adapter: this.registry.getAdapter('tcs') as TcsAdapter, creds: creds as TcsCredentials };
  }

  /** TCS cost centers for the account (pickup / return addresses). */
  @Get('tcs/cost-centers')
  async tcsCostCenters(@CurrentUser() user: { companyId: number }) {
    const { adapter, creds } = await this.tcs(user.companyId);
    return this.tcsCall(() => adapter.listCostCenters(creds));
  }

  /** TCS's own delivery-status vocabulary + what CodesApp maps each code to. */
  @Get('tcs/status-codes')
  async tcsStatusCodes(@CurrentUser() user: { companyId: number }) {
    const { adapter, creds } = await this.tcs(user.companyId);
    return this.tcsCall(() => adapter.statusList(creds));
  }

  /** Raw TCS shipper-advice catalogue (actions + details) — diagnostics. */
  @Get('tcs/advice-actions')
  async tcsAdviceActions(@CurrentUser() user: { companyId: number }) {
    const { adapter, creds } = await this.tcs(user.companyId);
    return this.tcsCall(() => adapter.adviceCatalogue(creds));
  }

  /**
   * Fetch TCS's Pakistan city list and seed it as platform city mappings
   * (company_id=null): city_name = lowercased name, city_code = TCS code
   * ("KHI"). Idempotent — replaces the tcs seed set; tenant overrides stay.
   */
  @Post('tcs/seed-cities')
  async tcsSeedCities(@CurrentUser() user: { companyId: number }) {
    return { seeded: await this.seedTcsCities(user.companyId) };
  }

  private async seedTcsCities(companyId: number): Promise<number> {
    const { adapter, creds } = await this.tcs(companyId);
    const cities = await this.tcsCall(() => adapter.listCities(creds));
    const byKey = new Map<string, string>();
    for (const c of cities) {
      const key = c.name.replace(/\s+/g, ' ').trim().toLowerCase();
      if (key && !byKey.has(key)) byKey.set(key, c.code.trim().toUpperCase());
    }
    if (!byKey.size) throw new BadRequestException('TCS returned no cities.');
    const data = [...byKey.entries()].map(([cityName, code]) => ({
      company_id: null as unknown as number,
      courier_type: 'tcs' as CourierType,
      city_name: cityName,
      city_code: code,
      is_default_courier: false,
    }));
    await this.prisma.courierCityMapping.deleteMany({ where: { company_id: null, courier_type: 'tcs' } });
    await this.prisma.courierCityMapping.createMany({ data, skipDuplicates: true });
    return data.length;
  }

  /** Turn a TCS failure into a clean 400 with TCS's own message. */
  private async tcsCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BadRequestException((err as Error)?.message || 'TCS request failed.');
    }
  }

  /** RapidXpk webhook status card: TEST/LIVE mode, signing secret stored, and
   *  RapidXpk's own last-success/last-error for our URL. */
  @Get('rapidxpk/webhook')
  async rapidxpkWebhook(@CurrentUser() user: { companyId: number }) {
    return this.rapidxpk.status(user.companyId);
  }

  /** Re-register CodesApp's webhook with RapidXpk (issues a new signing secret). */
  @Post('rapidxpk/register-webhook')
  async rapidxpkRegisterWebhook(@CurrentUser() user: { companyId: number }) {
    return this.rapidxpk.registerWebhook(user.companyId);
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
      if ((HIDDEN_CRED_KEYS[courierType] ?? []).includes(k) || k === 'ecomToken') continue;
      const val = typeof raw === 'string' ? raw : String(raw ?? '');
      if (secretKeys.includes(k)) {
        if (val.trim()) merged[k] = val.trim(); // blank secret = keep existing
      } else {
        merged[k] = val;
      }
    }
    // RapidXpk: reject a bad key BEFORE saving (RapidXpk's own message).
    if (courierType === 'rapidxpk') {
      await this.rapidxpk.assertKeyValid(merged as unknown as RapidxpkCredentials);
    }
    // TCS: validate BEFORE saving (never books): bearer token via a dummy
    // tracking lookup, then username/password via a fresh e-com token, which is
    // stored (encrypted) with its expiry. Then prefill pickup from the cost center.
    if (courierType === 'tcs') {
      const tcs = this.registry.getAdapter('tcs') as TcsAdapter;
      delete merged.environment;
      // Legacy: generate the bearer token from an old Client ID/Secret.
      if (!String(merged.bearerToken ?? '').trim() && merged.clientId?.trim() && merged.clientSecret?.trim()) {
        merged.bearerToken = await this.tcsCall(() =>
          tcs.generateLegacyBearer(merged.clientId.trim(), merged.clientSecret.trim()),
        );
      }
      const required: Array<[string, string]> = [
        ['bearerToken', 'Bearer token'],
        ['username', 'Username'],
        ['password', 'Password'],
        ['accountNo', 'Account number'],
        ['costCenterCode', 'Cost center code'],
      ];
      const missing = required.filter(([k]) => !String(merged[k] ?? '').trim()).map(([, l]) => l);
      if (missing.length) throw new BadRequestException(`TCS: fill in ${missing.join(', ')}.`);
      // A changed identity invalidates the stored e-com token.
      if (['bearerToken', 'username', 'password'].some((k) => (base[k] ?? '') !== (merged[k] ?? ''))) {
        delete merged.ecomToken;
        delete merged.ecomTokenExpiry;
      }
      const c = merged as unknown as TcsCredentials;
      const { ecomToken, expiry } = await this.tcsCall(() => tcs.validateConnection(c));
      merged.ecomToken = ecomToken;
      if (expiry) merged.ecomTokenExpiry = expiry;
      else delete merged.ecomTokenExpiry;
      if (!merged.pickupAddress || !merged.pickupCity || !merged.pickupPhone) {
        const centers = await tcs
          .listCostCenters(c)
          .catch(() => [] as Awaited<ReturnType<TcsAdapter['listCostCenters']>>);
        const want = String(merged.costCenterCode).trim().toLowerCase();
        const cc = centers.find(
          (x) => x.code.toLowerCase() === want || x.code.toLowerCase().split(/\s*-\s*/)[0] === want,
        );
        if (cc) {
          if (!merged.pickupAddress) merged.pickupAddress = cc.pickupAddress;
          if (!merged.pickupCity) merged.pickupCity = cc.city;
          if (!merged.pickupPhone) merged.pickupPhone = cc.phone;
          if (!merged.shipperName) merged.shipperName = cc.name;
        }
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
    // RapidXpk: mirror cities served into city mapping, and (re)register our
    // webhook when the key changed or no signing secret is stored yet. A
    // registration failure never undoes the save — it's reported back so the
    // settings card can offer "Re-register".
    let webhookError: string | null = null;
    if (courierType === 'rapidxpk') {
      await this.rapidxpk.syncCities(user.companyId, merged.citiesServed);
      const keyChanged = (base.apiKey ?? '') !== (merged.apiKey ?? '');
      if (keyChanged || !row.webhook_secret_encrypted) {
        try {
          await this.rapidxpk.registerWebhook(user.companyId);
        } catch (err) {
          webhookError = (err as Error)?.message ?? 'Webhook registration failed.';
        }
      }
    }
    // TCS: seed its city list once (cities drive booking + routing).
    if (courierType === 'tcs') {
      const seeded = await this.prisma.courierCityMapping.count({
        where: { company_id: null, courier_type: 'tcs' },
      });
      if (!seeded) {
        try {
          await this.seedTcsCities(user.companyId);
        } catch (err) {
          webhookError = `Saved, but TCS cities could not be loaded: ${(err as Error)?.message}`;
        }
      }
    }
    return {
      courierType,
      configured: true,
      webhookUrl: `/webhooks/couriers/${courierType}/${row.webhook_key}`,
      ...(webhookError ? { webhookError } : {}),
    };
  }

  /**
   * Activate / deactivate a courier for NEW bookings WITHOUT removing its
   * credentials. Flips `booking_enabled` only — `is_active` (and therefore
   * webhook routing + status sync + all operations on existing orders) is left
   * untouched, so a deactivated courier's in-flight parcels keep working.
   */
  @Patch(':courierType/booking')
  async setBooking(
    @CurrentUser() user: { companyId: number },
    @Param('courierType') courierType: CourierType,
    @Body() dto: SetCourierBookingDto,
  ) {
    if (!COURIER_TYPES.includes(courierType)) {
      throw new NotFoundException(`Unknown courier type: ${courierType}`);
    }
    const existing = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(
        `${courierType} is not configured — add credentials before activating it.`,
      );
    }
    await this.prisma.courierCredential.update({
      where: { company_id_courier_type: { company_id: user.companyId, courier_type: courierType } },
      data: { booking_enabled: dto.enabled },
    });
    return { courierType, bookingEnabled: dto.enabled };
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
    // Only couriers offered for new bookings appear in city coverage — a
    // deactivated courier shouldn't be presented as a routing option.
    const active = await this.registry.getBookableCouriers(user.companyId);
    return this.cityMapping.coverage(user.companyId, active);
  }

  /** Per-city × courier delivery performance (settled parcels, 21–180 days)
   *  + 90-day order value per city — the City → courier grid's rates and
   *  "best pick". Read-only; joins to `city-coverage` on `cityName`. */
  @Get('city-performance')
  async cityPerformance(@CurrentUser() user: { companyId: number }) {
    return this.cityMapping.performance(user.companyId);
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
