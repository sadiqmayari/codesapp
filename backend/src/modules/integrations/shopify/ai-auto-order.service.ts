import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { AiService } from '../../ai/ai.service';
import { InboxService } from '../../inbox/inbox.service';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { normalizePhone } from '../../../common/utils/phone';
import { ShopifyService } from './shopify.service';

/** Label applied when the AI hands a chat off to a human (mirrors BotsModule). */
const AI_HANDOFF_LABEL = 'needs-human';
/** Label applied to a conversation where the AI auto-created an order. */
const AI_ORDER_LABEL = 'ai-order';

interface AutoOrderJob {
  companyId: number;
  conversationId: number;
  messageId: number;
}

/**
 * Phase 3 — fully-automated AI order creation (Shopify). Lives in ShopifyModule
 * (which already has ShopifyService + InboxService) and is reached from the
 * BotsModule autopilot path purely via the `ai-order` job queue, so no
 * BotsModule ↔ InboxModule ↔ ShopifyModule import cycle is introduced.
 *
 * Flow: an autopilot inbound message on an auto-order-enabled tenant enqueues an
 * `ai-order` job. This worker asks the AI to extract a draft; only when the
 * customer has CONFIRMED a complete order (readyToCreate) and the products
 * resolve does it create the order, mark the conversation, and send a
 * confirmation. Otherwise it falls back to the normal auto-reply (by enqueueing
 * an `ai` job with skipOrder) — or hands off to a human if the order was
 * confirmed but incomplete. Idempotent: one auto-order per conversation.
 */
@Injectable()
export class AiAutoOrderService implements OnModuleInit {
  private readonly logger = new Logger(AiAutoOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly ai: AiService,
    private readonly shopify: ShopifyService,
    private readonly inbox: InboxService,
  ) {}

  onModuleInit(): void {
    // Concurrency 1: the atomic claim below already prevents double-creation,
    // and order creation is low-volume — no need for parallel slots.
    this.jobQueue.registerWorker(
      'ai-order',
      (p) => this.process(p as AutoOrderJob),
      1,
    );
  }

  async enqueue(job: AutoOrderJob): Promise<void> {
    try {
      await this.jobQueue.enqueue('ai-order', job);
    } catch (e) {
      this.logger.warn(
        `ai-order enqueue failed for convo ${job.conversationId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async process(job: AutoOrderJob): Promise<void> {
    const convo = await this.prisma.conversation.findFirst({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        deleted_at: null,
      },
      select: {
        id: true,
        ai_order_created_at: true,
        contact: { select: { name: true, phone: true } },
        company: {
          select: { default_country_code: true, ai_auto_order_enabled: true },
        },
      },
    });
    // Gone, toggle turned off, or an order was already auto-created here → just
    // run the normal auto-reply instead.
    if (
      !convo ||
      !convo.company?.ai_auto_order_enabled ||
      convo.ai_order_created_at
    ) {
      return this.fallbackReply(job);
    }

    let draft;
    try {
      draft = await this.ai.draftOrder(
        job.companyId,
        null,
        job.conversationId,
      );
    } catch (e) {
      if (e instanceof ForbiddenException) return this.fallbackReply(job);
      throw e; // genuine error → let the queue retry
    }

    // Not an explicit, complete confirmation → answer normally.
    if (!draft.readyToCreate) return this.fallbackReply(job);

    // Resolve each product query to its top variant (best-effort).
    const lineItems: Array<{ variantId: string; quantity: number }> = [];
    for (const it of draft.items) {
      try {
        const hits = await this.shopify.searchProducts(
          job.companyId,
          it.productQuery,
        );
        const v = hits[0];
        if (v) lineItems.push({ variantId: v.variantId, quantity: it.quantity });
      } catch {
        /* skip unresolved product */
      }
    }

    const country =
      draft.customer.countryCode ||
      convo.company?.default_country_code ||
      'PK';
    const name = (draft.customer.name || convo.contact?.name || '').trim();
    const phone = normalizePhone(
      draft.customer.phone || convo.contact?.phone || '',
      country,
    );
    const address1 = (draft.customer.address1 || '').trim();
    const city = (draft.customer.city || '').trim();

    // The model said "ready" but the data is actually incomplete → don't create
    // a wrong order; hand off to a human.
    if (!lineItems.length || !name || !phone || !address1 || !city) {
      return this.handoff(
        job.companyId,
        job.conversationId,
        'order confirmed but details incomplete for auto-creation',
      );
    }

    // Atomically claim the single auto-order slot for this conversation so two
    // overlapping confirmations can't create duplicate orders.
    const claim = await this.prisma.conversation.updateMany({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        ai_order_created_at: null,
      },
      data: { ai_order_created_at: new Date() },
    });
    if (claim.count === 0) return; // someone else already created it

    try {
      const order = await this.shopify.createOrder(job.companyId, {
        lineItems,
        customerName: name,
        phone,
        address1,
        city,
        countryCode: country,
        note: draft.note || undefined,
        tags: ['CodesApp', 'AI auto-order'],
        prepaid: draft.paymentMethod === 'prepaid',
      });

      // Confirmation message (best-effort — we're inside the 24h window).
      try {
        await this.inbox.sendMessage(job.companyId, job.conversationId, {
          type: SendMessageType.text,
          content:
            `✅ Your order ${order.orderName} has been placed` +
            `${draft.paymentMethod === 'prepaid' ? '' : ' (Cash on Delivery)'}` +
            `. Thank you! Our team will be in touch with the details.`,
        });
      } catch (e) {
        this.logger.warn(
          `auto-order confirmation send failed (convo ${job.conversationId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
      this.logger.log(
        `AI auto-created Shopify order ${order.orderName} for conversation ${job.conversationId}`,
      );
    } catch (e) {
      // Creation failed → release the claim and hand off so a human completes it.
      await this.prisma.conversation
        .updateMany({
          where: { id: job.conversationId, company_id: job.companyId },
          data: { ai_order_created_at: null },
        })
        .catch(() => undefined);
      await this.handoff(
        job.companyId,
        job.conversationId,
        `auto order creation failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Run the normal auto-reply instead (skipOrder stops an enqueue loop). */
  private async fallbackReply(job: AutoOrderJob): Promise<void> {
    try {
      await this.jobQueue.enqueue('ai', { ...job, skipOrder: true });
    } catch (e) {
      this.logger.warn(
        `fallback ai reply enqueue failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Flag for a human: pending + mute per-chat auto-pilot + needs-human label. */
  private async handoff(
    companyId: number,
    conversationId: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'pending', ai_autoreply: false },
      });
      await this.label(companyId, conversationId, AI_HANDOFF_LABEL);
      this.logger.log(
        `AI auto-order handoff for conversation ${conversationId}: ${reason}`,
      );
    } catch (e) {
      this.logger.warn(
        `auto-order handoff failed (convo ${conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async label(
    companyId: number,
    conversationId: number,
    label: string,
  ): Promise<void> {
    await this.prisma.conversationLabel
      .upsert({
        where: {
          conversation_id_label: { conversation_id: conversationId, label },
        },
        create: { company_id: companyId, conversation_id: conversationId, label },
        update: {},
      })
      .catch(() => undefined);
  }
}
