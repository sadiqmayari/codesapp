import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { loadEffectiveLimits } from '../../common/utils/effective-limits-loader';


interface SubAndUsage {
  limits: { contacts: number; templates: number };
  usage: { contacts: number; templates: number };
}

/**
 * Fires `subscription.limit.warning` exactly once per (period, dimension) when
 * usage crosses 80% but is still under 100%. The 100% hard block is owned by
 * PlanGuard (Phase 1) — this only warns.
 */
@Injectable()
export class LimitWarningService {
  private readonly logger = new Logger(LimitWarningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  private static msUntilMonthEnd(): number {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Math.max(60_000, nextMonth.getTime() - now.getTime());
  }

  private async loadSubAndUsage(
    companyId: number,
  ): Promise<SubAndUsage | null> {
    // Shared loader — the ONE shape stored under cache.subscriptionKey().
    const eff = await loadEffectiveLimits(this.prisma, this.cache, companyId);
    if (!eff) return null;
    const limits = { contacts: eff.contact_limit, templates: eff.template_limit };

    // Contacts/templates current usage = LIVE count of what is stored (the
    // per-month usage_metering counter resets each calendar month and would
    // make warnings reset + never reflect the true cumulative total).
    const [contacts, templates] = await Promise.all([
      this.prisma.contact.count({
        where: { company_id: companyId, deleted_at: null },
      }),
      this.prisma.template.count({
        where: { company_id: companyId, deleted_at: null },
      }),
    ]);
    return { limits, usage: { contacts, templates } };
  }

  async check(companyId: number, dimension: string): Promise<void> {
    const map: Record<string, keyof SubAndUsage['usage']> = {
      contacts: 'contacts',
      contacts_stored: 'contacts',
      templates: 'templates',
      templates_used: 'templates',
    };
    const dim = map[dimension];
    if (!dim) return;

    try {
      const period = new Date().toISOString().slice(0, 7);
      const data = await this.loadSubAndUsage(companyId);
      if (!data) return;

      const limit = data.limits[dim];
      const current = data.usage[dim];
      if (!limit || limit <= 0) return;

      const ratio = current / limit;
      if (ratio < 0.8 || ratio >= 1.0) return;

      const flagKey = `warning:${companyId}:${period}:${dim}`;
      if (this.cache.get<boolean>(flagKey)) return;

      await this.dispatcher.dispatch(
        companyId,
        'subscription.limit.warning',
        { dimension: dim, current, limit, period },
      );
      this.cache.set(
        flagKey,
        true,
        Math.floor(LimitWarningService.msUntilMonthEnd() / 1000),
      );
      this.logger.log(
        `subscription.limit.warning fired for company ${companyId} dim=${dim} (${current}/${limit})`,
      );
    } catch (err) {
      this.logger.warn(
        `limit-warning check failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
