import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { JobQueueService } from '../../common/services/job-queue.service';

interface CachedEndpoint {
  id: number;
  events: string[];
}

export interface WebhookJobPayload {
  webhookEndpointId: number;
  event: string;
  companyId: number;
  data: unknown;
  enqueuedAt: string;
}

const CACHE_TTL_SEC = 60;

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly jobQueue: JobQueueService,
  ) {}

  static cacheKey(companyId: number): string {
    return `webhook-endpoints:${companyId}`;
  }

  static featureKey(companyId: number): string {
    return `webhook-feature:${companyId}`;
  }

  invalidate(companyId: number): void {
    this.cache.del(WebhookDispatcherService.cacheKey(companyId));
  }

  /**
   * Is the outbound-webhook feature included in this company's plan?
   * Gated on `subscriptions.webhook_enabled`. Cached 5m (same staleness window
   * as the PlanGuard subscription cache — a plan edit takes effect within 5m).
   * Defaults to FALSE when no subscription is resolvable (fail-closed: a paid
   * feature should never be granted by accident).
   */
  async isWebhookFeatureEnabled(companyId: number): Promise<boolean> {
    const key = WebhookDispatcherService.featureKey(companyId);
    const cached = this.cache.get<boolean>(key);
    if (cached !== undefined) return cached;

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscription: { select: { webhook_enabled: true } } },
    });
    const enabled = company?.subscription?.webhook_enabled ?? false;
    this.cache.set(key, enabled, 300);
    return enabled;
  }

  /**
   * Loads active endpoints for the company subscribed to `event`, enqueues one
   * `'webhook'` job per matching endpoint, and returns immediately. Never
   * throws to the caller — webhook fan-out must not break business flows.
   */
  async dispatch(
    companyId: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    try {
      // Plan gate: if the company's plan doesn't include webhooks, deliver
      // nothing — even for endpoints created while a previous plan allowed it.
      if (!(await this.isWebhookFeatureEnabled(companyId))) return;

      const endpoints = await this.loadActiveEndpoints(companyId);
      const matching = endpoints.filter((e) => e.events.includes(event));
      for (const ep of matching) {
        const payload: WebhookJobPayload = {
          webhookEndpointId: ep.id,
          event,
          companyId,
          data,
          enqueuedAt: new Date().toISOString(),
        };
        await this.jobQueue.enqueue('webhook', payload);
      }
    } catch (err) {
      this.logger.warn(
        `dispatch(${event}) for company ${companyId} failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async loadActiveEndpoints(
    companyId: number,
  ): Promise<CachedEndpoint[]> {
    const key = WebhookDispatcherService.cacheKey(companyId);
    const cached = this.cache.get<CachedEndpoint[]>(key);
    if (cached) return cached;

    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { id: true, events: true },
    });
    const endpoints: CachedEndpoint[] = rows.map((r) => ({
      id: r.id,
      events: Array.isArray(r.events) ? (r.events as string[]) : [],
    }));
    this.cache.set(key, endpoints, CACHE_TTL_SEC);
    return endpoints;
  }
}
