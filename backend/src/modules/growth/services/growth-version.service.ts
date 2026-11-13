import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CacheService } from '../../../common/services/cache.service';

/**
 * Per-tenant data version for the Growth dashboards. Every read cache key embeds
 * the version, so a successful ad sync / fact rebuild invalidates all cached
 * Growth responses at once (the old Ad Report "Refresh" re-served the 5-minute
 * cache and looked broken). Also pushes the `growth.updated` socket event.
 */
@Injectable()
export class GrowthVersionService {
  private readonly logger = new Logger(GrowthVersionService.name);
  private gateway?: { emitToCompany(companyId: number, event: string, payload: unknown): void } | null;

  constructor(
    private readonly cache: CacheService,
    private readonly moduleRef: ModuleRef,
  ) {}

  get(companyId: number): number {
    return this.cache.get<number>(`growth:ver:${companyId}`) ?? 1;
  }

  bump(companyId: number, kind: 'order' | 'spend' | 'status' | 'rebuild'): void {
    this.cache.set(`growth:ver:${companyId}`, this.get(companyId) + 1, 7 * 86_400);
    try {
      if (this.gateway === undefined) {
        // Resolved lazily (InboxGateway lives in InboxModule; importing it here
        // would add another edge to the Billing↔Inbox import cycle).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { InboxGateway } = require('../../inbox/inbox.gateway');
        this.gateway = this.moduleRef.get(InboxGateway, { strict: false }) ?? null;
      }
      this.gateway?.emitToCompany(companyId, 'growth.updated', { kind, at: new Date().toISOString() });
    } catch (e) {
      this.gateway = null;
      this.logger.debug(`growth.updated emit skipped: ${(e as Error).message}`);
    }
  }
}
