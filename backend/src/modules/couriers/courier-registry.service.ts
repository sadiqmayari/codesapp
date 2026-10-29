import { Injectable, NotFoundException } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { CourierAdapter } from './adapters/courier-adapter.interface';
import { TraxAdapter } from './adapters/trax.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { PostexAdapter } from './adapters/postex.adapter';
import { RocketAdapter } from './adapters/rocket.adapter';
import { MnpAdapter } from './adapters/mnp.adapter';

export const COURIER_TYPES: CourierType[] = [
  'trax',
  'leopards',
  'postex',
  'rocket',
  'mnp',
];

/**
 * CourierType -> adapter instance, mirroring modules/ai's LlmService
 * provider-resolution pattern. Also owns loading + decrypting a company's
 * stored CourierCredential row, so adapters themselves never touch the DB.
 */
@Injectable()
export class CourierRegistryService {
  // Partial: `manual` is not a real courier and has no adapter (it's fulfilled
  // without booking). getAdapter is never called for it.
  private readonly adapters: Partial<Record<CourierType, CourierAdapter>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    trax: TraxAdapter,
    leopards: LeopardsAdapter,
    postex: PostexAdapter,
    rocket: RocketAdapter,
    mnp: MnpAdapter,
  ) {
    this.adapters = { trax, leopards, postex, rocket, mnp };
  }

  getAdapter(courierType: CourierType): CourierAdapter {
    const adapter = this.adapters[courierType];
    if (!adapter) {
      throw new NotFoundException(`No courier adapter for '${courierType}'.`);
    }
    return adapter;
  }

  /**
   * Couriers whose credentials are present & usable (is_active). This is the
   * "configured" set — it IGNORES the booking_enabled toggle so webhooks and
   * status sync keep working for a deactivated courier's existing orders. Use
   * this only for maintenance paths (status sync); for anything that OFFERS a
   * courier for new work, use getBookableCouriers().
   */
  async getActiveCouriers(companyId: number): Promise<CourierType[]> {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: companyId, is_active: true },
      select: { courier_type: true },
    });
    return rows.map((r) => r.courier_type);
  }

  /**
   * Couriers offered for NEW bookings: configured (is_active) AND not turned off
   * via the settings toggle (booking_enabled). This is the set every courier
   * picker / auto-assignment / city-coverage view should use, so a deactivated
   * courier disappears from new-order routing while its existing orders (served
   * through requireCredentials / sync) keep running untouched.
   */
  async getBookableCouriers(companyId: number): Promise<CourierType[]> {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: companyId, is_active: true, booking_enabled: true },
      select: { courier_type: true },
    });
    return rows.map((r) => r.courier_type);
  }

  /** Whether a single courier may be used for a NEW booking (configured + enabled). */
  async isBookable(companyId: number, courierType: CourierType): Promise<boolean> {
    const row = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: companyId, courier_type: courierType } },
      select: { is_active: true, booking_enabled: true },
    });
    return !!row && row.is_active && row.booking_enabled;
  }

  /** Decrypted credentials JSON for a company's courier, or null if not configured. */
  async getCredentials(
    companyId: number,
    courierType: CourierType,
  ): Promise<unknown | null> {
    const row = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: companyId, courier_type: courierType } },
    });
    if (!row || !row.is_active) return null;
    return JSON.parse(this.encryption.decrypt(row.credentials_encrypted));
  }

  async requireCredentials(
    companyId: number,
    courierType: CourierType,
  ): Promise<{ credentialId: number; creds: unknown }> {
    const row = await this.prisma.courierCredential.findUnique({
      where: { company_id_courier_type: { company_id: companyId, courier_type: courierType } },
    });
    if (!row || !row.is_active) {
      throw new NotFoundException(
        `${courierType} is not configured for this company — add credentials in Settings > Courier.`,
      );
    }
    return {
      credentialId: row.id,
      creds: JSON.parse(this.encryption.decrypt(row.credentials_encrypted)),
    };
  }
}
