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
  private readonly adapters: Record<CourierType, CourierAdapter>;

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
    return this.adapters[courierType];
  }

  async getActiveCouriers(companyId: number): Promise<CourierType[]> {
    const rows = await this.prisma.courierCredential.findMany({
      where: { company_id: companyId, is_active: true },
      select: { courier_type: true },
    });
    return rows.map((r) => r.courier_type);
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
