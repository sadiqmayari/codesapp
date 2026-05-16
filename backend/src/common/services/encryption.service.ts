import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PLACEHOLDER_KEY = 'INSECURE_PLACEHOLDER_KEY_32CHARS';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;
  private readonly usingPlaceholder: boolean;

  constructor(private readonly config: ConfigService) {
    const encKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!encKey) {
      this.usingPlaceholder = true;
      this.key = Buffer.from(PLACEHOLDER_KEY, 'utf8');
      this.logger.warn(
        '[encryption] ⚠️  ENCRYPTION_KEY missing — using insecure placeholder, refuse to store new secrets',
      );
      return;
    }
    // Key must be exactly 32 bytes for AES-256
    this.usingPlaceholder = encKey === PLACEHOLDER_KEY;
    if (this.usingPlaceholder) {
      this.logger.warn(
        '[encryption] ⚠️  ENCRYPTION_KEY missing — using insecure placeholder, refuse to store new secrets',
      );
    }
    this.key = Buffer.from(encKey.padEnd(32).slice(0, 32), 'utf8');
  }

  /**
   * True when no real ENCRYPTION_KEY is configured (env missing OR equals the
   * insecure placeholder constant). Callers that store secrets MUST refuse when
   * this returns true (the onboarding token step throws 503).
   */
  isUsingPlaceholderKey(): boolean {
    return this.usingPlaceholder;
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Format: base64(iv:authTag:ciphertext)
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(encryptedBase64: string): string {
    const buf = Buffer.from(encryptedBase64, 'base64');

    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  }
}
