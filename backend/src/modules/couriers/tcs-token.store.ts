import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { TcsAdapter, TcsTokenSink } from './adapters/tcs.adapter';

/**
 * Persists TCS's e-com access token + expiry inside the courier's encrypted
 * credential blob, so a long-lived token survives restarts and is shared by
 * the web and worker containers (both read it from the DB). Read-modify-write
 * of one row; never throws, never logs the token.
 */
@Injectable()
export class TcsTokenStore implements TcsTokenSink, OnModuleInit {
  private readonly logger = new Logger(TcsTokenStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly adapter: TcsAdapter,
  ) {}

  onModuleInit() {
    this.adapter.setTokenSink(this);
  }

  async save(credentialId: number, token: string, expiryIso: string | null): Promise<void> {
    await this.patch(credentialId, (blob) => {
      blob.ecomToken = token;
      if (expiryIso) blob.ecomTokenExpiry = expiryIso;
      else delete blob.ecomTokenExpiry;
    });
  }

  async clear(credentialId: number): Promise<void> {
    await this.patch(credentialId, (blob) => {
      delete blob.ecomToken;
      delete blob.ecomTokenExpiry;
    });
  }

  private async patch(credentialId: number, fn: (blob: Record<string, unknown>) => void): Promise<void> {
    try {
      const row = await this.prisma.courierCredential.findUnique({
        where: { id: credentialId },
        select: { id: true, courier_type: true, credentials_encrypted: true },
      });
      if (!row || row.courier_type !== 'tcs') return;
      const blob = JSON.parse(this.encryption.decrypt(row.credentials_encrypted)) as Record<string, unknown>;
      fn(blob);
      await this.prisma.courierCredential.update({
        where: { id: row.id },
        data: { credentials_encrypted: this.encryption.encrypt(JSON.stringify(blob)) },
      });
    } catch (err) {
      this.logger.warn(`Could not store the TCS e-com token for credential ${credentialId}: ${(err as Error)?.name}`);
    }
  }
}
