import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
import { FraudHistory } from './fraud-detector.service';

/**
 * Fraud history collector (enterprise hardening — increment 12). Derives the
 * FraudDetector's `history` counters from signals we can read CHEAPLY and
 * DETERMINISTICALLY from our OWN database — no Shopify round-trip on the
 * pre-triage hot path (that was the explicit reason the counters shipped
 * unwired). Cached per conversation so the escalation check stays light.
 *
 * Wired today (local-only):
 *  - phoneChanges  — distinct delivery phone numbers the customer has typed in
 *                    recent inbound messages (a fraudster who keeps changing the
 *                    contact number). Deduped by last-10 digits.
 *  - modifications — count of orders created in this conversation (events
 *                    `order.created`); many = churn/abuse.
 *
 * Deferred (need Shopify / structured history — left 0, documented):
 *  - addressChanges, failedOrders. A cached Shopify collector can fill these later
 *    without changing the FraudDetector (it already accepts them).
 */

const CACHE_TTL_SEC = 120;
const RECENT_INBOUND = 30;

/** Plausible phone runs (10–13 digits, optional + / leading 0). */
const PHONE_RE = /(?:\+?\d[\s-]?){10,13}/g;

@Injectable()
export class FraudSignalCollectorService {
  private readonly logger = new Logger(FraudSignalCollectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private cacheKey(conversationId: number): string {
    return `fraudhist:${conversationId}`;
  }

  /** Last-10-digit fingerprint of a phone-like token (drops formatting/prefixes). */
  private phoneTail(raw: string): string {
    const d = raw.replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
  }

  /**
   * Collect the local fraud-history counters for a conversation. Never throws —
   * on any error returns empty counters (fraud scoring degrades to text-only).
   */
  async collect(
    companyId: number,
    conversationId: number,
  ): Promise<FraudHistory> {
    const ck = this.cacheKey(conversationId);
    const cached = this.cache.get<FraudHistory>(ck);
    if (cached) return cached;

    let history: FraudHistory = {
      phoneChanges: 0,
      addressChanges: 0,
      failedOrders: 0,
      modifications: 0,
    };
    try {
      const [messages, modifications] = await Promise.all([
        this.prisma.message.findMany({
          where: {
            conversation_id: conversationId,
            company_id: companyId,
            direction: 'inbound',
          },
          orderBy: { timestamp: 'desc' },
          take: RECENT_INBOUND,
          select: { content: true, transcription: true },
        }),
        this.prisma.event.count({
          where: {
            company_id: companyId,
            aggregate_type: 'CONVERSATION',
            aggregate_id: BigInt(conversationId),
            type: 'order.created',
          },
        }),
      ]);

      const tails = new Set<string>();
      for (const m of messages) {
        const text = `${m.content ?? ''} ${m.transcription ?? ''}`;
        for (const match of text.matchAll(PHONE_RE)) {
          const tail = this.phoneTail(match[0]);
          if (tail) tails.add(tail);
        }
      }

      history = {
        phoneChanges: tails.size,
        addressChanges: 0, // deferred (needs Shopify/structured address history)
        failedOrders: 0, // deferred (needs Shopify order status)
        modifications,
      };
    } catch (e) {
      this.logger.debug(
        `fraud history collect failed (convo ${conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    this.cache.set(ck, history, CACHE_TTL_SEC);
    return history;
  }
}
