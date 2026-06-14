import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { PlatformSettingService } from '../../../common/services/platform-setting.service';
import { CompanyStatusService } from '../../../common/services/company-status.service';
import { AiService, DraftOrderResult } from '../../ai/ai.service';
import { InboxService } from '../../inbox/inbox.service';
import { InboxGateway } from '../../inbox/inbox.gateway';
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
    private readonly gateway: InboxGateway,
    private readonly platformSetting: PlatformSettingService,
    private readonly companyStatus: CompanyStatusService,
  ) {}

  onModuleInit(): void {
    // Concurrency 1: the atomic claim below already prevents double-creation,
    // and order creation is low-volume — no need for parallel slots.
    // 180s lease — this job does an LLM draft-order extraction AND Shopify
    // order creation back-to-back; both can be slow, and a double-execution
    // here would create a duplicate order.
    this.jobQueue.registerWorker(
      'ai-order',
      (p) => this.process(p as AutoOrderJob),
      1,
      180,
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
    // Suspended/inactive tenant: never auto-create an order.
    if (!(await this.companyStatus.isActive(job.companyId))) return;

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
        ai_pending_order: true,
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
    // Gone or master toggle off → just run the normal auto-reply instead.
    // NOTE: we do NOT bail on ai_order_created_at here anymore — an existing
    // order means we still want to handle order-STATUS questions below (and the
    // atomic claim later still prevents a duplicate create).
    if (!convo || !convo.company?.ai_auto_order_enabled) {
      return this.fallbackReply(job);
    }

    // Eligibility. AI-active resolution mirrors BotEngineService: an explicit
    // per-chat FALSE always mutes; otherwise active under workspace all-chats or
    // per-chat auto-pilot. scope A: per-chat auto-pilot; scope B: workspace
    // "auto-order for every auto-replied chat" is on AND the AI is answering.
    const allChats = convo.company.ai_autoreply_enabled === true;
    const perChat = convo.ai_autoreply;
    const effectiveAuto =
      perChat === false ? false : allChats || perChat === true;
    const scopeA = perChat === true;
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

    // Order-STATUS questions never create an order — look it up and answer with
    // the real Shopify status, or ask for the order number. This also covers a
    // customer pinging "any update?" on an already-placed order.
    if (draft.intent === 'order_status') {
      return this.handleOrderStatus(job, draft);
    }

    // An order already exists for this conversation (created by the AI OR via the
    // order-confirmation template flow). Do NOT re-enter confirm-before-create —
    // that re-sent the identical "confirm at this price?" message on every
    // customer reply (the repetition glitch). Just reply normally instead.
    const orderAlreadyExists =
      !!convo.ai_order_created_at ||
      !!(await this.prisma.shopifyOrderMessage.findFirst({
        where: {
          conversation_id: job.conversationId,
          company_id: job.companyId,
        },
        select: { id: true },
      }));
    if (orderAlreadyExists) {
      return this.fallbackReply(job);
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
      if (!complete) {
        // Clear buy-intent (≥1 product) but required details still missing →
        // ask the customer for EXACTLY what's missing ourselves. This stops the
        // generic chat brain from improvising a false "order placed/confirmed"
        // reply, and actually drives the order toward completion. No product
        // intent at all → fall back to a normal reply.
        if (draft.items.length > 0) {
          await this.send(
            job,
            this.buildMissingPrompt(draft, name, phone, address1, city),
          );
          return;
        }
        return this.fallbackReply(job);
      }
      await this.storePending(job, draft);
      await this.send(
        job,
        await this.composeSummary(job, draft, name, phone, address1, city),
      );
      return;
    }

    // ── Confirm-before-create, step 2: a confirmation is pending ────────────
    // If the cart CHANGED since the summary (e.g. the customer accepted an
    // upsell / multi-pack), restate the NEW cart and re-confirm — never create a
    // cart the customer didn't just see.
    const pendingItems = this.parsePendingItems(convo.ai_pending_order);
    const cartChanged =
      this.cartSignature(draft.items) !== this.cartSignature(pendingItems);
    if (cartChanged && complete) {
      await this.storePending(job, draft);
      await this.send(
        job,
        await this.composeSummary(job, draft, name, phone, address1, city),
      );
      return;
    }

    // Create only when the order is complete AND the customer has affirmed —
    // either the model judged it (readyToCreate) OR a plain colloquial yes in
    // any language (ok / haan / ji / theek / kar do …). Anything else (a
    // question, a detour like "koe discount") → reply normally and KEEP the
    // pending cart so a later yes still lands.
    const latestInbound = await this.latestInboundText(
      job.companyId,
      job.conversationId,
    );
    const affirmed =
      draft.readyToCreate || this.isOrderAffirmation(latestInbound);
    if (!complete || !affirmed) {
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

  /**
   * Answer an order-status question with the REAL Shopify status (never guessed).
   * If the customer gave an order number → look it up and report status/tracking;
   * if not found → ask them to re-check; if no number → ask for it; on a lookup
   * error (e.g. missing read_orders scope) → hand off to a human.
   */
  private async handleOrderStatus(
    job: AutoOrderJob,
    draft: DraftOrderResult,
  ): Promise<void> {
    if (!draft.orderNumber) {
      await this.send(
        job,
        'Sure — please share your order number (e.g. #1234) so I can check its status for you.',
      );
      return;
    }
    const st = await this.shopify.getOrderStatus(job.companyId, draft.orderNumber);
    if (st.error) {
      return this.handoff(
        job.companyId,
        job.conversationId,
        'order status lookup failed (scope/connection) — needs a human',
      );
    }
    if (!st.found) {
      await this.send(
        job,
        `I couldn't find order #${draft.orderNumber}. Could you double-check the order number?`,
      );
      return;
    }
    const humanize = (s?: string): string =>
      s ? s.replace(/_/g, ' ').toLowerCase() : 'unknown';
    const lines = [`Order ${st.name}`];
    lines.push(`• Delivery: ${humanize(st.fulfillmentStatus)}`);
    // Never surface payment/financial status — COD orders are "unpaid" by design
    // and that must not alarm the customer (Rule F).
    const track = (st.tracking ?? []).filter((t) => t.number || t.url);
    if (track.length) {
      for (const t of track) {
        const bits = [t.company, t.number, t.url].filter(Boolean).join(' ');
        lines.push(`• Tracking: ${bits}`);
      }
    }
    await this.send(job, lines.join('\n'));
  }

  /**
   * Order-confirmation summary in the customer's language (AI-composed from the
   * EXACT structured cart), falling back to the deterministic English summary if
   * the AI call fails. Numbers/items/address are never altered by the model.
   */
  private async composeSummary(
    job: AutoOrderJob,
    draft: DraftOrderResult,
    name: string,
    phone: string,
    address1: string,
    city: string,
  ): Promise<string> {
    try {
      const { text } = await this.ai.composeOrderConfirmation(
        job.companyId,
        job.conversationId,
        {
          items: draft.items.map((i) => ({
            quantity: i.quantity,
            title: i.productQuery,
          })),
          name,
          phone,
          address1,
          city,
          payment: draft.paymentMethod === 'prepaid' ? 'prepaid' : 'cod',
        },
      );
      if (text && text.trim()) return text.trim();
    } catch (e) {
      this.logger.warn(
        `compose order confirmation failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return this.buildOrderSummary(draft, name, phone, address1, city);
  }

  /** Stable signature of a cart's items for change detection (qty + name). */
  private cartSignature(
    items: Array<{ productQuery: string; quantity: number }>,
  ): string {
    return items
      .map((i) => `${(i.productQuery || '').trim().toLowerCase()}|${i.quantity}`)
      .sort()
      .join(';');
  }

  /** Items from a stored pending-order JSON (DraftOrderResult), defensively. */
  private parsePendingItems(
    pending: unknown,
  ): Array<{ productQuery: string; quantity: number }> {
    const raw = (pending as { items?: unknown })?.items;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((it) => {
        const r = (it ?? {}) as Record<string, unknown>;
        const q = Number(r.quantity);
        return {
          productQuery: typeof r.productQuery === 'string' ? r.productQuery : '',
          quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
        };
      })
      .filter((i) => i.productQuery.length > 0);
  }

  /** Latest inbound message text (content or transcription), tenant-scoped. */
  private async latestInboundText(
    companyId: number,
    conversationId: number,
  ): Promise<string> {
    const m = await this.prisma.message.findFirst({
      where: {
        conversation_id: conversationId,
        company_id: companyId,
        direction: 'inbound',
      },
      orderBy: { timestamp: 'desc' },
      select: { content: true, transcription: true },
    });
    return (m?.content?.trim() || m?.transcription?.trim() || '').slice(0, 200);
  }

  /**
   * Whether a short message is a plain affirmation in English/Roman-Urdu/Hindi
   * ("ok", "haan", "ji", "theek", "kar do", "confirm", 👍/✅). Long messages
   * aren't treated as a bare yes (they likely carry a question/change).
   */
  private isOrderAffirmation(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t || t.length > 40) return false;
    if (/^(g|ji|jee|ok|okay|k|haan|han|hn|yes|yep|yup|👍|✅|✓)$/i.test(t)) {
      return true;
    }
    return /(^|\s|,)(yes|yep|yeah|yup|ok|okay|done|confirm|confirmed|sure|haan|han|ji|jee|theek|thik|sahi|pakka|order\s?kar\s?do|order\s?kardo|kar\s?do|kardo|kr\s?do|krdo|place\s?order)(\s|$|!|\.|,|👍|✅)/i.test(
      t,
    );
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

  /** Ask the customer for the specific required fields still missing. */
  private buildMissingPrompt(
    draft: DraftOrderResult,
    name: string,
    phone: string,
    address1: string,
    city: string,
  ): string {
    const items = draft.items
      .map((i) => `${i.quantity} × ${i.productQuery}`)
      .join(', ');
    const need: string[] = [];
    if (!name) need.push('your full name');
    if (!phone) need.push('your phone number');
    if (!address1)
      need.push('your complete delivery address (house no. + street)');
    if (!city) need.push('your city');
    return (
      `Sure${items ? `, to place your order for ${items}` : ''} — please share ` +
      `${need.join(', ')} so I can confirm it for you.`
    );
  }

  /** Run the normal auto-reply instead (skipOrder stops an enqueue loop). */
  private async fallbackReply(job: AutoOrderJob): Promise<void> {
    try {
      // Phase 2: route the conversational fallback to the tool-calling agent
      // when enabled for this tenant; otherwise the legacy decision-brain `ai`
      // worker (skipOrder stops an enqueue loop).
      if (await this.platformSetting.isAiAgentEnabled(job.companyId)) {
        await this.jobQueue.enqueue('ai-agent', {
          companyId: job.companyId,
          conversationId: job.conversationId,
          messageId: job.messageId,
        });
        return;
      }
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
    // Push the label + any status change live so the inbox list/thread update
    // without a manual reload (the list refetches on conversation.updated).
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId,
      addedLabel: label,
    });
  }
}
