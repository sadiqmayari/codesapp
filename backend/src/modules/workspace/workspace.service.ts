import { Injectable } from '@nestjs/common';
import { CacheService } from '../../common/services/cache.service';
import { MetaClientService } from '../inbox/meta-client.service';

/**
 * Small per-tenant workspace facts for the app shell (navbar). Keeps the Meta
 * lookup off the hot `/auth/me` path and out of AuthModule (which InboxModule
 * already imports — importing it back would be circular).
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly meta: MetaClientService,
    private readonly cache: CacheService,
  ) {}

  /**
   * The tenant's connected WhatsApp display number, resolved from Meta ONCE per
   * tenant and cached (the number effectively never changes). Misses are cached
   * briefly so a just-onboarded tenant picks its number up without a long wait.
   * Never throws — null when the tenant isn't onboarded / has no number.
   */
  async getWhatsAppNumber(companyId: number): Promise<{ number: string | null }> {
    const key = `whatsapp-number:${companyId}`;
    const cached = this.cache.get<string | null>(key);
    if (cached !== undefined) return { number: cached };
    const number = await this.meta.getDisplayPhoneNumber(companyId);
    this.cache.set(key, number, number ? 24 * 60 * 60 : 5 * 60);
    return { number };
  }
}
