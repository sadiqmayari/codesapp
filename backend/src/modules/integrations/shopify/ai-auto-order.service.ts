import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { AiService, DraftOrderResult } from '../../ai/ai.service';
import { InboxService } from '../../inbox/inbox.service';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { normalizePhone } from '../../../common/utils/phone';
import { ShopifyService } from './shopify.service';

/** Label applied when the AI hands a chat off to a human (mirrors BotsModule). */
const AI_HANDOFF_LABEL = 'needs-human';
/** Label applied to a conversation where the AI auto-created an order. */
const AI_ORDER_LABEL = 'ai-order';
/** A pending confirmation older than this is treated as stale (re-ask). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
        ai_autoreply: true,
        ai_order_created_at: true,
        ai_pending_order_at: true,
        contact: { select: { name: true, phone: true } },
        company: {
          select: {
            default_country_code: true,
            ai_auto_order_enabled: true,
            ai_auto_order_all_enabled: true,
            ai_autoreply_enabled: true,
          },
        },
      },
    });
    // Gone, master toggle off, or an order was already auto-created here → just
    // run the normal auto-reply instead.
    if (
      !convo ||
      !convo.company?.ai_auto_order_enabled ||
      convo.ai_order_created_at
    ) {
      return this.fallbackReply(job);
    }

    // Eligibility — scope A: this chat is explicitly in per-chat auto-pilot;
    // scope B: workspace "auto-order for every auto-replied chat" is on AND the
    // AI is answering this chat (per-chat override or workspace default).
    const effectiveAuto =
      convo.ai_autoreply ?? convo.company.ai_autoreply_enabled ?? false;
    const scopeA = convo.ai_autoreply === true;
    const scopeB = convo.company.ai_auto_order_all_enabled === true && effectiveAuto;
    if (!scopeA && !scopeB) {
      return this.fallbackReply(job);
    }

    let draft: DraftOrderResult;
    try {
      draft = await this.ai.draftOrder(job.companyId, null, job.conversationId);
    } catch (e) {
      if (e instanceof ForbiddenException) return this.fallbackReply(job);
      throw e; // genuine error → let the queue retry
    }

    const country =
      draft.customer.countryCode || convo.company.default_country_code || 'PK';
    const name = (draft.customer.name || convo.contact?.name || '').trim();
    const phone = normalizePhone(
      draft.customer.phone || convo.contact?.phone || '',
      country,
    );
    const address1 = (draft.customer.address1 || '').trim();
    const city = (draft.customer.city || '').trim();
    const complete =
      draft.items.length > 0 && !!name && !!phone && !!address1 && !!city;

    const pendingFresh =
      !!convo.ai_pending_order_at &&
      Date.now() - new Date(convo.ai_pending_order_at).getTime() <
        PENDING_TTL_MS;

    // ── Confirm-before-create, step 1: no pending confirmation yet ──────────
    // Never create silently. If we have a complete order, send the customer a
    // summary and WAIT for an explicit confirmation; otherwise reply normally
    // (the AI naturally asks for whatever is missing).
    if (!pendingFresh) {
      if (!complete) return this.fallbackReply(job);
      await this.storePending(job, draft);
      await this.send(job, this.buildOrderSummary(draft, name, phone, address1, city));
      return;
    }

    // ── Confirm-before-create, step 2: a confirmation is pending ────────────
    // Only create once the customer has clearly affirmed — the AI re-evaluates
    // their latest reply in context and sets readyToCreate. Anything else (a
    // question, small talk, an edit that isn't yet a yes) → reply normally and
    // KEEP the pending order so a later "yes" still lands.
    if (!draft.readyToCreate || !complete) {
      return this.fallbackReply(job);
    }

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

    // Confirmed but no products resolve in the store → don't create a wrong
    // order; hand off to a human.
    if (!lineItems.length) {
      return this.handoff(
        job.companyId,
        job.conversationId,
        'order confirmed but no products resolved for auto-creation',
      );
    }

    // Atomically claim the single auto-order slot for this conversation so two
    // overlapping confirmations can't create duplicate orders. Clears the
    // pending marker in the same write.
    const claim = await this.prisma.conversation.updateMany({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        ai_order_created_at: null,
      },
      data: {
        ai_order_created_at: new Date(),
        ai_pending_order: Prisma.DbNull,
        ai_pending_order_at: null,
      },
    });
    if (claim.count === 0) return; // someone else already created it

    // Compute the store's shipping rate for this cart + destination and attach
    // the first one (mirrors the Create-order modal, which auto-selects rate 0)
    // so auto-created orders carry shipping charges. Best-effort: no rate → no
    // shipping line (same as a manual order for a destination with no rates).
    let shippingLine: { title: string; price: number } | undefined;
    try {
      const rates = await this.shopify.getShippingRates(job.companyId, {
        lineItems,
        address1,
        city,
        countryCode: country,
      });
      const r = Array.isArray(rates) ? rates[0] : undefined;
      if (r) shippingLine = { title: r.title, price: parseFloat(r.amount) || 0 };
    } catch (e) {
      this.logger.warn(
        `auto-order shipping-rate lookup failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

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
        shippingLine,
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

  /** Persist the extracted draft as a pending confirmation (best-effort). */
  private async storePending(
    job: AutoOrderJob,
    draft: DraftOrderResult,
  ): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: job.conversationId },
        data: {
          ai_pending_order: draft as unknown as Prisma.InputJsonValue,
          ai_pending_order_at: new Date(),
        },
      })
      .catch((e) =>
        this.logger.warn(
          `store pending order failed (convo ${job.conversationId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
  }

  /** Send a text message to the conversation (best-effort, never throws). */
  private async send(job: AutoOrderJob, content: string): Promise<void> {
    try {
      await this.inbox.sendMessage(job.companyId, job.conversationId, {
        type: SendMessageType.text,
        content,
      });
    } catch (e) {
      this.logger.warn(
        `auto-order message send failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Plain-language order summary the customer confirms before we create it. */
  private buildOrderSummary(
    draft: DraftOrderResult,
    name: string,
    phone: string,
    address1: string,
    city: string,
  ): string {
    const items = draft.items
      .map((i) => `• ${i.quantity} × ${i.productQuery}`)
      .join('\n');
    const payment =
      draft.paymentMethod === 'prepaid' ? 'Prepaid' : 'Cash on Delivery';
    return (
      `📋 Please confirm your order:\n\n` +
      `${items}\n\n` +
      `Name: ${name}\n` +
      `Phone: ${phone}\n` +
      `Address: ${address1}, ${city}\n` +
      `Payment: ${payment}\n\n` +
      `Reply YES to place the order, or tell me what to change.`
    );
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
