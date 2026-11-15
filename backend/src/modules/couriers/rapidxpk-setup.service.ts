import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import {
  keyMode,
  RapidxpkAdapter,
  RapidxpkApiError,
  RapidxpkCredentials,
} from './adapters/rapidxpk.adapter';

/** Split the "cities served" field (comma / newline separated) into a deduped
 *  list of display names, preserving the first casing typed. */
export function parseCitiesServed(raw: string | undefined): string[] {
  const seen = new Map<string, string>();
  for (const part of String(raw ?? '').split(/[,\n;]+/)) {
    const name = part.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

/**
 * RapidXpk-specific setup that runs around the generic credential save:
 *  - validate the API key BEFORE saving (a 401 rejects the save),
 *  - register CodesApp's per-tenant webhook URL with RapidXpk and keep the
 *    one-time signing secret (encrypted, `webhook_secret_encrypted`),
 *  - mirror "cities served" into tenant-scoped courier_city_mappings rows so the
 *    existing booking/suggestion/coverage logic works unchanged.
 */
@Injectable()
export class RapidxpkSetupService {
  private readonly logger = new Logger(RapidxpkSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly adapter: RapidxpkAdapter,
  ) {}

  /** Throws a 400 with RapidXpk's own message when the key is rejected. */
  async assertKeyValid(creds: RapidxpkCredentials): Promise<'test' | 'live'> {
    if (!keyMode(creds.apiKey)) {
      throw new BadRequestException('RapidXpk API key must start with rxp_test_ or rxp_live_.');
    }
    try {
      return await this.adapter.validateKey(creds);
    } catch (err) {
      if (err instanceof RapidxpkApiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
        throw new BadRequestException(`RapidXpk rejected the API key: ${err.message}`);
      }
      // Network / 5xx — don't block saving a probably-fine key.
      this.logger.warn(`RapidXpk key check inconclusive: ${(err as Error)?.message ?? err}`);
      return keyMode(creds.apiKey) ?? 'live';
    }
  }

  webhookUrl(webhookKey: string): string {
    const origin = String(this.config.get('APP_URL') ?? 'https://apps.codentra.pk').replace(/\/+$/, '');
    return `${origin}/webhooks/couriers/rapidxpk/${webhookKey}`;
  }

  /** (Re)register our webhook; stores the returned signing secret. */
  async registerWebhook(companyId: number): Promise<{ url: string }> {
    const row = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: companyId, courier_type: 'rapidxpk' } },
    });
    if (!row) throw new BadRequestException('Save the RapidXpk API key first.');
    const creds = JSON.parse(this.encryption.decrypt(row.credentials_encrypted)) as RapidxpkCredentials;
    const url = this.webhookUrl(row.webhook_key);
    let secret: string;
    try {
      ({ secret } = await this.adapter.registerWebhook(creds, url));
    } catch (err) {
      const msg = err instanceof RapidxpkApiError ? err.message : (err as Error)?.message;
      throw new BadRequestException(`RapidXpk webhook registration failed: ${msg}`);
    }
    await this.prisma.courierCredential.update({
      where: { id: row.id },
      data: { webhook_secret_encrypted: this.encryption.encrypt(secret) },
    });
    this.logger.log(`RapidXpk webhook registered for company ${companyId}: ${url}`);
    return { url };
  }

  /** Make tenant rapidxpk city rows EQUAL the cities-served list. */
  async syncCities(companyId: number, citiesServed: string | undefined): Promise<number> {
    const cities = parseCitiesServed(citiesServed);
    const keep = cities.map((c) => c.toLowerCase());
    await this.prisma.courierCityMapping.deleteMany({
      where: {
        company_id: companyId,
        courier_type: 'rapidxpk',
        ...(keep.length ? { city_name: { notIn: keep } } : {}),
      },
    });
    for (const name of cities) {
      await this.prisma.courierCityMapping.upsert({
        where: {
          company_id_courier_type_city_name: {
            company_id: companyId,
            courier_type: 'rapidxpk',
            city_name: name.toLowerCase(),
          },
        },
        create: {
          company_id: companyId,
          courier_type: 'rapidxpk',
          city_name: name.toLowerCase(),
          city_code: name,
          is_default_courier: false,
        },
        update: { city_code: name },
      });
    }
    return cities.length;
  }

  /** Settings status card: mode, whether a signing secret is stored, and
   *  RapidXpk's own view of the webhook (last success / failure). */
  async status(companyId: number) {
    const row = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: companyId, courier_type: 'rapidxpk' } },
    });
    if (!row) return { configured: false };
    let creds: RapidxpkCredentials | null = null;
    try {
      creds = JSON.parse(this.encryption.decrypt(row.credentials_encrypted));
    } catch {
      creds = null;
    }
    let remote: unknown = null;
    let remoteError: string | null = null;
    if (creds?.apiKey) {
      try {
        remote = await this.adapter.getWebhook(creds);
      } catch (err) {
        remoteError = err instanceof RapidxpkApiError ? err.message : (err as Error)?.message ?? 'error';
      }
    }
    return {
      configured: true,
      mode: keyMode(creds?.apiKey),
      registered: !!row.webhook_secret_encrypted || !!creds?.webhookSecret?.trim(),
      url: this.webhookUrl(row.webhook_key),
      remote,
      remoteError,
      syncCursor: row.sync_cursor ?? null,
    };
  }
}
