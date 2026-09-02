import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';

/**
 * Business Observability + Audit (enterprise hardening — increment 6, spec #12/#7).
 *
 * WHY: the hardening increments already write an append-only `events` log
 * (order.duplicate_prevented, conversation.handoff, tool.failed, order.created). This service turns that log + the tickets table
 * into a DASHBOARD-READY metrics snapshot, and exposes the per-conversation event
 * timeline that answers "why did the AI do this?".
 *
 * Deterministic aggregation, tenant-scoped, cached 5 min (mirrors the analytics
 * module). Read-only — it never mutates state. Metrics that are not yet
 * instrumented (reply acceptance, specialist accuracy) are returned as `null`
 * rather than fabricated, so the dashboard shape is honest and stable.
 *
 * NOTE: the `jobs` queue table is global (no company_id), so queue-failure rate
 * is intentionally NOT part of the tenant snapshot — it is platform-level health.
 */

const CACHE_TTL_SEC = 5 * 60;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 180;

export interface TenantMetrics {
  windowDays: number;
  since: string;
  /** Distinct conversations with an inbound message in the window (denominator). */
  conversations: number;
  handoffs: number;
  handoffRate: number;
  ordersCreated: number;
  orderConversionRate: number;
  duplicateOrdersPrevented: number;
  ticketsCreated: number;
  ticketCreationRate: number;
  toolFailures: number;
  toolFailureRate: number;
  /** Not yet instrumented — honest null rather than a fabricated number. */
  replyAcceptanceRate: number | null;
  specialistAccuracy: number | null;
}

export interface AuditEvent {
  seq: number;
  type: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
}

@Injectable()
export class ObservabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private clampDays(days?: number): number {
    if (!days || !Number.isFinite(days) || days <= 0) return DEFAULT_WINDOW_DAYS;
    return Math.min(Math.floor(days), MAX_WINDOW_DAYS);
  }

  /** Dashboard-ready metrics snapshot for one tenant over the last N days. */
  async tenantMetrics(companyId: number, days?: number): Promise<TenantMetrics> {
    const windowDays = this.clampDays(days);
    const ck = `obs:${companyId}:${windowDays}`;
    const cached = this.cache.get<TenantMetrics>(ck);
    if (cached) return cached;

    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

    const [grouped, ticketsCreated, conversations] = await Promise.all([
      this.prisma.event.groupBy({
        by: ['type'],
        where: { company_id: companyId, created_at: { gte: since } },
        _count: { type: true },
      }),
      this.prisma.supportTicket.count({
        where: { company_id: companyId, created_at: { gte: since } },
      }),
      this.distinctConversations(companyId, since),
    ]);

    const ev: Record<string, number> = {};
    for (const g of grouped) ev[g.type] = g._count.type;

    const rate = (n: number): number =>
      conversations > 0 ? Math.round((n / conversations) * 10000) / 10000 : 0;

    const handoffs = ev['conversation.handoff'] ?? 0;
    const ordersCreated = ev['order.created'] ?? 0;
    const toolFailures = ev['tool.failed'] ?? 0;

    const snapshot: TenantMetrics = {
      windowDays,
      since: since.toISOString(),
      conversations,
      handoffs,
      handoffRate: rate(handoffs),
      ordersCreated,
      orderConversionRate: rate(ordersCreated),
      duplicateOrdersPrevented: ev['order.duplicate_prevented'] ?? 0,
      ticketsCreated,
      ticketCreationRate: rate(ticketsCreated),
      toolFailures,
      toolFailureRate: rate(toolFailures),
      replyAcceptanceRate: null,
      specialistAccuracy: null,
    };

    this.cache.set(ck, snapshot, CACHE_TTL_SEC);
    return snapshot;
  }

  /** Count distinct conversations with an inbound message since `since`. */
  private async distinctConversations(
    companyId: number,
    since: Date,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ c: bigint }>>(
      Prisma.sql`SELECT COUNT(DISTINCT conversation_id) AS c
                 FROM messages
                 WHERE company_id = ${companyId}
                   AND direction = 'inbound'
                   AND timestamp >= ${since}`,
    );
    return rows.length ? Number(rows[0].c) : 0;
  }

  /**
   * The per-conversation event timeline ("why did the AI do this?"). Tenant-scoped
   * to the CONVERSATION aggregate, ordered by the append-only seq.
   */
  async conversationAudit(
    companyId: number,
    conversationId: number,
  ): Promise<AuditEvent[]> {
    const rows = await this.prisma.event.findMany({
      where: {
        company_id: companyId,
        aggregate_type: 'CONVERSATION',
        aggregate_id: BigInt(conversationId),
      },
      orderBy: { seq: 'asc' },
      take: 500,
      select: {
        seq: true,
        type: true,
        actor_type: true,
        payload: true,
        created_at: true,
      },
    });
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      actorType: r.actor_type,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
