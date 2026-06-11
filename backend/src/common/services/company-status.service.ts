import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';

/**
 * Cached "is this company active?" check, used to PAUSE all outbound activity
 * for a suspended (or pending) tenant while still accepting inbound messages.
 *
 * A suspended company's dashboard is already blocked by TenantGuard, but the
 * automation paths (AI auto-reply, keyword bots, auto-order creation,
 * broadcasts, outbound webhooks, the send gateway) run on job queues / webhooks
 * that bypass TenantGuard. They consult this service and bail when the company
 * isn't active, so a non-paying tenant's WhatsApp number goes silent.
 *
 * Short TTL keeps it cheap on hot paths (every inbound message / send); the
 * authoritative mutation points (suspend / reactivate) call `invalidate()` so a
 * status change takes effect immediately.
 */
@Injectable()
export class CompanyStatusService {
  private static readonly TTL_SECONDS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private key(companyId: number): string {
    return `company-active:${companyId}`;
  }

  /** True only when the company's activation_status is 'active'. Cached. */
  async isActive(companyId: number): Promise<boolean> {
    const cached = this.cache.get<boolean>(this.key(companyId));
    if (cached !== undefined) return cached;
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { activation_status: true },
    });
    const active = company?.activation_status === 'active';
    this.cache.set(this.key(companyId), active, CompanyStatusService.TTL_SECONDS);
    return active;
  }

  /** Drop the cached status (call on suspend / reactivate). */
  invalidate(companyId: number): void {
    this.cache.del(this.key(companyId));
  }
}
