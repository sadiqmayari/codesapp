import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as https from 'https';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { CacheService } from '../../../common/services/cache.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { FeatureService } from '../../../common/services/feature.service';
import { OrderIdempotencyService } from '../../../common/services/order-idempotency.service';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import { UsageMeteringService } from '../../usage-metering/usage-metering.service';
import { InboxService } from '../../inbox/inbox.service';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { AiKnowledgeService } from '../../ai/ai-knowledge.service';
import { AiRagService, RagItem } from '../../ai/ai-rag.service';
import { courierTrackingUrl } from '../../couriers/couriers.constants';
import { formatLineItemsSummary } from '../../../common/utils/line-items-summary';

export interface ShopifyOrderPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  order_number?: number | string;
  number?: number | string;
  total_price?: string;
  currency?: string;
  financial_status?: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  fulfillment_status?: string | null;
  phone?: string;
  email?: string;
  total_outstanding?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
  };
  shipping_address?: {
    phone?: string;
    city?: string;
    address1?: string;
    address2?: string;
  };
  billing_address?: { phone?: string };
  line_items?: Array<{ quantity?: number; title?: string }>;
  // Links an order back to its checkout (abandoned-cart conversion marking).
  checkout_token?: string;
  // Populated when a delivery notification is built from a fulfillments/update
  // webhook (normalizeFulfillment) — used by the tracking_* template fields.
  tracking_number?: string;
  tracking_url?: string;
  tracking_company?: string;
  // Populated for abandoned-cart recovery (normalizeCheckout) — the Shopify
  // "complete your purchase" link.
  recovery_url?: string;
}

// Shape of a Shopify checkouts/create|update webhook payload (subset we use).
interface ShopifyCheckoutPayload {
  id?: number | string;
  token?: string;
  abandoned_checkout_url?: string;
  phone?: string;
  email?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
  };
  shipping_address?: { phone?: string; city?: string };
  billing_address?: { phone?: string };
  // Shopify sends variant_id/price/variant_title here — captured into
  // `items_json` so the Create-order modal can pre-fill the cart's products.
  line_items?: Array<{
    quantity?: number;
    title?: string;
    variant_id?: number | string | null;
    variant_title?: string | null;
    price?: string | number | null;
  }>;
  // Cart value — used to prioritise + report "value at risk".
  total_price?: string;
  currency?: string;
  presentment_currency?: string;
}

// Shape of a Shopify fulfillments/update webhook payload (subset we use).
interface ShopifyFulfillmentPayload {
  id?: number | string;
  order_id?: number | string;
  name?: string;
  status?: string;
  shipment_status?: string | null;
  email?: string;
  tracking_number?: string;
  tracking_numbers?: string[];
  tracking_url?: string;
  tracking_urls?: string[];
  tracking_company?: string;
  destination?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    city?: string;
    address1?: string;
    address2?: string;
  };
  line_items?: Array<{ quantity?: number; title?: string }>;
}

// Per-event delivery-notification config (stored as a JSON map keyed by
// event_key on shopify_order_configs.delivery_notifications).
export interface DeliveryNotificationCfg {
  templateId: number | null;
  variableMap: Record<string, string>;
  enabled: boolean;
}

/** One step of a multi-step abandoned-cart recovery sequence. */
export interface AbandonedCartStep {
  delayMinutes: number;
  templateId: number;
  variableMap: Record<string, string>;
}

// The catalogue of supported delivery-notification events + their source.
// `order_*` come from orders/* webhooks; the shipment statuses come from
// fulfillments/update `shipment_status` (only if the carrier reports them).
export const DELIVERY_EVENTS: Array<{
  key: string;
  label: string;
  source: string;
}> = [
  { key: 'order_fulfilled', label: 'Shipped (order fulfilled)', source: 'orders/fulfilled' },
  { key: 'order_cancelled', label: 'Cancelled', source: 'orders/cancelled' },
  { key: 'out_for_delivery', label: 'Out for delivery', source: 'fulfillments/update' },
  { key: 'delivered', label: 'Delivered', source: 'fulfillments/update' },
  { key: 'attempted', label: 'Delivery attempted', source: 'fulfillments/update' },
  { key: 'failed', label: 'Delivery failed', source: 'fulfillments/update' },
  { key: 'abandoned_cart', label: 'Abandoned cart recovery', source: 'checkouts/update' },
  // Raised by CouriersModule, not a Shopify webhook: either our pre-booking
  // address-quality check or a courier's bad-address failure reason. Asks the
  // customer to confirm/correct their delivery address.
  {
    key: 'address_issue',
    label: 'Address needs confirmation',
    source: 'courier / address check',
  },
];
const DELIVERY_EVENT_KEYS = new Set(DELIVERY_EVENTS.map((e) => e.key));

// Shopify shipment_status -> our event_key (only the statuses we notify on).
const SHIPMENT_STATUS_EVENT: Record<string, string> = {
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  attempted_delivery: 'attempted',
  failure: 'failed',
};

type ShopifyJob =
  | { kind: 'send'; companyId: number; shopDomain: string; order: ShopifyOrderPayload }
  | {
      kind: 'tag';
      companyId: number;
      orderMessageId: number;
      decision: 'confirm' | 'cancel';
    }
  | { kind: 'pendingTag'; companyId: number; orderMessageId: number }
  | { kind: 'noWhatsapp'; companyId: number; orderMessageId: number }
  | { kind: 'syncKnowledge'; companyId: number }
  | { kind: 'syncCancellations'; companyId: number }
  | { kind: 'syncOrderSources'; companyId: number }
  | { kind: 'reconcileOrderCarts'; companyId: number; order: ShopifyOrderPayload }
  | {
      kind: 'notify';
      companyId: number;
      eventKey: string;
      order: ShopifyOrderPayload;
    }
  | {
      kind: 'abandonedRecovery';
      companyId: number;
      checkoutToken: string;
      stepIndex?: number;
    };

// Hardcoded (NOT client-configurable) tag applied to a Shopify order when its
// WhatsApp confirmation could not be delivered (wrong number / no WhatsApp).
const NO_WHATSAPP_TAG = '⚠ NO WhatsApp';

// Shopify ships a new stable API version each quarter. Keep newest first;
// the first entry is the default when a company hasn't chosen one.
export const SHOPIFY_API_VERSIONS = [
  '2026-04',
  '2026-01',
  '2025-10',
  '2025-07',
  '2025-04',
  '2025-01',
  '2024-10',
];
const DEFAULT_SHOPIFY_API_VERSION = SHOPIFY_API_VERSIONS[0];
// Fixed (not client-configurable) — phone normalization default.
const DEFAULT_COUNTRY_CODE = '92';
/**
 * Max contacts that may share a name before it's considered too common to
 * identify a shopper (see `isDistinctiveName`). 2 — not 1 — because the very
 * case the name fallback exists for is a shopper who checked out under a
 * SECOND identity, which creates a second contact with the same name.
 */
const NAME_MATCH_MAX_CONTACTS = 2;
const SHOPIFY_TIMEOUT_MS = 10_000;

// Fixed set of Shopify order fields a client can map into a template's
// {{n}} variables. The frontend mirrors this list; the value extractor
// (Phase 4) reads the same keys off the orders/create payload.
export const SHOPIFY_ORDER_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'order_name', label: 'Order name (#1001)' },
  { key: 'order_number', label: 'Order number' },
  { key: 'total_price', label: 'Total price' },
  { key: 'currency', label: 'Currency' },
  { key: 'customer_first_name', label: 'Customer first name' },
  { key: 'customer_last_name', label: 'Customer last name' },
  { key: 'customer_full_name', label: 'Customer full name' },
  { key: 'customer_phone', label: 'Customer phone' },
  { key: 'financial_status', label: 'Financial status' },
  { key: 'fulfillment_status', label: 'Fulfillment status' },
  { key: 'line_items_summary', label: 'Line items summary' },
  { key: 'shipping_city', label: 'Shipping city' },
  { key: 'shipping_address1', label: 'Shipping address line 1' },
  {
    key: 'shipping_full_address',
    label: 'Shipping full address (line1 + line2 + city, no postal code)',
  },
  // Tracking fields — populated for delivery (shipment-status) notifications.
  { key: 'tracking_number', label: 'Tracking number' },
  { key: 'tracking_url', label: 'Tracking URL' },
  { key: 'tracking_company', label: 'Carrier / tracking company' },
  // Abandoned-cart recovery link.
  { key: 'recovery_url', label: 'Cart recovery URL (abandoned cart)' },
  // Branded public per-order tracking page (full order + live courier timeline).
  // The URL is built per-order at send time (a secret token is minted lazily) —
  // extractOrderValue returns '' for this key; processOrderSend fills it.
  { key: 'tracking_page_url', label: 'Order tracking page URL (public, branded)' },
];
const SHOPIFY_ORDER_FIELD_KEYS = new Set(
  SHOPIFY_ORDER_FIELDS.map((f) => f.key),
);

// Live-hydrated Shopify order detail for the Orders report (batched, cached 5m).
export interface OrderTracking {
  number: string | null;
  url: string | null;
  company: string | null;
}
/** One line item, enriched for the Shopify-style items popover. */
export interface OrderLineItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  productTitle: string | null;
  image: string | null;
}
export interface OrderHydratedDetail {
  name: string;
  createdAt: string | null;
  email: string | null;
  city: string | null;
  items: OrderLineItem[];
  total: number | null;
  currency: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  tracking: OrderTracking[];
}

export interface OrderReportRow {
  orderGid: string;
  adminUrl: string | null;
  orderNo: string | null;
  dateCreated: string | null;
  items: OrderLineItem[];
  city: string | null;
  customerName: string | null;
  contactEmail: string | null;
  agentName: string | null;
  adHeadline: string | null;
  adSourceType: string | null;
  localStatus: string;
  orderValue: number | null;
  currency: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  tracking: OrderTracking[];
  /** Set when cancelled/voided on Shopify: row is kept but excluded from totals. */
  cancelledAt: string | null;
  cancelReason: string | null;
}
export interface OrderReportResult {
  rows: OrderReportRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    totalOrders: number;
    totalValue: number;
    currency: string | null;
    byAgent: Array<{ name: string; orders: number; value: number }>;
  };
}

// A store discount normalized for the order form. `appliesSimple` = it's a plain
// %/fixed discount we can translate into a draft-order manual discount; complex
// discounts (buy-X-get-Y, free shipping, tiered) can't be mapped and are flagged.
export interface StoreDiscount {
  id: string;
  title: string;
  code: string | null;
  valueType: 'percentage' | 'fixed' | null;
  value: number | null;
  appliesSimple: boolean;
  summary: string;
}

@Injectable()
export class ShopifyService implements OnModuleInit {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly cache: CacheService,
    private readonly jobQueue: JobQueueService,
    private readonly metering: UsageMeteringService,
    private readonly inbox: InboxService,
    private readonly aiKnowledge: AiKnowledgeService,
    private readonly rag: AiRagService,
    private readonly featureService: FeatureService,
    private readonly orderIdempotency: OrderIdempotencyService,
    private readonly orderSync: ShopifyOrderSyncService,
  ) {}

  onModuleInit(): void {
    // 120s lease — Shopify GraphQL (order create/complete, tag mutations,
    // knowledge sync) can exceed the default 30s; a short lease risks a second
    // worker double-executing a draftOrderComplete (duplicate order).
    this.jobQueue.registerWorker(
      'shopify',
      (p) => this.processJob(p as ShopifyJob),
      4,
      120,
    );
    this.logger.log('Registered shopify worker (concurrency=4, lease=120s)');
  }

  private async processJob(job: ShopifyJob): Promise<void> {
    if (job.kind === 'send') {
      await this.processOrderSend(job.companyId, job.shopDomain, job.order);
    } else if (job.kind === 'tag') {
      await this.processOrderTag(
        job.companyId,
        job.orderMessageId,
        job.decision,
      );
    } else if (job.kind === 'pendingTag') {
      await this.processPendingTag(job.companyId, job.orderMessageId);
    } else if (job.kind === 'noWhatsapp') {
      await this.processNoWhatsappTag(job.companyId, job.orderMessageId);
    } else if (job.kind === 'syncKnowledge') {
      const res = await this.syncKnowledge(job.companyId);
      this.logger.log(
        `KB sync (company ${job.companyId}): ${res.products} products, ${res.policies} policies, mode=${res.mode}`,
      );
    } else if (job.kind === 'syncCancellations') {
      await this.syncOrderCancellations(job.companyId);
    } else if (job.kind === 'syncOrderSources') {
      await this.syncOrderSources(job.companyId);
    } else if (job.kind === 'reconcileOrderCarts') {
      // Delayed re-match: close pending carts that were created AFTER this order
      // landed (a checkout webhook that fired minutes post-purchase). Re-runs the
      // same order→cart matching against the order's phone/email/name.
      await this.markCheckoutConverted(job.companyId, job.order);
    } else if (job.kind === 'notify') {
      await this.processNotify(job.companyId, job.eventKey, job.order);
    } else if (job.kind === 'abandonedRecovery') {
      await this.processAbandonedRecovery(
        job.companyId,
        job.checkoutToken,
        job.stepIndex ?? 0,
      );
    }
  }

  async setAdminToken(companyId: number, token: string) {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured — refusing to store secrets.',
      );
    }
    const trimmed = token.trim();
    if (trimmed.length < 8) {
      throw new BadRequestException('Admin API token looks too short');
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        shopify_admin_token_encrypted: this.encryption.encrypt(trimmed),
      },
    });
    return { adminTokenSet: true };
  }

  private extractOrderValue(
    order: ShopifyOrderPayload,
    key: string,
  ): string {
    const cust = order.customer ?? {};
    const ship = order.shipping_address ?? {};
    const val = (() => {
      switch (key) {
        case 'order_name':
          return order.name;
        case 'order_number':
          return order.order_number ?? order.number;
        case 'total_price':
          return order.total_price;
        case 'currency':
          return order.currency;
        case 'customer_first_name':
          return cust.first_name;
        case 'customer_last_name':
          return cust.last_name;
        case 'customer_full_name':
          return [cust.first_name, cust.last_name]
            .filter(Boolean)
            .join(' ');
        case 'customer_phone':
          return cust.phone ?? order.phone ?? ship.phone;
        case 'financial_status':
          return order.financial_status;
        case 'fulfillment_status':
          return order.fulfillment_status ?? 'unfulfilled';
        case 'line_items_summary':
          return (order.line_items ?? [])
            .map((li) => `${li.quantity ?? 1}x ${li.title ?? 'item'}`)
            .join(', ');
        case 'shipping_city':
          return ship.city;
        case 'shipping_address1':
          return ship.address1;
        case 'shipping_full_address':
          return [ship.address1, ship.address2, ship.city]
            .filter(Boolean)
            .join(', ');
        case 'tracking_number':
          return order.tracking_number;
        case 'tracking_url':
          return order.tracking_url;
        case 'tracking_company':
          return order.tracking_company;
        case 'recovery_url':
          return order.recovery_url;
        default:
          return '';
      }
    })();
    return (val ?? '').toString();
  }

  /**
   * Normalize a phone to digits-only international form using a fixed
   * default country code (NOT client-configurable — keeps onboarding
   * simple and scalable). So Shopify "03171234567" de-dupes against an
   * existing WhatsApp contact "923171234567". Rules:
   *  - strip everything except digits (drop +),
   *  - "00xx…" → "xx…",
   *  - leading "0" → replace with country code,
   *  - if it doesn't already start with the country code and looks local
   *    (<= 11 digits), prefix the country code.
   */
  private normalizePhone(raw: string): string {
    let d = (raw || '').replace(/\D/g, '');
    const cc = DEFAULT_COUNTRY_CODE;
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('0')) d = cc + d.slice(1);
    else if (!d.startsWith(cc) && d.length <= 11) d = cc + d;
    return d;
  }

  private orderPhone(order: ShopifyOrderPayload): string {
    const raw =
      order.customer?.phone ||
      order.phone ||
      order.shipping_address?.phone ||
      order.billing_address?.phone ||
      '';
    return this.normalizePhone(raw);
  }

  private isPaidOrder(order: ShopifyOrderPayload): boolean {
    if ((order.financial_status ?? '').toLowerCase() === 'paid') return true;
    if (
      order.total_outstanding != null &&
      order.total_outstanding !== '' &&
      Number(order.total_outstanding) === 0
    ) {
      return true;
    }
    return false;
  }

  /**
   * Build the branded public tracking-page URL for an order, minting the
   * per-order secret on first use. Returns '' (no link) when the tenant has no
   * public_slug set — the variable then sends empty rather than a broken URL.
   * Base URL: PUBLIC_TRACKING_BASE_URL env, else <APP_URL>/track.
   */
  /**
   * True when an approved template's content has a dynamic URL button — a URL
   * button whose url carries a {{n}} placeholder (e.g. the "View Order" button
   * pointing at the tracking page). Such a button REQUIRES a per-message
   * parameter or Meta rejects the whole send (#131008), so we must compute the
   * tracking link and pass it through. Never throws.
   */
  private templateHasDynamicUrlButton(content: unknown): boolean {
    try {
      const comps = ((content as { components?: Array<Record<string, unknown>> })
        ?.components ?? []) as Array<Record<string, unknown>>;
      const buttonsComp = comps.find(
        (c) => String(c?.type ?? '').toUpperCase() === 'BUTTONS',
      );
      const list = (buttonsComp?.buttons ?? []) as Array<Record<string, unknown>>;
      return list.some(
        (b) =>
          String(b?.type ?? '').toUpperCase() === 'URL' &&
          typeof b?.url === 'string' &&
          (b.url as string).includes('{{'),
      );
    } catch {
      return false;
    }
  }

  private async buildTrackingPageUrl(
    companyId: number,
    orderGid: string,
  ): Promise<string> {
    const orderId = orderGid.split('/').pop();
    if (!orderId) return '';

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { public_slug: true },
    });
    const slug = company?.public_slug;
    if (!slug) {
      this.logger.warn(
        `tracking_page_url requested for company ${companyId} but no public_slug is set — sending empty`,
      );
      return '';
    }

    // Ensure the order mirror has a public_token; mint one lazily if absent.
    const orderRow = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: companyId,
          shopify_order_gid: orderGid,
        },
      },
      select: { public_token: true },
    });
    let token = orderRow?.public_token ?? null;
    if (!token) {
      token = crypto.randomBytes(18).toString('base64url'); // ~24 chars
      // The mirror row may not exist yet (created elsewhere in the flow); only
      // persist when it does — best-effort, never blocks the send.
      try {
        await this.prisma.shopifyOrder.update({
          where: {
            company_id_shopify_order_gid: {
              company_id: companyId,
              shopify_order_gid: orderGid,
            },
          },
          data: { public_token: token },
        });
      } catch {
        // Row not present yet — fall through with the in-memory token; the page
        // won't resolve until the mirror is written, but the send must not fail.
      }
    }

    const base =
      this.config.get<string>('PUBLIC_TRACKING_BASE_URL') ||
      `${(this.config.get<string>('APP_URL') || '').replace(/\/+$/, '')}/track`;
    if (!base || base === '/track') return '';
    return `${base.replace(/\/+$/, '')}/${slug}/${orderId}?k=${token}`;
  }

  private async processOrderSend(
    companyId: number,
    shopDomain: string,
    order: ShopifyOrderPayload,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    if (!cfg || !cfg.enabled || !cfg.template_id) {
      this.logger.log(
        `Shopify order send skipped for company ${companyId} (config disabled/incomplete)`,
      );
      return;
    }

    // Only message UNPAID orders (paid → outstanding 0 / financial_status paid).
    // A manual resend (force) bypasses this — the agent chose to send it.
    if (!opts.force && this.isPaidOrder(order)) {
      this.logger.log(
        `Shopify order ${order.name ?? order.id} (company ${companyId}) already paid — no confirmation sent`,
      );
      return;
    }

    // IDEMPOTENCY. Shopify delivers orders/create at-least-once and retries the
    // webhook if our 200 ack is slow. Without this guard a redelivered order
    // sent the customer a SECOND confirmation template, created a duplicate
    // shopify_order_messages row, and scheduled a duplicate pending-tag job
    // (same at-least-once class as the WhatsApp inbound/status callbacks). One
    // confirmation per order.
    const orderGid =
      order.admin_graphql_api_id ??
      (order.id != null ? `gid://shopify/Order/${order.id}` : '');
    if (orderGid && !opts.force) {
      const dup = await this.prisma.shopifyOrderMessage.findFirst({
        where: { company_id: companyId, shopify_order_gid: orderGid },
        select: { id: true },
      });
      if (dup) {
        this.logger.log(
          `Shopify order ${order.name ?? order.id} (company ${companyId}) already messaged — skipping duplicate confirmation`,
        );
        return;
      }
    }

    const phone = this.orderPhone(order);
    if (!phone) {
      this.logger.warn(
        `Shopify order ${order.name ?? order.id} (company ${companyId}) has no customer phone — skipped`,
      );
      return;
    }

    const map = (cfg.variable_map as Record<string, string>) ?? {};
    const variables: Record<string, string> = {};
    for (const [slot, fieldKey] of Object.entries(map)) {
      variables[slot] = this.extractOrderValue(order, fieldKey);
    }

    // Public tracking page. Two ways a template can carry the link:
    //  (a) a BODY slot mapped to `tracking_page_url` (variable_map), and/or
    //  (b) a dynamic URL BUTTON ("View Order") whose approved url has a {{n}}.
    // Compute the per-order branded link (minting the secret lazily) once when
    // EITHER is present, and reuse it for both. Backward compatible: no slot +
    // no dynamic URL button ⇒ no DB touch, nothing changes.
    const trackingSlots = Object.entries(map)
      .filter(([, fieldKey]) => fieldKey === 'tracking_page_url')
      .map(([slot]) => slot);
    const tplRow = await this.prisma.template.findFirst({
      where: { id: cfg.template_id, company_id: companyId, deleted_at: null },
      select: { content: true },
    });
    const hasUrlButton = this.templateHasDynamicUrlButton(tplRow?.content);
    let trackingUrl = '';
    if ((trackingSlots.length > 0 || hasUrlButton) && orderGid) {
      trackingUrl = await this.buildTrackingPageUrl(companyId, orderGid);
      if (trackingUrl) {
        for (const slot of trackingSlots) variables[slot] = trackingUrl;
      }
    }

    // Get-or-create contact (mirrors MetaWebhookService.handleInbound).
    const name =
      [order.customer?.first_name, order.customer?.last_name]
        .filter(Boolean)
        .join(' ') || phone;
    const email = order.email || order.customer?.email || null;
    // Shipping address → stored on the contact for complete CRM info.
    const ship = order.shipping_address ?? {};
    const shipAddress =
      [ship.address1, ship.address2].filter(Boolean).join(', ') || null;
    const shipCity = ship.city || null;
    let contact = await this.prisma.contact.findFirst({
      where: { company_id: companyId, phone, deleted_at: null },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          company_id: companyId,
          name,
          phone,
          email,
          address: shipAddress,
          city: shipCity,
          last_message_at: new Date(),
        },
      });
      await this.metering.incrementContacts(companyId);
    } else {
      // Backfill email/address onto an existing contact WITHOUT overwriting
      // curated values the team may have set (only fill blanks / refresh address).
      const patch: Record<string, unknown> = {};
      if (email && !contact.email) patch.email = email;
      if (shipAddress && shipAddress !== contact.address) patch.address = shipAddress;
      if (shipCity && shipCity !== contact.city) patch.city = shipCity;
      if (Object.keys(patch).length) {
        contact = await this.prisma.contact.update({
          where: { id: contact.id },
          data: patch,
        });
      }
    }

    let convo = await this.prisma.conversation.findFirst({
      where: {
        company_id: companyId,
        contact_id: contact.id,
        deleted_at: null,
      },
      orderBy: { id: 'desc' },
    });
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          status: 'open',
          window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }

    // If an agent created this order via the modal, the idempotency row (keyed
    // by the same order_gid) recorded their user id — stamp it on the
    // confirmation message so analytics credits the real creator, not the
    // chat's current assignee. Best-effort: AI-auto / storefront orders have no
    // such row → null → not attributed to any agent.
    let createdByUserId: number | null = null;
    if (orderGid) {
      const pending = await this.prisma.pendingOrderHash
        .findFirst({
          where: { company_id: companyId, order_gid: orderGid },
          select: { created_by_user_id: true },
          orderBy: { id: 'desc' },
        })
        .catch(() => null);
      createdByUserId = pending?.created_by_user_id ?? null;
    }

    // Templates are allowed regardless of the 24h window.
    const message = (await this.inbox.sendMessage(
      companyId,
      convo.id,
      {
        type: SendMessageType.template,
        templateId: cfg.template_id,
        variables,
        urlButtonUrl: trackingUrl || undefined,
      },
      createdByUserId ?? undefined,
    )) as { id: number };

    try {
      await this.prisma.shopifyOrderMessage.create({
        data: {
          company_id: companyId,
          message_id: message.id,
          conversation_id: convo.id,
          shopify_order_gid: orderGid,
          shop_domain: shopDomain,
          status: 'pending',
        },
      });
    } catch (e) {
      // Unique (company_id, shopify_order_gid) — a concurrent delivery already
      // recorded this order. Defensive only (serialization + the findFirst guard
      // above normally prevent reaching here); don't fail the job.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.log(
          `Shopify order ${order.name ?? order.id} (company ${companyId}) row already exists — skipping`,
        );
        return;
      }
      throw e;
    }

    // Schedule the "no answer yet" pending tag after the decision window.
    const windowMin =
      cfg.decision_window_minutes && cfg.decision_window_minutes > 0
        ? cfg.decision_window_minutes
        : 2;
    const link = await this.prisma.shopifyOrderMessage.findFirst({
      where: { message_id: message.id, company_id: companyId },
      select: { id: true },
    });
    if (link) {
      await this.jobQueue.enqueue(
        'shopify',
        { kind: 'pendingTag', companyId, orderMessageId: link.id },
        { delayMs: windowMin * 60_000 },
      );
    }
    this.logger.log(
      `Shopify order ${order.name ?? order.id}: confirmation template sent (company ${companyId}, msg ${message.id})`,
    );
  }

  /**
   * Manually (re)send the configured order-confirmation template to a customer,
   * on demand from the fulfilment board. Rebuilds the order payload from the
   * local mirror (no live Shopify / PII fetch) and reuses processOrderSend with
   * `force` so the paid + already-messaged guards don't block a deliberate resend.
   */
  async resendConfirmation(
    companyId: number,
    orderGid: string,
    overridePhone?: string,
  ): Promise<{ sent: boolean }> {
    const o = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
    });
    if (!o) throw new NotFoundException('Order not found.');

    // "Send to another number" (No-WhatsApp orders): send the confirmation to an
    // agent-supplied number instead of the order's own (dead) phone. We only
    // reach WhatsApp on the new number — the order's stored phone/address are
    // left untouched, by design. Downstream orderPhone()/normalizePhone() format
    // it exactly like the order's own number, so a bare local number works.
    const override = (overridePhone ?? '').trim();
    if (overridePhone !== undefined && override.replace(/\D/g, '').length < 7) {
      throw new BadRequestException('Enter a valid phone number.');
    }
    const targetPhone = override || o.phone;
    if (!targetPhone) {
      throw new BadRequestException('This order has no customer phone on file.');
    }

    const cfg = await this.prisma.shopifyOrderConfig.findFirst({
      where: { company_id: companyId },
      select: { shop_domain: true },
    });
    const shopDomain = (cfg?.shop_domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const numericId = Number(orderGid.split('/').pop());

    const payload = {
      id: Number.isFinite(numericId) ? numericId : undefined,
      admin_graphql_api_id: orderGid,
      name: o.order_name ?? undefined,
      total_price: o.total_price != null ? String(o.total_price) : undefined,
      total_outstanding: o.total_outstanding != null ? String(o.total_outstanding) : undefined,
      currency: o.currency ?? undefined,
      financial_status: o.financial_status ?? undefined,
      fulfillment_status: o.fulfillment_status ?? undefined,
      email: o.email ?? undefined,
      phone: targetPhone ?? undefined,
      customer: {
        first_name: o.customer_name ?? undefined,
        last_name: undefined,
        phone: targetPhone ?? undefined,
        email: o.email ?? undefined,
      },
      shipping_address: {
        phone: targetPhone ?? undefined,
        city: o.city ?? undefined,
        address1: o.address1 ?? undefined,
        address2: o.address2 ?? undefined,
      },
      line_items: Array.isArray(o.line_items) ? (o.line_items as unknown[]) : [],
    } as unknown as ShopifyOrderPayload;

    await this.processOrderSend(companyId, shopDomain, payload, { force: true });
    return { sent: true };
  }

  /**
   * Part 3 — send the proactive "your order shipped" notification for an
   * orders/fulfilled webhook. Reuses the order template-send path: a tenant
   * picks a (generic) approved template + variable map; the framework gate was
   * already checked at enqueue. No template configured = silent no-op (dark).
   * Idempotency is at the job level (dedupKey on order gid) — one shipped
   * notice per order; partial-fulfillment re-fires are suppressed by design.
   */
  /** Map the JSON delivery-notifications column to a typed per-event map. */
  private deliveryConfigMap(
    raw: unknown,
  ): Record<string, DeliveryNotificationCfg> {
    const out: Record<string, DeliveryNotificationCfg> = {};
    const obj = (raw ?? {}) as Record<string, unknown>;
    for (const key of DELIVERY_EVENT_KEYS) {
      const v = (obj[key] ?? {}) as Partial<DeliveryNotificationCfg>;
      out[key] = {
        templateId:
          typeof v.templateId === 'number' ? v.templateId : null,
        variableMap:
          (v.variableMap as Record<string, string>) ?? {},
        enabled: !!v.enabled,
      };
    }
    return out;
  }

  /**
   * Cancellation accounting: flag the agent's order row when Shopify reports the
   * order cancelled or its payment voided, so it stops counting toward agent
   * order counts and revenue. The ROW IS KEPT (never deleted) — the Orders list
   * still shows it, badged "Cancelled"; only the totals exclude it.
   *
   * Runs on EVERY inbound order-bearing topic and BEFORE the proactive-
   * notification gate, so accounting is correct even for tenants who never
   * enabled delivery notifications. Idempotent (only stamps a row once) and
   * never throws — accounting must not break webhook delivery.
   *
   * Un-cancelling is deliberately supported: if a later payload shows the order
   * is no longer cancelled/voided, the flag clears and the order counts again.
   */
  private async applyOrderCancellationState(
    companyId: number,
    order: ShopifyOrderPayload,
  ): Promise<void> {
    const gid =
      order.admin_graphql_api_id ??
      (order.id != null ? `gid://shopify/Order/${order.id}` : null);
    if (!gid) return;
    await this.applyCancellationFlag(
      companyId,
      gid,
      order.cancelled_at ?? null,
      order.financial_status ?? null,
    );
  }

  /**
   * One-time (re-runnable) reconciliation: ask Shopify for the current
   * cancelled/voided state of every tracked order and stamp the local rows, so
   * orders cancelled BEFORE cancellation accounting shipped stop counting too.
   *
   * Runs on the `shopify` job queue (`kind:'syncCancellations'`) — paging the
   * whole order history exceeds an HTTP request budget, same reasoning as
   * syncKnowledge. Safe to re-run: the UPDATE is idempotent and also CLEARS the
   * flag on orders that are no longer cancelled.
   */
  async syncOrderCancellations(
    companyId: number,
  ): Promise<{ checked: number; cancelled: number; cleared: number }> {
    const api = await this.requireAdminApi(companyId);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ order_gid: string }>>(
      `SELECT order_gid FROM pending_order_hashes
        WHERE company_id = ? AND status = 'created' AND order_gid IS NOT NULL`,
      companyId,
    );
    const gids = Array.from(new Set(rows.map((r) => r.order_gid).filter(Boolean)));

    type Node = {
      id: string;
      cancelledAt?: string | null;
      displayFinancialStatus?: string | null;
    };
    type Res = {
      data?: { nodes?: Array<Node | null> };
      errors?: Array<{ message: string }>;
    };
    const query = `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order { id cancelledAt displayFinancialStatus }
      }
    }`;

    let checked = 0;
    let cancelled = 0;
    let cleared = 0;
    for (let i = 0; i < gids.length; i += 100) {
      const chunk = gids.slice(i, i + 100);
      let res: Res | undefined;
      try {
        res = await this.shopifyGraphql<Res>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          query,
          { ids: chunk },
        );
      } catch (e) {
        this.logger.warn(
          `syncOrderCancellations chunk failed (company ${companyId}): ${
            e instanceof Error ? e.message : e
          }`,
        );
        continue; // one bad page must not abort the whole reconciliation
      }
      for (const node of res?.data?.nodes ?? []) {
        if (!node?.id) continue;
        checked++;
        const wasCancelled = await this.applyCancellationFlag(
          companyId,
          node.id,
          node.cancelledAt ?? null,
          node.displayFinancialStatus ?? null,
        );
        if (wasCancelled === 'cancelled') cancelled++;
        else if (wasCancelled === 'cleared') cleared++;
      }
    }
    this.logger.log(
      `syncOrderCancellations company=${companyId}: checked=${checked} cancelled=${cancelled} cleared=${cleared}`,
    );
    return { checked, cancelled, cleared };
  }

  /**
   * One-time (re-runnable) backfill of `pending_order_hashes.source`. Orders
   * created from the Abandoned Checkouts flow carry the Shopify tag
   * "Abandoned Checkout"; this reads that tag from Shopify and stamps
   * source='abandoned_cart' on the matching rows. Every other created order is
   * classified 'inbox'. Corrects the historical "recovered via CodesApp" count
   * (which used to credit any app order that merely matched a cart).
   *
   * Runs on the `shopify` job queue (paging order history exceeds the HTTP
   * budget). Safe to re-run.
   */
  async syncOrderSources(
    companyId: number,
  ): Promise<{ abandoned: number; inbox: number }> {
    const api = await this.requireAdminApi(companyId);
    const query = `query($cursor: String) {
      orders(first: 100, after: $cursor, query: "tag:'Abandoned Checkout'") {
        edges { cursor node { id } }
        pageInfo { hasNextPage }
      }
    }`;
    type Res = {
      data?: {
        orders?: {
          edges?: Array<{ cursor: string; node?: { id?: string } }>;
          pageInfo?: { hasNextPage?: boolean };
        };
      };
      errors?: Array<{ message: string }>;
    };

    const gids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      let res: Res | undefined;
      try {
        res = await this.shopifyGraphql<Res>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          query,
          { cursor },
        );
      } catch (e) {
        this.logger.warn(
          `syncOrderSources page failed (company ${companyId}): ${
            e instanceof Error ? e.message : e
          }`,
        );
        break;
      }
      const edges: Array<{ cursor: string; node?: { id?: string } }> =
        res?.data?.orders?.edges ?? [];
      for (const edge of edges) {
        if (edge.node?.id) gids.push(edge.node.id);
      }
      if (!res?.data?.orders?.pageInfo?.hasNextPage || !edges.length) break;
      cursor = edges[edges.length - 1].cursor;
    }

    let abandoned = 0;
    for (let i = 0; i < gids.length; i += 100) {
      const chunk = gids.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const n = await this.prisma.$executeRawUnsafe(
          `UPDATE pending_order_hashes SET source = 'abandoned_cart'
            WHERE company_id = ? AND order_gid IN (${placeholders})`,
          companyId,
          ...chunk,
        );
        abandoned += Number(n) || 0;
      } catch (e) {
        this.logger.warn(
          `syncOrderSources chunk update failed (company ${companyId}): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    // Everything else that's created but still unclassified = a regular order.
    let inbox = 0;
    try {
      const n = await this.prisma.$executeRawUnsafe(
        `UPDATE pending_order_hashes SET source = 'inbox'
          WHERE company_id = ? AND status = 'created' AND source IS NULL`,
        companyId,
      );
      inbox = Number(n) || 0;
    } catch (e) {
      this.logger.warn(
        `syncOrderSources inbox default failed (company ${companyId}): ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    this.logger.log(
      `syncOrderSources company=${companyId}: abandoned=${abandoned} inbox=${inbox}`,
    );
    return { abandoned, inbox };
  }

  /**
   * Shared cancel/void flag writer for both the webhook path and the backfill.
   * Returns what it did so the backfill can report counts.
   */
  private async applyCancellationFlag(
    companyId: number,
    gid: string,
    cancelledAt: string | null,
    financialStatus: string | null,
  ): Promise<'cancelled' | 'cleared' | 'none'> {
    const reason = cancelledAt
      ? 'cancelled'
      : (financialStatus ?? '').toLowerCase() === 'voided'
        ? 'voided'
        : null;
    try {
      if (reason) {
        const n = await this.prisma.$executeRawUnsafe(
          `UPDATE pending_order_hashes
              SET cancelled_at = COALESCE(cancelled_at, ?), cancel_reason = ?
            WHERE company_id = ? AND order_gid = ? AND cancelled_at IS NULL`,
          cancelledAt ? new Date(cancelledAt) : new Date(),
          reason,
          companyId,
          gid,
        );
        return n > 0 ? 'cancelled' : 'none';
      }
      const n = await this.prisma.$executeRawUnsafe(
        `UPDATE pending_order_hashes
            SET cancelled_at = NULL, cancel_reason = NULL
          WHERE company_id = ? AND order_gid = ? AND cancelled_at IS NOT NULL`,
        companyId,
        gid,
      );
      return n > 0 ? 'cleared' : 'none';
    } catch (e) {
      this.logger.warn(
        `Cancellation accounting failed for company ${companyId} order ${gid}: ${
          e instanceof Error ? e.message : e
        }`,
      );
      return 'none';
    }
  }

  /**
   * Inbound delivery-notification router. Handles the topics that drive a
   * customer status message; returns a webhook result when it owns the topic,
   * or null so the caller falls through (e.g. orders/create). The feature gate
   * is checked here; per-event enable + template is enforced in processNotify.
   */
  private async routeDeliveryNotification(
    companyId: number,
    topic: string,
    rawBody: Buffer,
  ): Promise<{ received: true; ignored?: string } | null> {
    let eventKey: string | null = null;
    let order: ShopifyOrderPayload | null = null;
    let dedupId = '';

    if (topic === 'orders/fulfilled' || topic === 'orders/cancelled') {
      let parsed: ShopifyOrderPayload;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { received: true, ignored: 'bad-json' };
      }
      eventKey =
        topic === 'orders/fulfilled' ? 'order_fulfilled' : 'order_cancelled';
      order = parsed;
      dedupId =
        parsed.admin_graphql_api_id ??
        (parsed.id != null ? `order:${parsed.id}` : '');
    } else if (topic === 'fulfillments/update' || topic === 'fulfillments/create') {
      let f: ShopifyFulfillmentPayload;
      try {
        f = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { received: true, ignored: 'bad-json' };
      }
      const status = (f.shipment_status ?? '').toLowerCase();
      const mapped = SHIPMENT_STATUS_EVENT[status];
      if (!mapped) {
        // A fulfillment update we don't notify on (label printed, in transit…).
        return { received: true, ignored: `shipment-status:${status || 'none'}` };
      }
      eventKey = mapped;
      order = this.normalizeFulfillment(f);
      // One notice per (fulfillment, status) — re-deliveries de-dupe; a real
      // status change carries a new status so a later event still fires.
      dedupId = `fulfill:${f.id ?? f.order_id ?? ''}:${status}`;
    }

    if (!eventKey || !order) return null; // not a delivery topic — fall through

    // Suppress the customer notification when THIS fulfillment update was
    // produced by our own courier status-sync push (a bulk backfill of
    // historical statuses must never message weeks-old customers). The sync
    // sets this flag for the order right before it pushes to Shopify.
    const suppressId = order.id != null ? String(order.id) : '';
    if (
      suppressId &&
      this.cache.get(`shopify-sync-suppress:${companyId}:${suppressId}`)
    ) {
      return { received: true, ignored: 'sync-suppressed' };
    }

    const enabled =
      await this.featureService.proactiveNotificationsEnabled(companyId);
    if (!enabled) {
      this.logger.log(
        `Shopify ${topic} for company ${companyId} ignored (delivery notifications off)`,
      );
      return { received: true, ignored: 'proactive-off' };
    }

    const key = dedupId
      ? `shopify-notify:${companyId}:${eventKey}:${dedupId}`
      : undefined;
    await this.jobQueue.enqueue(
      'shopify',
      { kind: 'notify', companyId, eventKey, order },
      key ? { serialKey: key, dedupKey: key } : undefined,
    );
    this.logger.log(
      `Shopify ${topic} company=${companyId} -> ${eventKey} enqueued (order=${
        order.name ?? order.id
      })`,
    );
    return { received: true };
  }

  /** Build an order-shaped payload from a fulfillments/* webhook so the shared
   *  field extractor + send path work uniformly. */
  private normalizeFulfillment(
    f: ShopifyFulfillmentPayload,
  ): ShopifyOrderPayload {
    const d = f.destination ?? {};
    return {
      id: f.order_id,
      name: f.name,
      email: f.email,
      phone: d.phone,
      customer: {
        first_name: d.first_name,
        last_name: d.last_name,
        phone: d.phone,
        email: f.email,
      },
      shipping_address: {
        phone: d.phone,
        city: d.city,
        address1: d.address1,
        address2: d.address2,
      },
      line_items: f.line_items,
      tracking_number: f.tracking_number ?? f.tracking_numbers?.[0],
      tracking_url: f.tracking_url ?? f.tracking_urls?.[0],
      tracking_company: f.tracking_company,
    };
  }

  /** Worker: send the configured template for a delivery event (dark no-op if
   *  the event is disabled or has no template). */
  /**
   * Send one configured delivery-notification template for `eventKey`.
   * PUBLIC because CouriersModule raises the `address_issue` event, which
   * has no Shopify webhook behind it — reusing this keeps every customer
   * notification on one gated, template-configured path.
   */
  async processNotify(
    companyId: number,
    eventKey: string,
    order: ShopifyOrderPayload,
  ): Promise<void> {
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const evt = this.deliveryConfigMap(cfg?.delivery_notifications)[eventKey];
    if (!evt || !evt.enabled) {
      this.logger.log(
        `Shopify ${eventKey} send skipped for company ${companyId} (event disabled)`,
      );
      return;
    }
    await this.sendProactiveTemplate(
      companyId,
      order,
      evt.templateId,
      evt.variableMap,
      eventKey,
    );
  }

  /** Build an order-shaped payload from a checkout (abandoned-cart recovery). */
  private normalizeCheckout(
    c: ShopifyCheckoutPayload,
  ): ShopifyOrderPayload {
    return {
      id: c.id,
      email: c.email,
      phone: c.phone,
      customer: c.customer,
      shipping_address: c.shipping_address,
      billing_address: c.billing_address,
      line_items: c.line_items,
      recovery_url: c.abandoned_checkout_url,
    };
  }

  /**
   * checkouts/create|update — record the abandoned checkout and schedule a
   * delayed recovery template. Gated by the feature framework + the
   * abandoned_cart event being enabled with a template. No phone = skip (we
   * can't WhatsApp). Re-deliveries de-dupe on the checkout token.
   */
  /**
   * The effective recovery sequence for a company. Prefers the configured
   * multi-step list (`shopify_order_configs.abandoned_cart_steps`, raw JSON
   * column); falls back to a single synthesised step from the legacy
   * `abandoned_cart` event template + delay. Empty = nothing to send.
   */
  private async loadEffectiveSteps(
    companyId: number,
    evt: DeliveryNotificationCfg | undefined,
    legacyDelayMin: number,
  ): Promise<AbandonedCartStep[]> {
    let raw: unknown;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ steps: unknown }[]>(
        `SELECT abandoned_cart_steps steps FROM shopify_order_configs WHERE company_id = ? LIMIT 1`,
        companyId,
      );
      raw = rows[0]?.steps;
    } catch {
      raw = null;
    }
    let arr: Array<Record<string, unknown>> = [];
    try {
      if (typeof raw === 'string') arr = JSON.parse(raw);
      else if (Array.isArray(raw)) arr = raw as Array<Record<string, unknown>>;
    } catch {
      arr = [];
    }
    const steps: AbandonedCartStep[] = [];
    for (const s of arr) {
      const templateId = Number(s.templateId);
      const delayMinutes = Number(s.delayMinutes);
      if (!Number.isFinite(templateId) || templateId <= 0) continue;
      steps.push({
        templateId,
        delayMinutes:
          Number.isFinite(delayMinutes) && delayMinutes > 0
            ? Math.round(delayMinutes)
            : legacyDelayMin,
        variableMap:
          s.variableMap && typeof s.variableMap === 'object'
            ? (s.variableMap as Record<string, string>)
            : {},
      });
    }
    if (steps.length) return steps;
    // Legacy single-step fallback.
    if (evt?.templateId) {
      return [
        {
          delayMinutes: legacyDelayMin,
          templateId: evt.templateId,
          variableMap: evt.variableMap ?? {},
        },
      ];
    }
    return [];
  }

  private async handleAbandonedCheckout(
    companyId: number,
    rawBody: Buffer,
  ): Promise<{ received: true; ignored?: string }> {
    let checkout: ShopifyCheckoutPayload;
    try {
      checkout = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { received: true, ignored: 'bad-json' };
    }
    const token = (checkout.token ?? String(checkout.id ?? '')).trim();
    if (!token) return { received: true, ignored: 'no-token' };

    const phone = this.orderPhone(this.normalizeCheckout(checkout)) || null;
    const email = (checkout.email ?? checkout.customer?.email ?? '').trim() || null;
    // Need at least one way to identify the shopper for the dashboard. Email-only
    // carts are recorded too (visible for manual recovery — WhatsApp auto-send
    // simply won't fire without a phone).
    if (!phone && !email) return { received: true, ignored: 'no-contact' };

    const name =
      [checkout.customer?.first_name, checkout.customer?.last_name]
        .filter(Boolean)
        .join(' ') || null;
    const items = (checkout.line_items ?? [])
      .map((li) => `${li.quantity ?? 1}x ${li.title ?? 'item'}`)
      .join(', ');
    // Structured lines (variant GID + price) so the Create-order modal can
    // pre-fill the exact cart. Lines without a variant_id (custom/deleted
    // products) are kept for display but can't be pre-filled.
    const structuredItems = (checkout.line_items ?? []).map((li) => ({
      variantId:
        li.variant_id != null && String(li.variant_id).trim()
          ? `gid://shopify/ProductVariant/${String(li.variant_id).trim()}`
          : null,
      title: li.title ?? 'item',
      variantTitle: li.variant_title ?? null,
      price: li.price != null ? String(li.price) : null,
      quantity: Number(li.quantity ?? 1) || 1,
    }));
    const totalStr =
      checkout.total_price != null ? String(checkout.total_price).trim() : '';
    const totalNum =
      totalStr && !Number.isNaN(Number(totalStr)) ? Number(totalStr) : null;
    const currency =
      checkout.currency ?? checkout.presentment_currency ?? null;

    // RECORD ALWAYS — decoupled from the recovery template so the dashboard
    // shows every abandoned cart for manual recovery. A redelivery/update keeps
    // a non-pending status (don't resurrect a converted/recovered one).
    const existing = await this.prisma.shopifyAbandonedCheckout.findUnique({
      where: {
        company_id_checkout_token: { company_id: companyId, checkout_token: token },
      },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'pending') {
      return { received: true, ignored: `already-${existing.status}` };
    }
    let rowId: number;
    if (existing) {
      await this.prisma.shopifyAbandonedCheckout.update({
        where: { id: existing.id },
        data: {
          phone,
          recovery_url: checkout.abandoned_checkout_url ?? null,
          contact_name: name,
          email,
          items_summary: items || null,
        },
      });
      rowId = existing.id;
    } else {
      const created = await this.prisma.shopifyAbandonedCheckout.create({
        data: {
          company_id: companyId,
          checkout_token: token,
          phone,
          recovery_url: checkout.abandoned_checkout_url ?? null,
          contact_name: name,
          email,
          items_summary: items || null,
        },
        select: { id: true },
      });
      rowId = created.id;
    }
    // Cart value lives in raw columns (not in schema.prisma) — patch best-effort.
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts
            SET total_price = ?, currency = ?, items_json = ?
          WHERE id = ?`,
        totalNum,
        currency,
        structuredItems.length ? JSON.stringify(structuredItems) : null,
        rowId,
      );
    } catch (e) {
      this.logger.warn(
        `abandoned cart value patch failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // Collapse restarted checkouts. Shopify mints a NEW checkout token each time
    // a shopper restarts checkout, so ONE shopping session can leave several
    // pending rows for the same person (same phone AND email, minutes apart),
    // inflating the dashboard and "value at risk". The newest row is the live
    // cart; older pending rows for the same shopper become 'superseded' — hidden
    // from the list/stats (both filter status='pending') but KEPT as a record.
    await this.supersedeOlderCarts(companyId, rowId, phone, email);

    // Post-order checkout noise. Shopify can fire a checkouts/create|update a
    // few minutes AFTER the shopper already completed their order (they revisit
    // the site / bounce off the thank-you page), creating a fresh "pending" cart
    // that no future order will ever convert. If this same shopper JUST
    // converted an identical cart, treat this new one as already-ordered:
    // mark it 'superseded' (kept as a record, hidden from list/stats). Forward
    // matching (markCheckoutConverted) can't catch it — the cart didn't exist
    // when the order arrived.
    await this.suppressPostOrderCart(companyId, rowId, phone, email, totalNum);

    // AUTO-RECOVERY is a separate opt-in: only schedule the delayed template
    // send when proactive notifications are on, the abandoned_cart event has a
    // template, AND we have a phone (WhatsApp needs it).
    const enabled =
      await this.featureService.proactiveNotificationsEnabled(companyId);
    if (!enabled || !phone) return { received: true };
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const evt = this.deliveryConfigMap(cfg?.delivery_notifications)[
      'abandoned_cart'
    ];
    // The event toggle is the master on/off for the whole sequence.
    if (!evt || !evt.enabled) return { received: true };
    const legacyDelay =
      cfg?.abandoned_cart_delay_minutes && cfg.abandoned_cart_delay_minutes > 0
        ? cfg.abandoned_cart_delay_minutes
        : 180;
    const steps = await this.loadEffectiveSteps(companyId, evt, legacyDelay);
    if (!steps.length) return { received: true };

    // Schedule the FIRST step (dedupKey per step). Each step's worker schedules
    // the next; the worker re-checks status before sending.
    const first = steps[0];
    const key = `shopify-recover:${companyId}:${token}:0`;
    await this.jobQueue.enqueue(
      'shopify',
      { kind: 'abandonedRecovery', companyId, checkoutToken: token, stepIndex: 0 },
      { delayMs: first.delayMinutes * 60_000, dedupKey: key, serialKey: key },
    );
    this.logger.log(
      `Shopify abandoned checkout ${token} (company ${companyId}) recovery step 1/${steps.length} scheduled in ${first.delayMinutes}m`,
    );
    return { received: true };
  }

  /**
   * UTC instant of tenant-timezone midnight today (falls back to UTC midnight if
   * the company has no timezone set). Fixes the abandoned-cart "ordered today"
   * filter + same-day conversion window, which used raw UTC boundaries and were
   * off by the tenant's offset (e.g. ~5h for PKT).
   */
  private async tenantDayStartUtc(companyId: number): Promise<Date> {
    let tz: string | undefined;
    try {
      const c = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { timezone: true },
      });
      tz = c?.timezone ?? undefined;
      if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    } catch {
      tz = undefined;
    }
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = dtf.formatToParts(now).reduce<Record<string, number>>((a, x) => {
      if (x.type !== 'literal') a[x.type] = Number(x.value);
      return a;
    }, {});
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetMs = asUtc - now.getTime();
    const startWallUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
    return new Date(startWallUtc - offsetMs);
  }

  /** orders/create — flip the matching abandoned checkout to 'converted' so its
   *  recovery job no-ops AND it drops off the abandoned-checkouts dashboard.
   *
   *  Shopify keeps an abandoned checkout alive even after the customer completes
   *  a SEPARATE order (a fresh checkout or a storefront order), so a token-only
   *  match misses the very case we care about. In addition to the checkout_token
   *  match we therefore also convert any pending checkout from the SAME calendar
   *  day whose (normalized) phone or email matches this order — i.e. "the
   *  customer already ordered that day". Best-effort, never throws. */
  /**
   * Mark older PENDING carts belonging to the same shopper as 'superseded' so
   * only the newest cart of a restarted checkout session stays live. Matches on
   * phone OR email (exact identity only — never on cart value, which is shared
   * by unrelated shoppers buying the same product). Never throws.
   */
  private async supersedeOlderCarts(
    companyId: number,
    keepRowId: number,
    phone: string | null,
    email: string | null,
  ): Promise<void> {
    const conds: string[] = [];
    const params: unknown[] = [companyId, keepRowId];
    if (phone) {
      conds.push('phone = ?');
      params.push(phone);
    }
    if (email) {
      conds.push('LOWER(email) = ?');
      params.push(email.toLowerCase());
    }
    if (!conds.length) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts SET status = 'superseded'
          WHERE company_id = ? AND id <> ? AND status = 'pending'
            AND (${conds.join(' OR ')})`,
        ...params,
      );
    } catch (e) {
      this.logger.warn(
        `supersede older carts failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Post-order noise: a converted cart within this window before a NEW cart of
   * the same shopper+total means the new cart is a leftover checkout event that
   * fired after they already ordered — suppress it. */
  private static readonly POST_ORDER_NOISE_MINUTES = 120;

  /**
   * Mark a just-recorded PENDING cart 'superseded' when the same shopper (phone
   * OR email) already converted an IDENTICAL cart (same total) within the last
   * `POST_ORDER_NOISE_MINUTES`. This is the backward-looking twin of
   * `markCheckoutConverted`: it catches a checkout webhook that arrives minutes
   * AFTER the order, which forward matching can't see (the cart didn't exist
   * yet). Same-total is required so a genuine NEW abandonment for a different
   * product still shows. Two-step (SELECT then UPDATE) because MariaDB can't
   * UPDATE a table referenced by a subquery on itself. Never throws.
   */
  private async suppressPostOrderCart(
    companyId: number,
    rowId: number,
    phone: string | null,
    email: string | null,
    totalNum: number | null,
  ): Promise<void> {
    if ((!phone && !email) || totalNum == null) return;
    const idConds: string[] = [];
    const params: unknown[] = [
      companyId,
      rowId,
      totalNum,
      ShopifyService.POST_ORDER_NOISE_MINUTES,
    ];
    if (phone) {
      idConds.push('phone = ?');
      params.push(phone);
    }
    if (email) {
      idConds.push('LOWER(email) = ?');
      params.push(email.toLowerCase());
    }
    try {
      const hit = await this.prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT id FROM shopify_abandoned_checkouts
          WHERE company_id = ? AND id <> ? AND status = 'converted'
            AND total_price = ? AND converted_at IS NOT NULL
            AND converted_at >= (NOW() - INTERVAL ? MINUTE)
            AND (${idConds.join(' OR ')})
          LIMIT 1`,
        ...params,
      );
      if (!hit.length) return;
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts SET status = 'superseded'
          WHERE id = ? AND company_id = ? AND status = 'pending'`,
        rowId,
        companyId,
      );
      this.logger.log(
        `Abandoned cart ${rowId} (company ${companyId}) superseded — shopper already ordered an identical cart moments earlier.`,
      );
    } catch (e) {
      this.logger.warn(
        `suppressPostOrderCart failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Is this customer name specific enough to identify ONE shopper in this tenant?
   *
   * Guards the name+total fallback in `markCheckoutConverted`, which would
   * otherwise silently close OTHER shoppers' live carts. Real tenant data: 27
   * contacts named "ali", 13 "muhammad ali", 12 "haider ali", 101 placeholder
   * "?" — and a single product price accounts for ~a quarter of all carts, so
   * "same name + same total, same day" genuinely collides. A distinctive full
   * name maps to 1-2 contacts; 3+ means it's common, so don't trust it.
   *
   * Fails CLOSED (false) on a junk/short name or a query error — a missed
   * auto-close just leaves the cart for manual dismissal, whereas a wrong
   * auto-close destroys a recovery opportunity with no trace.
   */
  private async isDistinctiveName(
    companyId: number,
    name: string,
  ): Promise<boolean> {
    const trimmed = name.trim();
    // Reject "?", ".", "...", and anything too short to be a real full name.
    if (trimmed.length < 6 || !/[a-z]/i.test(trimmed)) return false;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT COUNT(*) c FROM contacts WHERE company_id = ? AND LOWER(name) = ?`,
        companyId,
        trimmed.toLowerCase(),
      );
      return Number(rows[0]?.c ?? 0) <= NAME_MATCH_MAX_CONTACTS;
    } catch {
      return false;
    }
  }

  private async markCheckoutConverted(
    companyId: number,
    order: ShopifyOrderPayload,
  ): Promise<void> {
    const token = (order.checkout_token ?? '').trim();
    const phone = this.orderPhone(order); // normalized, matches stored format
    const email = (order.email || order.customer?.email || '')
      .trim()
      .toLowerCase();
    if (!token && !phone && !email) return;

    // Same-day scope (in the TENANT's timezone) so a repeat customer's genuine
    // future abandonment (a new checkout row) isn't retroactively wiped by an
    // unrelated earlier order.
    const dayStart = await this.tenantDayStartUtc(companyId);

    // Conversion value (raw column) for recovery-revenue attribution.
    const orderGid =
      order.admin_graphql_api_id ??
      (order.id != null ? `gid://shopify/Order/${order.id}` : null);
    const totalStr =
      order.total_price != null ? String(order.total_price).trim() : '';
    const totalNum =
      totalStr && !Number.isNaN(Number(totalStr)) ? Number(totalStr) : null;
    const customerName = [
      order.customer?.first_name,
      order.customer?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    // Raw (not Prisma findMany) because `total_price` is a raw column.
    const conds: string[] = [];
    const params: unknown[] = [companyId];
    if (token) {
      conds.push('checkout_token = ?');
      params.push(token);
    }
    if (phone) {
      conds.push('(phone = ? AND created_at >= ?)');
      params.push(phone, dayStart);
    }
    if (email) {
      conds.push('(LOWER(email) = ? AND created_at >= ?)');
      params.push(email, dayStart);
    }
    // CROSS-IDENTITY match. Shopify issues a NEW checkout token when a shopper
    // restarts checkout and leaves the old one abandoned forever — and the
    // shopper may complete it under a DIFFERENT phone/email than they abandoned
    // with, so token/phone/email can all miss even though the same human bought.
    // Fall back to matching the cart DETAILS: identical customer name AND
    // identical cart total, same tenant day. The name must be non-empty —
    // a NULL/blank name would otherwise sweep up every same-priced cart from
    // unrelated shoppers (one product price is shared by many carts).
    // ...and only when the name actually identifies ONE shopper here — a common
    // name ("ali": 27 contacts) would otherwise close unrelated live carts.
    if (
      customerName &&
      totalNum != null &&
      (await this.isDistinctiveName(companyId, customerName))
    ) {
      conds.push(
        `(contact_name IS NOT NULL AND contact_name <> ''
          AND LOWER(contact_name) = ? AND total_price = ? AND created_at >= ?)`,
      );
      params.push(customerName.toLowerCase(), totalNum, dayStart);
    }
    if (!conds.length) return;

    try {
      // Match pending OR already-recovered rows: a match on a recovered row is a
      // recovery that led to an order (recovery_sent_at stays set → attributed).
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT id FROM shopify_abandoned_checkouts
          WHERE company_id = ? AND status IN ('pending','recovered')
            AND (${conds.join(' OR ')})`,
        ...params,
      );
      if (!rows.length) return;
      const ids = rows.map((r) => r.id); // ints from DB — safe to inline
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts
           SET status = 'converted',
               converted_order_gid = ?,
               converted_value = ?,
               converted_at = NOW(3)
         WHERE company_id = ? AND id IN (${ids.join(',')})`,
        orderGid,
        totalNum,
        companyId,
      );
    } catch (e) {
      this.logger.warn(
        `markCheckoutConverted failed (company ${companyId}, token ${token}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Delayed worker — send recovery step `stepIndex` if the checkout is still
   *  pending, then chain the next step. Multi-step aware (falls back to a single
   *  legacy step when no sequence is configured). */
  private async processAbandonedRecovery(
    companyId: number,
    checkoutToken: string,
    stepIndex: number,
  ): Promise<void> {
    const row = await this.prisma.shopifyAbandonedCheckout.findUnique({
      where: {
        company_id_checkout_token: {
          company_id: companyId,
          checkout_token: checkoutToken,
        },
      },
    });
    // Only 'pending' carts still get nudged — converted/expired stop the chain.
    if (!row || row.status !== 'pending') {
      this.logger.log(
        `Abandoned recovery skipped (company ${companyId}, token ${checkoutToken}, step ${stepIndex}, status ${row?.status ?? 'missing'})`,
      );
      return;
    }
    // Re-check the gate + config at fire time (may have changed during the wait).
    const enabled =
      await this.featureService.proactiveNotificationsEnabled(companyId);
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const evt = this.deliveryConfigMap(cfg?.delivery_notifications)[
      'abandoned_cart'
    ];
    if (!enabled || !evt || !evt.enabled) {
      this.logger.log(
        `Abandoned recovery skipped (company ${companyId}) — feature/event off`,
      );
      return;
    }
    const legacyDelay =
      cfg?.abandoned_cart_delay_minutes && cfg.abandoned_cart_delay_minutes > 0
        ? cfg.abandoned_cart_delay_minutes
        : 180;
    const steps = await this.loadEffectiveSteps(companyId, evt, legacyDelay);
    const step = steps[stepIndex];
    if (!step) return; // sequence shortened / cleared since scheduling

    const order: ShopifyOrderPayload = {
      phone: row.phone ?? undefined,
      email: row.email ?? undefined,
      customer: {
        first_name: row.contact_name ?? undefined,
        phone: row.phone ?? undefined,
      },
      recovery_url: row.recovery_url ?? undefined,
    };
    await this.sendProactiveTemplate(
      companyId,
      order,
      step.templateId,
      step.variableMap,
      'abandoned_cart',
    );
    // Stamp recovery_sent_at on the FIRST send only (raw column) — it's what
    // distinguishes a "we messaged them" recovery from an organic re-order when
    // the conversion webhook lands.
    await this.prisma.$executeRawUnsafe(
      `UPDATE shopify_abandoned_checkouts
         SET recovery_sent_at = COALESCE(recovery_sent_at, NOW(3))
       WHERE id = ?`,
      row.id,
    );

    const next = steps[stepIndex + 1];
    if (next) {
      // Chain the next nudge; still 'pending' so it (and manual recovery) fire.
      const key = `shopify-recover:${companyId}:${checkoutToken}:${stepIndex + 1}`;
      await this.jobQueue.enqueue(
        'shopify',
        {
          kind: 'abandonedRecovery',
          companyId,
          checkoutToken,
          stepIndex: stepIndex + 1,
        },
        { delayMs: next.delayMinutes * 60_000, dedupKey: key, serialKey: key },
      );
      this.logger.log(
        `Abandoned recovery step ${stepIndex + 1}/${steps.length} sent (company ${companyId}); next in ${next.delayMinutes}m`,
      );
    } else {
      // Last nudge → drop off the dashboard (preserves the old single-step UX).
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts SET status = 'recovered' WHERE id = ?`,
        row.id,
      );
      this.logger.log(
        `Abandoned recovery final step ${stepIndex + 1}/${steps.length} sent (company ${companyId})`,
      );
    }
  }

  // ── Abandoned-checkout dashboard ──────────────────────────────────────
  /**
   * List pending abandoned checkouts for the tenant, EXCLUDING any whose
   * customer already placed an order TODAY (the requirement — Shopify keeps a
   * checkout alive after a separate order). The base rows need no Shopify call;
   * the "ordered today" filter runs as ONE live Shopify query per load (today's
   * orders → a phone/email set), not per row. Fail-open: if Shopify is
   * unreachable / PII-blocked we return the unfiltered pending list and let the
   * orders/create webhook backstop (markCheckoutConverted) keep it clean.
   */
  async listAbandonedCheckouts(companyId: number): Promise<
    Array<{
      id: number;
      contactName: string | null;
      phone: string | null;
      email: string | null;
      itemsSummary: string | null;
      items: Array<{
        variantId: string | null;
        title: string;
        variantTitle: string | null;
        price: string | null;
        quantity: number;
      }>;
      recoveryUrl: string | null;
      totalPrice: number | null;
      currency: string | null;
      assignedUserId: number | null;
      assignedName: string | null;
      createdAt: Date;
    }>
  > {
    // Opportunistic sweep: age out carts that have sat 'pending' for >14 days
    // with no outcome, so the dashboard stays actionable (best-effort).
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts
           SET status = 'expired'
         WHERE company_id = ? AND status = 'pending'
           AND created_at < (NOW() - INTERVAL 14 DAY)`,
        companyId,
      );
    } catch {
      /* non-fatal */
    }

    // Raw select — includes the new value/assignee columns (not in schema.prisma).
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: number;
        contact_name: string | null;
        phone: string | null;
        email: string | null;
        items_summary: string | null;
        items_json: unknown;
        recovery_url: string | null;
        total_price: unknown;
        currency: string | null;
        assigned_user_id: number | null;
        assigned_name: string | null;
        created_at: Date;
      }>
    >(
      `SELECT ac.id, ac.contact_name, ac.phone, ac.email, ac.items_summary,
              ac.items_json, ac.recovery_url, ac.total_price, ac.currency,
              ac.assigned_user_id, u.name assigned_name, ac.created_at
       FROM shopify_abandoned_checkouts ac
       LEFT JOIN users u ON u.id = ac.assigned_user_id
       WHERE ac.company_id = ? AND ac.status = 'pending'
         AND ac.phone IS NOT NULL AND ac.phone <> ''
       ORDER BY ac.created_at DESC
       LIMIT 500`,
      companyId,
    );

    const { phones, emails } = await this.ordersTodayIndex(companyId);
    const filtered =
      phones.size || emails.size
        ? rows.filter((r) => {
            const p = r.phone ? this.normalizePhone(r.phone) : '';
            const e = (r.email ?? '').trim().toLowerCase();
            if (p && phones.has(p)) return false;
            if (e && emails.has(e)) return false;
            return true;
          })
        : rows;

    /** Parse the raw items_json column; never throws (falls back to []). */
    const parseItems = (raw: unknown) => {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        return parsed.map((it: Record<string, unknown>) => ({
          variantId: (it.variantId as string) ?? null,
          title: String(it.title ?? 'item'),
          variantTitle: (it.variantTitle as string) ?? null,
          price: it.price == null ? null : String(it.price),
          quantity: Number(it.quantity ?? 1) || 1,
        }));
      } catch {
        return [];
      }
    };

    return filtered.map((r) => ({
      id: r.id,
      contactName: r.contact_name,
      phone: r.phone,
      email: r.email,
      items: parseItems(r.items_json),
      itemsSummary: r.items_summary,
      recoveryUrl: r.recovery_url,
      totalPrice: r.total_price == null ? null : Number(r.total_price),
      currency: r.currency,
      assignedUserId: r.assigned_user_id == null ? null : Number(r.assigned_user_id),
      assignedName: r.assigned_name,
      createdAt: r.created_at,
    }));
  }

  /** Assign (or clear) the agent responsible for recovering an abandoned cart. */
  async assignAbandonedCheckout(
    companyId: number,
    id: number,
    userId: number | null,
  ): Promise<{ ok: boolean }> {
    if (userId != null) {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, company_id: companyId },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('Agent not found');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE shopify_abandoned_checkouts SET assigned_user_id = ? WHERE id = ? AND company_id = ?`,
      userId,
      id,
      companyId,
    );
    return { ok: true };
  }

  /**
   * Abandoned-cart KPIs for the dashboard tile. `pending`/`valueAtRisk` are the
   * current live backlog; the recovery metrics are windowed to the last 30 days
   * (by created_at). `recordedRecent` = carts abandoned in the window (rate
   * denominator); `recovered` = those that converted via an order CREATED IN
   * CODESAPP (matched to pending_order_hashes) — not customer self-checkouts;
   * `recoveredRevenue` = their order value. Also returns the tenant's Shopify
   * webhook path so the UI can show a setup hint when nothing has ever been
   * captured. All-raw, tenant-scoped, never throws.
   */
  async abandonedStats(companyId: number): Promise<{
    pending: number;
    valueAtRisk: number;
    recordedRecent: number;
    recovered: number;
    recoveredRevenue: number;
    recoveryRate: number;
    currency: string | null;
    everRecorded: number;
    webhookPath: string;
  }> {
    let agg: {
      pending: bigint;
      value_at_risk: unknown;
      recorded_recent: bigint;
      recovered: bigint;
      recovered_revenue: unknown;
      currency: string | null;
      ever: bigint;
    } = {
      pending: 0n,
      value_at_risk: 0,
      recorded_recent: 0n,
      recovered: 0n,
      recovered_revenue: 0,
      currency: null,
      ever: 0n,
    };
    try {
      // "Recovered" = an abandoned cart that converted via an order CREATED IN
      // CODESAPP (its converted_order_gid matches an app-created
      // pending_order_hashes row) — NOT a customer's own Shopify self-checkout.
      // This credits recovery the team actually drove. `recorded_recent` is the
      // 30-day denominator for the rate.
      // Cart-side metrics: only carts WITH a phone count toward pending / value /
      // recorded (phone-less carts are hidden per tenant choice).
      const [cartRow] = await this.prisma.$queryRawUnsafe<
        Array<{
          pending: bigint;
          value_at_risk: unknown;
          recorded_recent: bigint;
          currency: string | null;
          ever: bigint;
        }>
      >(
        `SELECT
           SUM(status = 'pending' AND phone IS NOT NULL AND phone <> '') pending,
           COALESCE(SUM(CASE WHEN status = 'pending' AND phone IS NOT NULL AND phone <> '' THEN total_price ELSE 0 END), 0) value_at_risk,
           SUM(created_at >= (NOW() - INTERVAL 30 DAY) AND phone IS NOT NULL AND phone <> '') recorded_recent,
           MAX(currency) currency,
           COUNT(*) ever
         FROM shopify_abandoned_checkouts
         WHERE company_id = ?`,
        companyId,
      );
      // Recovered = orders actually CREATED from the abandoned-cart flow
      // (source='abandoned_cart') in the last 30 days + their value. This is the
      // agent-credible measure ("orders we made from abandoned carts"), not a
      // cart-row match — cancelled orders excluded.
      const [recRow] = await this.prisma.$queryRawUnsafe<
        Array<{ recovered: bigint; recovered_revenue: unknown }>
      >(
        `SELECT COUNT(*) recovered, COALESCE(SUM(order_total), 0) recovered_revenue
           FROM pending_order_hashes
          WHERE company_id = ? AND status = 'created' AND source = 'abandoned_cart'
            AND cancelled_at IS NULL AND created_at >= (NOW() - INTERVAL 30 DAY)`,
        companyId,
      );
      if (cartRow) {
        agg = {
          pending: cartRow.pending,
          value_at_risk: cartRow.value_at_risk,
          recorded_recent: cartRow.recorded_recent,
          recovered: recRow?.recovered ?? 0n,
          recovered_revenue: recRow?.recovered_revenue ?? 0,
          currency: cartRow.currency,
          ever: cartRow.ever,
        };
      }
    } catch (e) {
      this.logger.warn(
        `abandonedStats failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const recordedRecent = Number(agg.recorded_recent);
    const recovered = Number(agg.recovered);
    // Read-only: never mint a key from a stats read (ensureShopifyWebhookKey
    // creates one as a side effect) — just surface it if it already exists.
    const company = await this.prisma.company
      .findUnique({
        where: { id: companyId },
        select: { shopify_webhook_key: true },
      })
      .catch(() => null);
    const webhookKey = company?.shopify_webhook_key ?? '';
    return {
      pending: Number(agg.pending),
      valueAtRisk: Math.round(Number(agg.value_at_risk) * 100) / 100,
      recordedRecent,
      recovered,
      recoveredRevenue: Math.round(Number(agg.recovered_revenue) * 100) / 100,
      recoveryRate:
        recordedRecent > 0 ? Math.round((recovered / recordedRecent) * 100) : 0,
      currency: agg.currency ?? null,
      everRecorded: Number(agg.ever),
      webhookPath: webhookKey ? `/webhooks/shopify/${webhookKey}` : '',
    };
  }

  /** Normalized phone + lowercased email sets of every order created TODAY.
   *  Fail-open (empty sets) if Shopify is unreachable or PII-blocked. */
  private async ordersTodayIndex(
    companyId: number,
  ): Promise<{ phones: Set<string>; emails: Set<string> }> {
    const phones = new Set<string>();
    const emails = new Set<string>();
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { phones, emails };
    }
    // Tenant-timezone "today" so a PKT store's early-morning orders aren't
    // dropped by a UTC boundary (matches the app-wide timezone fix).
    const dayStart = await this.tenantDayStartUtc(companyId);
    const q = `created_at:>=${dayStart.toISOString()}`;
    type Node = {
      email?: string | null;
      phone?: string | null;
      customer?: { phone?: string | null; email?: string | null } | null;
    };
    type Res = {
      data?: { orders?: { edges: Array<{ node: Node }> } };
      errors?: Array<{ message: string }>;
    };
    const query = `query($q: String) {
      orders(first: 250, query: $q) {
        edges { node { email phone customer { phone email } } }
      }
    }`;
    try {
      const res = await this.shopifyGraphql<Res>(
        api.shopDomain,
        api.apiVersion,
        api.token,
        query,
        { q },
      );
      for (const edge of res?.data?.orders?.edges ?? []) {
        const n = edge.node;
        for (const raw of [n.phone, n.customer?.phone]) {
          const p = raw ? this.normalizePhone(raw) : '';
          if (p) phones.add(p);
        }
        for (const raw of [n.email, n.customer?.email]) {
          const e = (raw ?? '').trim().toLowerCase();
          if (e) emails.add(e);
        }
      }
    } catch (err) {
      this.logger.warn(
        `ordersTodayIndex failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { phones, emails };
  }

  /** Agent handled an abandoned checkout (created an order) → drop it off the
   *  dashboard. Tenant-scoped, best-effort. */
  async dismissAbandonedCheckout(
    companyId: number,
    id: number,
  ): Promise<{ dismissed: boolean }> {
    const res = await this.prisma.shopifyAbandonedCheckout.updateMany({
      where: { id, company_id: companyId, status: 'pending' },
      data: { status: 'converted' },
    });
    return { dismissed: res.count > 0 };
  }

  // ── Orders dashboard (agent + ad attribution) ─────────────────────────
  /**
   * List app-created Shopify orders for the tenant with the requested columns
   * (order no., date, items, customer, city, email). Attribution is LOCAL
   * (shopify_order_messages ↔ conversation ↔ contact, agent via the confirmation
   * message user_id / idempotency creator); order DETAIL (no./date/items/city)
   * is not stored and is batch-hydrated from Shopify (cached per order, PII
   * fields drop out on stores without Protected Customer Data approval).
   *
   *  scope='agent' — orders with a known creating agent.
   *  scope='ad'    — orders whose conversation came from a Meta ad/post.
   */
  async listCreatedOrders(
    companyId: number,
    opts: {
      scope: 'agent' | 'ad';
      from: Date;
      to: Date;
      page?: number;
      pageSize?: number;
      search?: string;
    },
  ): Promise<OrderReportResult> {
    const adOnly = opts.scope === 'ad';
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const offset = (page - 1) * pageSize;
    const search = (opts.search ?? '').trim();
    const like = `%${search}%`;
    const dec = (v: unknown): number =>
      v == null ? 0 : Number((v as { toString(): string }).toString());

    // Two authoritative sources:
    //  agent → pending_order_hashes (the row written the instant an agent
    //          submits the Create-order modal; catches orders that never got a
    //          confirmation message, which the old som-based query missed).
    //  ad    → shopify_order_messages of conversations that came from a Meta ad.
    // ORDER BY column is the real column (not an alias) for portability.
    let selectCols: string;
    let fromWhere: string;
    let baseParams: unknown[];
    let orderCol: string;
    if (!adOnly) {
      selectCols = `poh.order_gid AS orderGid,
        poh.created_at AS localCreatedAt,
        COALESCE(som.status, '') AS localStatus,
        ct.name AS customerName,
        ct.email AS contactEmail,
        u.name AS agentName,
        NULL AS adHeadline,
        NULL AS adSourceType,
        poh.order_total AS storedTotal,
        poh.order_currency AS storedCurrency,
        poh.cancelled_at AS cancelledAt,
        poh.cancel_reason AS cancelReason`;
      // poh.conversation_id isn't set by the create path, so the customer/contact
      // is resolved via the confirmation message's conversation (som) when one
      // exists. Orders with no confirmation message (~the ones the old report
      // missed entirely) have no local contact link → name falls back to the
      // Shopify-hydrated email in the UI.
      fromWhere = `FROM pending_order_hashes poh
        JOIN users u ON u.id = poh.created_by_user_id AND u.company_id = ?
        LEFT JOIN shopify_order_messages som
          ON som.company_id = poh.company_id AND som.shopify_order_gid = poh.order_gid
        LEFT JOIN conversations c ON c.id = som.conversation_id
        LEFT JOIN contacts ct ON ct.id = c.contact_id
        WHERE poh.company_id = ?
          AND poh.status = 'created'
          AND poh.created_by_user_id IS NOT NULL
          AND poh.order_gid IS NOT NULL
          AND poh.created_at >= ? AND poh.created_at <= ?
          ${search ? 'AND (ct.name LIKE ? OR ct.email LIKE ? OR poh.order_name LIKE ?)' : ''}`;
      baseParams = [
        companyId,
        companyId,
        opts.from,
        opts.to,
        ...(search ? [like, like, like] : []),
      ];
      orderCol = 'poh.created_at';
    } else {
      selectCols = `som.shopify_order_gid AS orderGid,
        som.created_at AS localCreatedAt,
        som.status AS localStatus,
        ct.name AS customerName,
        ct.email AS contactEmail,
        u.name AS agentName,
        JSON_UNQUOTE(JSON_EXTRACT(c.referral, '$.headline')) AS adHeadline,
        JSON_UNQUOTE(JSON_EXTRACT(c.referral, '$.source_type')) AS adSourceType,
        poh.order_total AS storedTotal,
        poh.order_currency AS storedCurrency,
        poh.cancelled_at AS cancelledAt,
        poh.cancel_reason AS cancelReason`;
      fromWhere = `FROM shopify_order_messages som
        JOIN messages m ON m.id = som.message_id
        JOIN conversations c ON c.id = som.conversation_id
        JOIN contacts ct ON ct.id = c.contact_id
        LEFT JOIN pending_order_hashes poh
          ON poh.company_id = som.company_id AND poh.order_gid = som.shopify_order_gid
        LEFT JOIN users u ON u.id = COALESCE(m.user_id, poh.created_by_user_id)
        WHERE som.company_id = ?
          AND c.referral_source_id IS NOT NULL
          AND som.created_at >= ? AND som.created_at <= ?
          ${search ? 'AND (ct.name LIKE ? OR ct.email LIKE ? OR som.shopify_order_gid LIKE ?)' : ''}`;
      baseParams = [
        companyId,
        opts.from,
        opts.to,
        ...(search ? [like, like, like] : []),
      ];
      orderCol = 'som.created_at';
    }

    type BaseRow = {
      orderGid: string;
      localCreatedAt: Date;
      localStatus: string;
      customerName: string | null;
      contactEmail: string | null;
      agentName: string | null;
      adHeadline: string | null;
      adSourceType: string | null;
      storedTotal: unknown;
      storedCurrency: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
    };

    // Cancelled/voided orders stay in the LIST (and in the pagination count) as
    // a record, but must not inflate the order/value SUMMARY — so the aggregates
    // below run over the same predicate plus `cancelled_at IS NULL`. In the ad
    // scope poh is LEFT JOINed, where a NULL poh also satisfies IS NULL (an
    // order we never tracked isn't cancelled) — which is what we want.
    const summaryWhere = `${fromWhere} AND poh.cancelled_at IS NULL`;

    // Count (accurate — every base row is one order), the page, and the summary
    // in parallel. byAgent/value summary only for the agent scope.
    const [countRows, rows, summaryRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT COUNT(*) c ${fromWhere}`,
        ...baseParams,
      ),
      this.prisma.$queryRawUnsafe<BaseRow[]>(
        // pageSize/offset are clamped integers (Math.floor + bounds above), so
        // inlining them is injection-safe and sidesteps the MySQL prepared-
        // statement quirk with bound LIMIT/OFFSET placeholders.
        `SELECT ${selectCols} ${fromWhere} ORDER BY ${orderCol} DESC LIMIT ${pageSize} OFFSET ${offset}`,
        ...baseParams,
      ),
      !adOnly
        ? this.prisma.$queryRawUnsafe<
            Array<{ name: string; orders: bigint; value: unknown; currency: string | null }>
          >(
            `SELECT u.name name, COUNT(*) orders,
                    COALESCE(SUM(poh.order_total), 0) value,
                    MAX(poh.order_currency) currency
             ${summaryWhere}
             GROUP BY u.id, u.name
             ORDER BY orders DESC`,
            ...baseParams,
          )
        : this.prisma.$queryRawUnsafe<
            Array<{ value: unknown; currency: string | null }>
          >(
            `SELECT COALESCE(SUM(poh.order_total), 0) value, MAX(poh.order_currency) currency ${summaryWhere}`,
            ...baseParams,
          ),
    ]);

    const total = Number(countRows[0]?.c ?? 0);

    const detail = await this.hydrateOrderDetail(
      companyId,
      rows.map((r) => r.orderGid),
    );

    const outRows: OrderReportRow[] = rows.map((r) => {
      const d = detail.get(r.orderGid);
      const numericId = r.orderGid.split('/').pop();
      const stored = r.storedTotal == null ? null : dec(r.storedTotal);
      return {
        orderGid: r.orderGid,
        adminUrl: detail.shopDomain
          ? `https://${detail.shopDomain}/admin/orders/${numericId}`
          : null,
        orderNo: d?.name ?? null,
        dateCreated: d?.createdAt ?? r.localCreatedAt.toISOString(),
        items: d?.items ?? [],
        city: d?.city ?? null,
        customerName: r.customerName,
        contactEmail: r.contactEmail || d?.email || null,
        agentName: r.agentName,
        adHeadline: r.adHeadline,
        adSourceType: r.adSourceType,
        localStatus: r.localStatus,
        // Prefer the real Shopify total (accurate for all history); fall back to
        // the value we captured at creation time for orders Shopify won't return.
        orderValue: d?.total ?? stored,
        currency: d?.currency ?? r.storedCurrency,
        financialStatus: d?.financialStatus ?? null,
        fulfillmentStatus: d?.fulfillmentStatus ?? null,
        tracking: d?.tracking ?? [],
        cancelledAt: r.cancelledAt ? new Date(r.cancelledAt).toISOString() : null,
        cancelReason: r.cancelReason,
      };
    });

    let byAgent: Array<{ name: string; orders: number; value: number }> = [];
    let totalValue = 0;
    let summaryCurrency: string | null = null;
    if (!adOnly) {
      const agg = summaryRows as Array<{
        name: string;
        orders: bigint;
        value: unknown;
        currency: string | null;
      }>;
      byAgent = agg.map((a) => ({
        name: a.name,
        orders: Number(a.orders),
        value: dec(a.value),
      }));
      totalValue = byAgent.reduce((s, a) => s + a.value, 0);
      summaryCurrency = agg.find((a) => a.currency)?.currency ?? null;
    } else {
      const s = (summaryRows as Array<{ value: unknown; currency: string | null }>)[0];
      totalValue = dec(s?.value);
      summaryCurrency = s?.currency ?? null;
    }

    return {
      rows: outRows,
      total,
      page,
      pageSize,
      summary: {
        totalOrders: total,
        totalValue: Math.round(totalValue * 100) / 100,
        currency: summaryCurrency,
        byAgent,
      },
    };
  }

  /** Batch-fetch Shopify order detail by GID (name/date/items/city/email +
   *  value/payment+fulfillment status/tracking), cached per order (5m). PII
   *  fields (email/city) drop out on Basic plans. Returns a map + the shop
   *  domain (for admin links); empty on any failure. */
  private async hydrateOrderDetail(
    companyId: number,
    gids: string[],
  ): Promise<Map<string, OrderHydratedDetail> & { shopDomain?: string }> {
    type Detail = OrderHydratedDetail;
    const out = new Map<string, Detail>() as Map<string, Detail> & {
      shopDomain?: string;
    };
    const unique = Array.from(new Set(gids.filter(Boolean)));
    if (!unique.length) return out;

    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return out;
    }
    out.shopDomain = api.shopDomain;

    // Serve cache hits; collect misses to fetch.
    const misses: string[] = [];
    for (const gid of unique) {
      const cached = this.cache.get<Detail>(`shopify-order:${companyId}:${gid}`);
      if (cached) out.set(gid, cached);
      else misses.push(gid);
    }
    if (!misses.length) return out;

    type Node = {
      id: string;
      name?: string;
      createdAt?: string | null;
      email?: string | null;
      shippingAddress?: { city?: string | null } | null;
      lineItems?: {
        edges: Array<{
          node: {
            title?: string | null;
            quantity?: number;
            variantTitle?: string | null;
            image?: { url?: string | null } | null;
            product?: { title?: string | null } | null;
          };
        }>;
      };
      totalPriceSet?: {
        shopMoney?: { amount?: string | null; currencyCode?: string | null };
      } | null;
      displayFinancialStatus?: string | null;
      displayFulfillmentStatus?: string | null;
      fulfillments?: Array<{
        trackingInfo?: Array<{
          number?: string | null;
          url?: string | null;
          company?: string | null;
        }> | null;
      }> | null;
    };
    type Res = {
      data?: { nodes?: Array<Node | null> };
      errors?: Array<{ message: string }>;
    };
    // Value + status + tracking are NOT PII-gated, so they're in both variants.
    const buildQuery = (withPii: boolean) => `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          fulfillments(first: 10) { trackingInfo { number url company } }
          ${withPii ? 'email shippingAddress { city }' : ''}
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                variantTitle
                image { url }
                product { title }
              }
            }
          }
        }
      }
    }`;
    const isPiiError = (res: Res | undefined) =>
      !!res?.errors?.some((e) =>
        /customer object|personally identifiable|protected customer|not approved to access/i.test(
          e.message ?? '',
        ),
      );

    // Chunk to stay well within Shopify's node-fetch limits.
    for (let i = 0; i < misses.length; i += 100) {
      const chunk = misses.slice(i, i + 100);
      try {
        let res = await this.shopifyGraphql<Res>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          buildQuery(true),
          { ids: chunk },
        );
        if (!res?.data?.nodes && isPiiError(res)) {
          res = await this.shopifyGraphql<Res>(
            api.shopDomain,
            api.apiVersion,
            api.token,
            buildQuery(false),
            { ids: chunk },
          );
        }
        for (const node of res?.data?.nodes ?? []) {
          if (!node?.id) continue;
          const amt = node.totalPriceSet?.shopMoney?.amount;
          const tracking: OrderTracking[] = [];
          for (const f of node.fulfillments ?? []) {
            for (const t of f?.trackingInfo ?? []) {
              if (t?.number || t?.url) {
                tracking.push({
                  number: t.number ?? null,
                  url: t.url ?? null,
                  company: t.company ?? null,
                });
              }
            }
          }
          const detail: Detail = {
            name: node.name ?? '',
            createdAt: node.createdAt ?? null,
            email: node.email ?? null,
            city: node.shippingAddress?.city ?? null,
            items: (node.lineItems?.edges ?? [])
              .map((e) => ({
                title: e.node.title ?? '',
                quantity: Number(e.node.quantity ?? 0),
                variantTitle:
                  e.node.variantTitle && e.node.variantTitle !== 'Default Title'
                    ? e.node.variantTitle
                    : null,
                productTitle: e.node.product?.title ?? null,
                image: e.node.image?.url ?? null,
              }))
              .filter((it) => it.title),
            total: amt != null && amt !== '' ? Number(amt) : null,
            currency: node.totalPriceSet?.shopMoney?.currencyCode ?? null,
            financialStatus: node.displayFinancialStatus ?? null,
            fulfillmentStatus: node.displayFulfillmentStatus ?? null,
            tracking,
          };
          out.set(node.id, detail);
          this.cache.set(`shopify-order:${companyId}:${node.id}`, detail, 300);
        }
      } catch (err) {
        this.logger.warn(
          `hydrateOrderDetail chunk failed (company ${companyId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  }

  /**
   * Shared proactive-notification send: resolves the contact/conversation and
   * sends the configured approved template. A null templateId = dark no-op
   * (the feature gate was already checked at enqueue). Reuses the order
   * template-send path; templates send outside the 24h window.
   */
  private async sendProactiveTemplate(
    companyId: number,
    order: ShopifyOrderPayload,
    templateId: number | null,
    varMap: Record<string, string>,
    label: string,
  ): Promise<void> {
    if (!templateId) {
      this.logger.log(
        `Shopify ${label} send skipped for company ${companyId} (no template configured)`,
      );
      return;
    }

    const phone = this.orderPhone(order);
    if (!phone) {
      this.logger.warn(
        `Shopify ${label} ${order.name ?? order.id} (company ${companyId}) has no customer phone — skipped`,
      );
      return;
    }

    const variables: Record<string, string> = {};
    for (const [slot, fieldKey] of Object.entries(varMap)) {
      variables[slot] = this.extractOrderValue(order, fieldKey);
    }

    // Get-or-create contact + conversation (mirrors processOrderSend).
    const name =
      [order.customer?.first_name, order.customer?.last_name]
        .filter(Boolean)
        .join(' ') || phone;
    const email = order.email || order.customer?.email || null;
    let contact = await this.prisma.contact.findFirst({
      where: { company_id: companyId, phone, deleted_at: null },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          company_id: companyId,
          name,
          phone,
          email,
          last_message_at: new Date(),
        },
      });
      await this.metering.incrementContacts(companyId);
    } else if (email && !contact.email) {
      contact = await this.prisma.contact.update({
        where: { id: contact.id },
        data: { email },
      });
    }

    let convo = await this.prisma.conversation.findFirst({
      where: { company_id: companyId, contact_id: contact.id, deleted_at: null },
      orderBy: { id: 'desc' },
    });
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          status: 'open',
          window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }

    // Templates send regardless of the 24h window.
    const message = (await this.inbox.sendMessage(companyId, convo.id, {
      type: SendMessageType.template,
      templateId,
      variables,
    })) as { id: number };

    this.logger.log(
      `Shopify ${label} ${order.name ?? order.id}: notification sent (company ${companyId}, msg ${message.id})`,
    );
  }

  /** Resolve { token, shopDomain, apiVersion } for an order-message row. */
  private async resolveShopifyApi(
    companyId: number,
    rowShopDomain: string,
    cfg: { shop_domain: string | null; api_version: string | null } | null,
  ): Promise<{ token: string; shopDomain: string; apiVersion: string } | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopify_admin_token_encrypted: true },
    });
    if (!company?.shopify_admin_token_encrypted) {
      this.logger.warn(
        `Cannot tag Shopify order (company ${companyId}): no Admin API token configured`,
      );
      return null;
    }
    let token: string;
    try {
      token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
    } catch {
      this.logger.error(
        `Cannot decrypt Shopify Admin token for company ${companyId}`,
      );
      return null;
    }
    const shopDomain = (rowShopDomain || cfg?.shop_domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!shopDomain) {
      this.logger.warn(
        `Cannot tag Shopify order (company ${companyId}): no store domain (set it in Settings → Shopify)`,
      );
      return null;
    }
    const apiVersion =
      cfg?.api_version && SHOPIFY_API_VERSIONS.includes(cfg.api_version)
        ? cfg.api_version
        : DEFAULT_SHOPIFY_API_VERSION;
    return { token, shopDomain, apiVersion };
  }

  /**
   * Add/remove ONLY our own tags on a Shopify order (never touches tags the
   * merchant uses for other things). Runs the remove and the add as TWO
   * SEPARATE requests (remove first), each declaring only the one variable it
   * uses. The old single combined mutation (a) declared an unused `$rem`/`$add`
   * variable when one side was empty — Shopify rejects an unused-variable
   * mutation, so add-only calls (pending tag, ⚠ NO WhatsApp) silently failed —
   * and (b) didn't reliably remove on the same order in one request, so the
   * confirm↔cancel flip left the old tag behind.
   */
  private async shopifyTagMutate(
    api: { token: string; shopDomain: string; apiVersion: string },
    orderGid: string,
    addTags: string[],
    removeTags: string[],
  ): Promise<{ removeOk: boolean; addOk: boolean }> {
    const add = addTags.filter(Boolean);
    const rem = removeTags.filter(Boolean);
    let removeOk = true;
    let addOk = true;
    if (rem.length) {
      removeOk = await this.runTagOp(api, 'tagsRemove', orderGid, rem);
      if (!removeOk) {
        this.logger.warn(
          `Shopify tagsRemove did not complete for ${orderGid} — tags ${JSON.stringify(rem)} may remain; proceeding with add`,
        );
      }
    }
    if (add.length) {
      addOk = await this.runTagOp(api, 'tagsAdd', orderGid, add);
    }
    return { removeOk, addOk };
  }

  private async runTagOp(
    api: { token: string; shopDomain: string; apiVersion: string },
    op: 'tagsAdd' | 'tagsRemove',
    orderGid: string,
    tags: string[],
  ): Promise<boolean> {
    const query = `mutation($id: ID!, $tags: [String!]!) {
      ${op}(id: $id, tags: $tags) { userErrors { message } }
    }`;
    try {
      const res = await this.shopifyGraphql<{
        data?: Record<string, { userErrors?: Array<{ message: string }> }>;
        errors?: Array<{ message: string }>;
      }>(api.shopDomain, api.apiVersion, api.token, query, {
        id: orderGid,
        tags,
      });
      const ue = res?.data?.[op]?.userErrors ?? [];
      if (res?.errors?.length || ue.length) {
        this.logger.warn(
          `Shopify ${op} errors for ${orderGid} tags=${JSON.stringify(tags)}: ${JSON.stringify(
            res.errors ?? ue,
          )}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Shopify ${op} failed for ${orderGid} tags=${JSON.stringify(tags)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private ourTags(
    cfg: { confirm_tag: string; cancel_tag: string; pending_tag: string | null } | null,
  ) {
    return {
      confirm: cfg?.confirm_tag || 'confirmed',
      cancel: cfg?.cancel_tag || 'cancelled',
      pending: cfg?.pending_tag || 'confirmation pending',
    };
  }

  /**
   * Agent manually confirms an order the customer never answered (or that has
   * no WhatsApp). Sets the `manual_confirmed_at` override on the mirror, flips
   * any confirmation-message row to 'confirmed', and applies the merchant's
   * confirm tag in Shopify (removing pending/cancel) — exactly the same tag end
   * state a customer's own Confirm tap produces. Tagging is best-effort (never
   * blocks the manual confirm if the Admin API is unavailable).
   */
  async markOrderConfirmed(
    companyId: number,
    orderGid: string,
  ): Promise<{ ok: true }> {
    const order = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: companyId,
          shopify_order_gid: orderGid,
        },
      },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found.');

    await this.prisma.shopifyOrder.update({
      where: {
        company_id_shopify_order_gid: {
          company_id: companyId,
          shopify_order_gid: orderGid,
        },
      },
      data: { manual_confirmed_at: new Date() },
    });

    // Move any confirmation-template row(s) for this order to 'confirmed' so the
    // per-order status reads consistently everywhere.
    await this.prisma.shopifyOrderMessage
      .updateMany({
        where: {
          company_id: companyId,
          shopify_order_gid: orderGid,
          status: { not: 'confirmed' },
        },
        data: { status: 'confirmed' },
      })
      .catch(() => undefined);

    // Apply the confirm tag in Shopify (best-effort).
    try {
      const cfg = await this.prisma.shopifyOrderConfig.findUnique({
        where: { company_id: companyId },
      });
      const api = await this.resolveShopifyApi(companyId, '', cfg);
      if (api) {
        const tags = this.ourTags(cfg);
        await this.shopifyTagMutate(
          api,
          orderGid,
          [tags.confirm],
          [tags.pending, tags.cancel],
        );
      }
    } catch (err) {
      this.logger.warn(
        `markOrderConfirmed: tag apply failed for ${orderGid} (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { ok: true };
  }

  /**
   * Customer pressed Confirm/Cancel. Idempotent + reversible: always remove
   * the pending tag and the OPPOSITE decision tag, add the chosen one — so a
   * customer can flip confirm↔cancel any number of times. Only our 3 tags
   * are ever touched.
   */
  private async processOrderTag(
    companyId: number,
    orderMessageId: number,
    decision: 'confirm' | 'cancel',
  ): Promise<void> {
    const row = await this.prisma.shopifyOrderMessage.findFirst({
      where: { id: orderMessageId, company_id: companyId },
    });
    if (!row) return;
    const targetStatus = decision === 'confirm' ? 'confirmed' : 'cancelled';
    if (row.status === targetStatus) return; // already in this state

    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const tags = this.ourTags(cfg);
    const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
    if (!api) return;

    const chosen = decision === 'confirm' ? tags.confirm : tags.cancel;
    const opposite = decision === 'confirm' ? tags.cancel : tags.confirm;
    const { removeOk, addOk } = await this.shopifyTagMutate(
      api,
      row.shopify_order_gid,
      [chosen],
      [tags.pending, opposite],
    );
    if (!addOk) return; // chosen tag not applied — don't update DB
    if (!removeOk) {
      this.logger.warn(
        `Shopify order ${row.shopify_order_gid}: old tags [${tags.pending}, ${opposite}] may still be present (remove failed); decision "${chosen}" was applied`,
      );
    }
    await this.prisma.shopifyOrderMessage.update({
      where: { id: row.id },
      data: { status: targetStatus },
    });
    this.logger.log(
      `Shopify order ${row.shopify_order_gid} → "${chosen}" (company ${companyId})`,
    );
  }

  /**
   * Decision window elapsed with no answer → add the pending tag (only if
   * the customer hasn't already confirmed/cancelled). Adds ONLY the pending
   * tag; never removes the merchant's other tags.
   */
  private async processPendingTag(
    companyId: number,
    orderMessageId: number,
  ): Promise<void> {
    const row = await this.prisma.shopifyOrderMessage.findFirst({
      where: { id: orderMessageId, company_id: companyId },
    });
    if (!row || row.status !== 'pending') return; // already answered
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const tags = this.ourTags(cfg);
    const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
    if (!api) return;
    const { addOk } = await this.shopifyTagMutate(
      api,
      row.shopify_order_gid,
      [tags.pending],
      [],
    );
    if (addOk) {
      this.logger.log(
        `Shopify order ${row.shopify_order_gid} → "${tags.pending}" (no answer in window, company ${companyId})`,
      );
    }
  }

  /**
   * The order's WhatsApp confirmation was undeliverable (wrong number / not a
   * WhatsApp user). Add the hardcoded "⚠ NO WhatsApp" tag and mark the row
   * 'undeliverable' so the pending-tag job (if it fires later) no-ops. Only
   * adds our tag — never removes the merchant's tags.
   */
  private async processNoWhatsappTag(
    companyId: number,
    orderMessageId: number,
  ): Promise<void> {
    const row = await this.prisma.shopifyOrderMessage.findFirst({
      where: { id: orderMessageId, company_id: companyId },
    });
    if (!row) return;
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
    });
    const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
    if (!api) return;
    const { addOk } = await this.shopifyTagMutate(
      api,
      row.shopify_order_gid,
      [NO_WHATSAPP_TAG],
      [],
    );
    if (addOk) {
      await this.prisma.shopifyOrderMessage.update({
        where: { id: row.id },
        data: { status: 'undeliverable' },
      });
      this.logger.log(
        `Shopify order ${row.shopify_order_gid} → "${NO_WHATSAPP_TAG}" (undeliverable, company ${companyId})`,
      );
    }
  }

  /**
   * Resolve { token, shopDomain, apiVersion } for agent-driven Admin API
   * calls (product search + manual order create). Throws clean 4xx/5xx for
   * the UI instead of returning null (unlike `resolveShopifyApi`, which is
   * for the silent worker path).
   */
  private async requireAdminApi(
    companyId: number,
  ): Promise<{ token: string; shopDomain: string; apiVersion: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopify_admin_token_encrypted: true },
    });
    if (!company?.shopify_admin_token_encrypted) {
      throw new BadRequestException(
        'No Shopify Admin API token configured. Add it in Settings → Shopify.',
      );
    }
    let token: string;
    try {
      token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
    } catch {
      throw new ServiceUnavailableException(
        'Cannot decrypt the Shopify Admin token.',
      );
    }
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
      select: { shop_domain: true, api_version: true },
    });
    const shopDomain = (cfg?.shop_domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!shopDomain) {
      throw new BadRequestException(
        'No Shopify store domain set. Add it in Settings → Shopify.',
      );
    }
    const apiVersion =
      cfg?.api_version && SHOPIFY_API_VERSIONS.includes(cfg.api_version)
        ? cfg.api_version
        : DEFAULT_SHOPIFY_API_VERSION;
    return { token, shopDomain, apiVersion };
  }

  /**
   * Search the merchant's products and return their variants (with live
   * prices) so the agent picks real items rather than typing titles/prices.
   * Requires the Admin token to have `read_products` scope.
   */
  async searchProducts(
    companyId: number,
    query: string,
  ): Promise<
    Array<{
      variantId: string;
      productTitle: string;
      variantTitle: string;
      description: string | null;
      price: string;
      compareAtPrice: string | null;
      discountPercent: number | null;
      sku: string | null;
      image: string | null;
      productUrl: string | null;
      available: boolean;
    }>
  > {
    const api = await this.requireAdminApi(companyId);
    const q = (query || '').trim();
    const gql = `query($q: String) {
      products(first: 20, query: $q) {
        edges { node {
          title
          handle
          onlineStoreUrl
          description(truncateAt: 300)
          # Return a RESIZED image (Shopify CDN transform) instead of the
          # multi-MB original: the inbox catalog send fetches this in the
          # browser and uploads it to WhatsApp, so a ~1024px JPEG (~150-400KB)
          # keeps quality good while making the fetch + upload fast and
          # non-blocking. preferredContentType: JPG also normalizes webp/png
          # originals to a WhatsApp-accepted type.
          featuredImage {
            url(transform: { maxWidth: 1024, maxHeight: 1024, preferredContentType: JPG })
          }
          variants(first: 25) {
            edges { node { id title price compareAtPrice sku availableForSale } }
          }
        } }
      }
    }`;
    let res: {
      data?: {
        products?: {
          edges: Array<{
            node: {
              title: string;
              handle?: string | null;
              onlineStoreUrl?: string | null;
              description?: string | null;
              featuredImage?: { url: string } | null;
              variants: {
                edges: Array<{
                  node: {
                    id: string;
                    title: string;
                    price: string;
                    compareAtPrice: string | null;
                    sku: string | null;
                    availableForSale: boolean;
                  };
                }>;
              };
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { q: q || undefined },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify product search failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to search products.',
      );
    }
    if (res?.errors?.length) {
      // Most commonly: the Admin token lacks the read_products scope.
      throw new BadRequestException(
        `Shopify could not return products (${res.errors
          .map((e) => e.message)
          .join('; ')}). Make sure the Admin token has the read_products scope.`,
      );
    }
    const out: Array<{
      variantId: string;
      productTitle: string;
      variantTitle: string;
      /** Short plain-text product description (truncated) when the store has one. */
      description: string | null;
      price: string;
      /** Original (compare-at) price when this variant is on a real discount. */
      compareAtPrice: string | null;
      /** Server-computed % off (round) when compareAtPrice > price, else null. */
      discountPercent: number | null;
      sku: string | null;
      image: string | null;
      productUrl: string | null;
      available: boolean;
    }> = [];
    for (const p of res?.data?.products?.edges ?? []) {
      const image = p.node.featuredImage?.url ?? null;
      // Prefer the published storefront URL; fall back to the canonical
      // myshopify product path (still resolves/redirects for the customer).
      const productUrl =
        p.node.onlineStoreUrl ??
        (p.node.handle
          ? `https://${api.shopDomain}/products/${p.node.handle}`
          : null);
      for (const v of p.node.variants.edges) {
        // Real discount = compareAtPrice strictly greater than the live price.
        // Server-compute the % so the AI NEVER does the math (Rule 5).
        const price = parseFloat(v.node.price);
        const compareAt = v.node.compareAtPrice
          ? parseFloat(v.node.compareAtPrice)
          : NaN;
        const onSale =
          Number.isFinite(price) && Number.isFinite(compareAt) && compareAt > price;
        out.push({
          variantId: v.node.id,
          productTitle: p.node.title,
          variantTitle:
            v.node.title === 'Default Title' ? '' : v.node.title,
          description: p.node.description?.trim() || null,
          price: v.node.price,
          compareAtPrice: onSale ? v.node.compareAtPrice : null,
          discountPercent: onSale
            ? Math.round((1 - price / compareAt) * 100)
            : null,
          sku: v.node.sku || null,
          image,
          productUrl,
          available: v.node.availableForSale,
        });
      }
    }
    return out;
  }

  /**
   * Resolve WhatsApp/Meta catalog `retailer_id`s to human labels
   * "Product Title (Variant)". For a Shopify-synced catalog (the common case —
   * the Meta "Facebook & Instagram" sales channel sets each item's retailer_id
   * to the Shopify **variant** ID), these are numeric Shopify variant IDs, so we
   * batch-resolve them with a single `nodes(ids:)` GraphQL call.
   *
   * TENANT-SCOPED (every lookup uses the caller company's own Shopify token) and
   * strictly BEST-EFFORT: returns an EMPTY map if the company has no Shopify
   * token/domain, if an id isn't a Shopify variant, or on ANY error — it NEVER
   * throws. The inbound-webhook order renderer depends on that (a Shopify hiccup
   * must never drop a customer's catalog order; it just falls back to the id).
   * Requires the Admin token's `read_products` scope.
   */
  async resolveCatalogItemNames(
    companyId: number,
    retailerIds: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // Only numeric ids are Shopify variant IDs; ignore anything else + dedupe.
    const ids = Array.from(
      new Set(retailerIds.filter((x) => typeof x === 'string' && /^\d+$/.test(x))),
    ).slice(0, 50);
    if (ids.length === 0) return out;
    try {
      const cfg = await this.prisma.shopifyOrderConfig.findUnique({
        where: { company_id: companyId },
      });
      const api = await this.resolveShopifyApi(companyId, '', cfg);
      if (!api) return out; // no Shopify configured for this tenant → raw ids
      const gids = ids.map((id) => `gid://shopify/ProductVariant/${id}`);
      const gql = `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant { id title product { title } }
        }
      }`;
      const res = await this.shopifyGraphql<{
        data?: {
          nodes?: Array<
            { id: string; title: string; product?: { title?: string } } | null
          >;
        };
      }>(api.shopDomain, api.apiVersion, api.token, gql, { ids: gids });
      for (const n of res?.data?.nodes ?? []) {
        if (!n?.id) continue;
        const rid = n.id.split('/').pop();
        if (!rid) continue;
        const variant =
          n.title && n.title !== 'Default Title' ? ` (${n.title})` : '';
        out.set(rid, `${n.product?.title ?? 'Product'}${variant}`);
      }
    } catch (err) {
      this.logger.warn(
        `resolveCatalogItemNames failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return out;
  }

  /**
   * Resolve Shopify ProductVariant gids → a small (CDN-resized) product image
   * URL, for the public tracking page's item thumbnails. Prefers the variant's
   * own image, falling back to the product's featured image. TENANT-SCOPED and
   * strictly BEST-EFFORT — returns an EMPTY map if the company has no Shopify
   * token/domain or on ANY error (the tracking page just renders a placeholder).
   * Requires the Admin token's `read_products` scope.
   */
  async getVariantImages(
    companyId: number,
    variantGids: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = Array.from(
      new Set(
        (variantGids || []).filter(
          (x) => typeof x === 'string' && x.startsWith('gid://shopify/ProductVariant/'),
        ),
      ),
    ).slice(0, 50);
    if (ids.length === 0) return out;
    try {
      const cfg = await this.prisma.shopifyOrderConfig.findUnique({
        where: { company_id: companyId },
      });
      const api = await this.resolveShopifyApi(companyId, '', cfg);
      if (!api) return out;
      const gql = `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            image { url(transform: { maxWidth: 240, maxHeight: 240, preferredContentType: JPG }) }
            product { featuredImage { url(transform: { maxWidth: 240, maxHeight: 240, preferredContentType: JPG }) } }
          }
        }
      }`;
      const res = await this.shopifyGraphql<{
        data?: {
          nodes?: Array<
            | {
                id: string;
                image?: { url?: string | null } | null;
                product?: { featuredImage?: { url?: string | null } | null } | null;
              }
            | null
          >;
        };
      }>(api.shopDomain, api.apiVersion, api.token, gql, { ids });
      for (const n of res?.data?.nodes ?? []) {
        if (!n?.id) continue;
        const url = n.image?.url ?? n.product?.featuredImage?.url ?? null;
        if (url) out.set(n.id, url);
      }
    } catch (err) {
      this.logger.warn(
        `getVariantImages failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return out;
  }

  /**
   * Humanize a Shopify fulfillment/shipment status enum (order-level
   * `displayFulfillmentStatus` OR per-fulfillment `displayStatus`) into short
   * customer-facing English. Shared by the AI agent tool and the agent-facing
   * Track-order lookup so the two never drift apart.
   */
  static humanizeFulfillmentStatus(s?: string | null): string {
    const v = (s ?? '').toUpperCase();
    switch (v) {
      case 'FULFILLED':
      case 'MARKED_AS_FULFILLED':
        return 'dispatched';
      case 'IN_TRANSIT':
        return 'in transit';
      case 'OUT_FOR_DELIVERY':
        return 'out for delivery';
      case 'DELIVERED':
        return 'delivered';
      case 'ATTEMPTED_DELIVERY':
      case 'NOT_DELIVERED':
        return 'delivery attempted';
      case 'PARTIALLY_FULFILLED':
        return 'partially dispatched';
      case 'READY_FOR_PICKUP':
        return 'ready for pickup';
      case 'PICKED_UP':
        return 'picked up';
      case 'CONFIRMED':
      case 'SUBMITTED':
      case 'LABEL_PRINTED':
      case 'LABEL_PURCHASED':
      case 'AWAITING_SHIPMENT':
        return 'preparing shipment';
      case 'FAILURE':
      case 'CANCELLED':
      case 'LABEL_VOIDED':
        return 'shipment cancelled';
      case 'UNFULFILLED':
      case '':
        return 'not dispatched yet';
      default:
        return v.replace(/_/g, ' ').toLowerCase();
    }
  }

  /**
   * Look up an order's current status by its number (e.g. "1001"), so the AI
   * (or an agent via the Track-order chat action) can give a FACTUAL status
   * instead of guessing. Requires the Admin token's read_orders scope. Never
   * throws — returns `{ found:false, error }` on any failure so callers can
   * ask/hand off cleanly.
   */
  /**
   * A contact's Shopify orders from the LOCAL mirror, matched by phone (last 9
   * digits, to ignore country-code/formatting differences). Powers the inbox
   * contact panel + header chip — reads the mirror only (no Shopify API) so it's
   * instant and shows every synced order, with the courier shipment status
   * joined in. Newest first.
   */
  async listContactOrders(
    companyId: number,
    phone: string,
  ): Promise<{
    count: number;
    orders: Array<{
      orderGid: string;
      orderName: string | null;
      financialStatus: string | null;
      fulfillmentStatus: string | null;
      shipmentId: number | null;
      shipmentStatus: string | null;
      courierType: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      total: number | null;
      outstanding: number | null;
      currency: string | null;
      createdAt: Date | null;
      itemsSummary: string | null;
      cancelled: boolean;
      archived: boolean;
    }>;
  }> {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length < 6) return { count: 0, orders: [] };
    const last = digits.slice(-9);
    const rows = await this.prisma.shopifyOrder.findMany({
      where: { company_id: companyId, phone: { contains: last } },
      orderBy: { shopify_created_at: 'desc' },
      take: 30,
      select: {
        shopify_order_gid: true,
        order_name: true,
        financial_status: true,
        fulfillment_status: true,
        total_price: true,
        total_outstanding: true,
        currency: true,
        shopify_created_at: true,
        line_items_summary: true,
        cancelled_at: true,
        archived_at: true,
      },
    });
    const gids = rows.map((r) => r.shopify_order_gid);
    const ships = gids.length
      ? await this.prisma.shipment.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: {
            id: true,
            shopify_order_gid: true,
            status: true,
            courier_type: true,
            courier_tracking_number: true,
          },
        })
      : [];
    const shipByGid = new Map(ships.map((s) => [s.shopify_order_gid, s]));
    const orders = rows.map((r) => {
      const ship = shipByGid.get(r.shopify_order_gid) ?? null;
      const trackingUrl =
        ship?.courier_type && ship?.courier_tracking_number
          ? courierTrackingUrl(ship.courier_type, ship.courier_tracking_number) ?? null
          : null;
      return {
        orderGid: r.shopify_order_gid,
        orderName: r.order_name,
        financialStatus: r.financial_status,
        fulfillmentStatus: r.fulfillment_status,
        shipmentId: ship?.id ?? null,
        shipmentStatus: ship?.status ?? null,
        courierType: ship?.courier_type ?? null,
        trackingNumber: ship?.courier_tracking_number ?? null,
        trackingUrl,
        total: r.total_price == null ? null : Number(r.total_price),
        outstanding: r.total_outstanding == null ? null : Number(r.total_outstanding),
        currency: r.currency,
        createdAt: r.shopify_created_at,
        itemsSummary: r.line_items_summary,
        cancelled: r.cancelled_at != null,
        archived: r.archived_at != null,
      };
    });
    return { count: orders.length, orders };
  }

  async getOrderStatus(
    companyId: number,
    orderNumber: string,
  ): Promise<{
    found: boolean;
    error?: boolean;
    name?: string;
    orderId?: string;
    adminUrl?: string;
    fulfillmentStatus?: string;
    shipmentStatus?: string;
    financialStatus?: string;
    /** ISO datetime the status last changed (latest fulfillment, else the order itself). */
    statusUpdatedAt?: string | null;
    tracking?: Array<{ url: string | null; number: string | null; company: string | null }>;
    // For caller-side ownership verification (don't leak another customer's order).
    customerPhone?: string | null;
    customerEmail?: string | null;
    shippingPhone?: string | null;
  }> {
    const digits = (orderNumber || '').replace(/[^0-9]/g, '');
    if (!digits) return { found: false };
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { found: false, error: true };
    }
    // The customer/shippingAddress/phone fields are PROTECTED PII: stores on
    // Shopify Basic (no Protected Customer Data approval) reject them, which
    // used to fail the WHOLE lookup — discarding the fully-accessible tracking
    // data. So we build the query WITH those fields (needed for the AI path's
    // ownership check) but fall back to a PII-free query when Shopify blocks
    // them, so tracking always works regardless of the store's plan.
    type OrderStatusNode = {
      id: string;
      name: string;
      updatedAt: string | null;
      displayFulfillmentStatus: string | null;
      displayFinancialStatus: string | null;
      phone?: string | null;
      customer?: { phone: string | null; email: string | null } | null;
      shippingAddress?: { phone: string | null } | null;
      fulfillments: Array<{
        displayStatus: string | null;
        updatedAt: string | null;
        trackingInfo: Array<{
          number: string | null;
          url: string | null;
          company: string | null;
        }>;
      }>;
    };
    type OrderStatusRes = {
      data?: { orders?: { edges: Array<{ node: OrderStatusNode }> } };
      errors?: Array<{ message: string }>;
    };
    const buildQuery = (withPii: boolean) => `query($q: String) {
      orders(first: 1, query: $q) {
        edges { node {
          id
          name
          updatedAt
          displayFulfillmentStatus
          displayFinancialStatus
          ${withPii ? 'phone customer { phone email } shippingAddress { phone }' : ''}
          fulfillments(first: 5) {
            displayStatus
            updatedAt
            trackingInfo { number url company }
          }
        } }
      }
    }`;
    const isPiiError = (res: OrderStatusRes | undefined) =>
      !!res?.errors?.some((e) =>
        /customer object|personally identifiable|protected customer|not approved to access/i.test(
          e.message ?? '',
        ),
      );
    try {
      let res = await this.shopifyGraphql<OrderStatusRes>(
        api.shopDomain,
        api.apiVersion,
        api.token,
        buildQuery(true),
        { q: `name:#${digits}` },
      );
      // PII blocked on this plan → retry without the customer/address fields so
      // the agent still gets name + status + tracking.
      if (!res?.data?.orders?.edges?.[0]?.node && isPiiError(res)) {
        res = await this.shopifyGraphql<OrderStatusRes>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          buildQuery(false),
          { q: `name:#${digits}` },
        );
      }
      const node = res?.data?.orders?.edges?.[0]?.node;
      // Only a hard failure when we got NO usable order back. Field-level PII
      // errors alongside a valid node are expected on Basic plans — ignore them.
      if (!node) {
        if (res?.errors?.length) {
          this.logger.warn(
            `Shopify order status errors (company ${companyId}): ${res.errors
              .map((e) => e.message)
              .join('; ')}`,
          );
          return { found: false, error: true };
        }
        return { found: false };
      }
      const fulfillments = node.fulfillments ?? [];
      const tracking = fulfillments
        .flatMap((f) => f.trackingInfo ?? [])
        .map((t) => ({
          url: t.url ?? null,
          number: t.number ?? null,
          company: t.company ?? null,
        }))
        .filter((t) => t.url || t.number);
      // Most-recently-updated fulfillment drives the per-shipment status/date;
      // fall back to the order's own updatedAt when nothing's fulfilled yet.
      const latestFulfillment = fulfillments
        .filter((f) => f.updatedAt)
        .sort(
          (a, b) =>
            new Date(b.updatedAt as string).getTime() -
            new Date(a.updatedAt as string).getTime(),
        )[0];
      const numericId = node.id.split('/').pop();
      return {
        found: true,
        name: node.name,
        orderId: node.id,
        adminUrl: numericId
          ? `https://${api.shopDomain}/admin/orders/${numericId}`
          : undefined,
        fulfillmentStatus: node.displayFulfillmentStatus ?? undefined,
        shipmentStatus: latestFulfillment?.displayStatus
          ? ShopifyService.humanizeFulfillmentStatus(latestFulfillment.displayStatus)
          : undefined,
        financialStatus: node.displayFinancialStatus ?? undefined,
        statusUpdatedAt: latestFulfillment?.updatedAt ?? node.updatedAt ?? null,
        tracking,
        customerPhone: node.customer?.phone ?? null,
        customerEmail: node.customer?.email ?? null,
        shippingPhone: node.shippingAddress?.phone ?? node.phone ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Shopify order status lookup failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { found: false, error: true };
    }
  }

  /**
   * Pull the store's products + policies and build the tenant's AI knowledge.
   *
   * RAG mode (when OPENAI_API_KEY is set): index ONE rich, embedded chunk per
   * product and per store policy into `ai_knowledge_chunks`, so the AI retrieves
   * only the few relevant items per question (scales to large catalogues). The
   * old single giant catalogue KB entry is removed to avoid double-injection.
   *
   * Fallback mode (no embeddings key): write a single compact catalogue entry
   * into the manual KB (the previous behaviour) so product answers still work.
   *
   * Re-running replaces everything (no duplicates). Requires read_products.
   */
  /**
   * Kick off a knowledge sync in the BACKGROUND (job queue) and return at once.
   * A full catalogue sync (paginated Shopify fetch + embeddings + 100+ inserts)
   * runs far longer than the platform's HTTP request timeout, so it must not be
   * done inline. Validates the Admin connection first for immediate feedback.
   */
  async requestKnowledgeSync(
    companyId: number,
  ): Promise<{ started: boolean }> {
    await this.requireAdminApi(companyId); // throws a clean 4xx if not connected
    await this.jobQueue.enqueue('shopify', { kind: 'syncKnowledge', companyId });
    return { started: true };
  }

  /**
   * Kick off the cancelled/voided reconciliation in the background (paging the
   * full order history exceeds an HTTP request budget — never run it inline).
   */
  async requestCancellationSync(
    companyId: number,
  ): Promise<{ started: boolean }> {
    await this.requireAdminApi(companyId); // throws a clean 4xx if not connected
    await this.jobQueue.enqueue('shopify', {
      kind: 'syncCancellations',
      companyId,
    });
    return { started: true };
  }

  /**
   * Which Admin API scopes the tenant's token actually holds, and which ones we
   * need are missing. Diagnoses the #1 cause of orders landing WITHOUT a linked
   * Shopify customer: `findOrCreateCustomer` needs read_customers to look one up
   * and write_customers to create one — it swallows failures by design (an order
   * must never fail because of customer linking), so a missing scope is silent.
   */
  async checkScopes(companyId: number): Promise<{
    granted: string[];
    missing: string[];
    customersOk: boolean;
  }> {
    const api = await this.requireAdminApi(companyId);
    const required = [
      'read_customers',
      'write_customers',
      'read_products',
      'write_draft_orders',
      'read_orders',
      'write_orders',
    ];
    type Res = {
      data?: {
        currentAppInstallation?: { accessScopes?: Array<{ handle?: string }> };
      };
    };
    const res = await this.shopifyGraphql<Res>(
      api.shopDomain,
      api.apiVersion,
      api.token,
      `query { currentAppInstallation { accessScopes { handle } } }`,
      {},
    );
    const granted = (res?.data?.currentAppInstallation?.accessScopes ?? [])
      .map((s) => s.handle ?? '')
      .filter(Boolean);
    const missing = required.filter((r) => !granted.includes(r));
    return {
      granted,
      missing,
      customersOk:
        granted.includes('read_customers') && granted.includes('write_customers'),
    };
  }

  /** Kick off the order-source backfill in the background (classifies existing
   *  orders as abandoned-cart vs inbox from the Shopify tag). */
  async requestOrderSourceSync(
    companyId: number,
  ): Promise<{ started: boolean }> {
    await this.requireAdminApi(companyId);
    await this.jobQueue.enqueue('shopify', {
      kind: 'syncOrderSources',
      companyId,
    });
    return { started: true };
  }

  /** Indexed-knowledge status for the tenant (product/policy counts + last sync). */
  knowledgeStatus(companyId: number) {
    return this.rag.status(companyId);
  }

  async syncKnowledge(companyId: number): Promise<{
    products: number;
    policies: number;
    mode: 'rag' | 'keyword';
  }> {
    const api = await this.requireAdminApi(companyId);
    // Page size kept modest (50) because each product also pulls variants +
    // metafields — a larger page can exceed Shopify's GraphQL query-cost limit
    // (which surfaces as a throttle error).
    const gql = `query($cursor: String) {
      shop { name currencyCode }
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id
          title
          handle
          onlineStoreUrl
          description
          productType
          vendor
          tags
          totalInventory
          variants(first: 25) {
            edges { node { title price compareAtPrice sku availableForSale inventoryQuantity } }
          }
          metafields(first: 30) {
            edges { node { namespace key value type } }
          }
        } }
      }
    }`;

    interface ProdNode {
      id: string;
      title: string;
      handle: string | null;
      onlineStoreUrl: string | null;
      description: string | null;
      productType: string | null;
      vendor: string | null;
      tags: string[] | null;
      totalInventory: number | null;
      variants: {
        edges: Array<{
          node: {
            title: string;
            price: string;
            compareAtPrice: string | null;
            sku: string | null;
            availableForSale: boolean;
            inventoryQuantity: number | null;
          };
        }>;
      };
      metafields?: {
        edges: Array<{
          node: {
            namespace: string | null;
            key: string | null;
            value: string | null;
            type: string | null;
          };
        }>;
      };
    }
    let shopName = '';
    let currency = '';
    const nodes: ProdNode[] = [];
    let cursor: string | null = null;
    // Safety cap: at most 10 pages (500 products) per sync.
    for (let page = 0; page < 10; page++) {
      let res: {
        data?: {
          shop?: { name: string; currencyCode: string };
          products?: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{ node: ProdNode }>;
          };
        };
        errors?: Array<{ message: string }>;
      };
      try {
        res = await this.shopifyGraphql(
          api.shopDomain,
          api.apiVersion,
          api.token,
          gql,
          { cursor },
        );
      } catch (err) {
        this.logger.warn(
          `Shopify KB sync failed (company ${companyId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw new ServiceUnavailableException(
          'Could not reach Shopify to sync products.',
        );
      }
      if (res?.errors?.length) {
        throw new BadRequestException(
          `Shopify could not return products (${res.errors
            .map((e) => e.message)
            .join('; ')}). Make sure the Admin token has the read_products scope.`,
        );
      }
      if (res.data?.shop) {
        shopName = res.data.shop.name;
        currency = res.data.shop.currencyCode;
      }
      const conn = res.data?.products;
      for (const e of conn?.edges ?? []) nodes.push(e.node);
      if (!conn?.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    const stripHtml = (s: string | null | undefined): string =>
      (s || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

    // Recursively pull plain text out of a Shopify rich_text_field value
    // (a ProseMirror-style JSON document of nested {children:[...], value}).
    const richTextToPlain = (raw: string): string => {
      try {
        const doc = JSON.parse(raw);
        const out: string[] = [];
        const walk = (n: unknown): void => {
          if (!n) return;
          if (Array.isArray(n)) {
            n.forEach(walk);
            return;
          }
          if (typeof n === 'object') {
            const o = n as Record<string, unknown>;
            if (typeof o.value === 'string') out.push(o.value);
            if (Array.isArray(o.children)) o.children.forEach(walk);
          }
        };
        walk(doc);
        return out.join(' ').replace(/\s+/g, ' ').trim();
      } catch {
        return '';
      }
    };

    // Turn a product's metafields into readable "Key: value" lines, keeping
    // only human-useful scalar/text/list/rich-text values and skipping noise
    // (JSON blobs, references, files, colors, money, metaobjects, app data).
    const formatMetafields = (
      mfs:
        | Array<{ namespace: string | null; key: string | null; value: string | null; type: string | null }>
        | undefined,
    ): string => {
      if (!mfs?.length) return '';
      const parts: string[] = [];
      for (const m of mfs) {
        const type = (m.type || '').toLowerCase();
        let val = (m.value ?? '').toString().trim();
        if (!val) continue;
        if (type === 'rich_text_field') {
          val = richTextToPlain(val);
        } else if (type.startsWith('list.') && type.includes('text')) {
          try {
            const arr = JSON.parse(val);
            if (Array.isArray(arr)) {
              val = arr.filter((x) => typeof x === 'string').join(', ');
            }
          } catch {
            /* keep raw */
          }
        } else if (
          !(
            type.includes('text') ||
            type.startsWith('number') ||
            type === 'boolean' ||
            type === 'rating' ||
            type === 'dimension' ||
            type === 'weight' ||
            type === 'volume' ||
            type === 'date' ||
            type === 'date_time' ||
            type === 'url' ||
            type === '' // older stores: untyped metafields are plain strings
          )
        ) {
          continue;
        }
        // dimension/weight/volume/rating come as {"value":x,"unit":y} JSON.
        if (val.startsWith('{')) {
          try {
            const o = JSON.parse(val) as Record<string, unknown>;
            if (o && typeof o === 'object') {
              val = [o.value, o.unit].filter((x) => x != null).join(' ').trim();
            }
          } catch {
            /* keep raw */
          }
        }
        if (!val) continue;
        if (val.length > 600) val = val.slice(0, 600);
        const key = (m.key || '').replace(/[_-]+/g, ' ').trim();
        if (key) parts.push(`${key}: ${val}`);
      }
      return parts.join('; ');
    };

    // ── RAG mode ──────────────────────────────────────────────────────────
    if (this.rag.isConfigured()) {
      const productItems: RagItem[] = nodes.map((p) => {
        const variants = p.variants.edges.map((v) => v.node);
        const prices = variants.map((v) => parseFloat(v.price) || 0);
        const min = prices.length ? Math.min(...prices) : 0;
        const max = prices.length ? Math.max(...prices) : 0;
        const priceStr =
          prices.length === 0
            ? 'n/a'
            : min === max
              ? `${min}`
              : `${min}–${max}`;
        const inStock = variants.some((v) => v.availableForSale);
        const desc = stripHtml(p.description).slice(0, 1500);
        const url =
          p.onlineStoreUrl ??
          (p.handle ? `https://${api.shopDomain}/products/${p.handle}` : '');
        const tags = (p.tags ?? []).filter(Boolean).join(', ');
        const metafields = formatMetafields(
          p.metafields?.edges.map((e) => e.node),
        );
        const parts = [
          `Product: ${p.title}`,
          `Price: ${priceStr}${currency ? ` ${currency}` : ''}`,
          `Availability: ${inStock ? 'in stock' : 'out of stock'}`,
          p.vendor ? `Brand: ${p.vendor}` : '',
          p.productType ? `Type: ${p.productType}` : '',
          tags ? `Tags: ${tags}` : '',
          metafields ? `Details: ${metafields}` : '',
          url ? `Link: ${url}` : '',
          variants.length
            ? `Variants: ${variants
                .map((v) => {
                  // Real discount, server-computed at sync so the AI relays it
                  // verbatim and never does the math (Rule 5). Required phrasing:
                  // "{price} after {pct}% discount (original price {compareAt})".
                  const price = parseFloat(v.price);
                  const compareAt = v.compareAtPrice
                    ? parseFloat(v.compareAtPrice)
                    : NaN;
                  const cur = currency ? ` ${currency}` : '';
                  const priceText =
                    Number.isFinite(price) &&
                    Number.isFinite(compareAt) &&
                    compareAt > price
                      ? `${v.price}${cur} after ${Math.round(
                          (1 - price / compareAt) * 100,
                        )}% discount (original price ${v.compareAtPrice}${cur})`
                      : `${v.price}${cur}`;
                  return (
                    `${v.title === 'Default Title' ? 'Standard' : v.title}` +
                    `${v.sku ? ` [${v.sku}]` : ''} = ${priceText}` +
                    `${v.availableForSale ? '' : ' (out of stock)'}`
                  );
                })
                .join('; ')}`
            : '',
          desc ? `Description: ${desc}` : '',
        ].filter(Boolean);
        return {
          sourceId: p.id,
          title: p.title,
          content: parts.join('\n'),
        };
      });

      // Store policies — best-effort, in a SEPARATE query so a missing field /
      // scope never breaks product indexing.
      const policyItems: RagItem[] = [];
      try {
        const polRaw = await this.shopifyGraphql<{
          data?: {
            shop?: {
              shopPolicies?: Array<{
                type: string | null;
                title: string | null;
                body: string | null;
              }>;
            };
          };
        }>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          `query { shop { shopPolicies { type title body } } }`,
          {},
        );
        for (const pol of polRaw?.data?.shop?.shopPolicies ?? []) {
          const text = stripHtml(pol.body).slice(0, 4000);
          if (text.length <= 20) continue;
          const title =
            pol.title ||
            (pol.type
              ? pol.type.replace(/_/g, ' ').toLowerCase()
              : 'Store policy');
          policyItems.push({
            sourceId: (pol.type || title).toLowerCase().slice(0, 191),
            title: `${title} — ${shopName || 'store'}`,
            content: `${title}\n${text}`,
          });
        }
      } catch (err) {
        this.logger.warn(
          `Shopify policy fetch skipped (company ${companyId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const prodRes = await this.rag.indexSource(
        companyId,
        'product',
        productItems,
      );
      const polRes = await this.rag.indexSource(
        companyId,
        'policy',
        policyItems,
      );

      // Embeddings worked → remove the legacy giant catalogue KB entry so it
      // isn't injected on top of retrieval.
      if (prodRes.embedded) {
        await this.aiKnowledge.deleteByTitle(
          companyId,
          'Shopify Product Catalogue (auto-synced)',
        );
        return {
          products: prodRes.indexed,
          policies: polRes.indexed,
          mode: 'rag',
        };
      }
      // Embedding call failed at runtime → fall through to keyword mode below.
    }

    // ── Fallback (keyword) mode: single compact catalogue manual entry ──────
    const lines: string[] = [];
    lines.push(
      `Product catalogue for ${shopName || 'the store'}${
        currency ? ` (prices in ${currency})` : ''
      }. Auto-synced from Shopify — do not edit by hand; re-sync to update.`,
    );
    lines.push('');
    for (const p of nodes) {
      const variants = p.variants.edges.map((v) => v.node);
      const prices = variants.map((v) => parseFloat(v.price) || 0);
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const priceStr =
        prices.length === 0
          ? 'n/a'
          : min === max
            ? `${min}`
            : `${min}–${max}`;
      const inStock = variants.some((v) => v.availableForSale);
      const desc = stripHtml(p.description).slice(0, 140);
      lines.push(
        `• ${p.title} — price ${priceStr}${currency ? ` ${currency}` : ''}; ${
          inStock ? 'in stock' : 'out of stock'
        }${p.vendor ? `; brand ${p.vendor}` : ''}${
          p.productType ? `; type ${p.productType}` : ''
        }.`,
      );
      if (variants.length > 1) {
        lines.push(
          `   Variants: ${variants
            .map((v) => {
              const pr = parseFloat(v.price);
              const ca = v.compareAtPrice ? parseFloat(v.compareAtPrice) : NaN;
              const cur = currency ? ` ${currency}` : '';
              const priceText =
                Number.isFinite(pr) && Number.isFinite(ca) && ca > pr
                  ? `${v.price}${cur} after ${Math.round(
                      (1 - pr / ca) * 100,
                    )}% discount (original price ${v.compareAtPrice}${cur})`
                  : `${v.price}${cur}`;
              return (
                `${v.title}${v.sku ? ` [${v.sku}]` : ''} = ${priceText}` +
                `${v.availableForSale ? '' : ' (out of stock)'}`
              );
            })
            .join('; ')}`,
        );
      }
      if (desc) lines.push(`   ${desc}`);
    }

    await this.aiKnowledge.upsertByTitle(
      companyId,
      'Shopify Product Catalogue (auto-synced)',
      lines.join('\n'),
    );
    return { products: nodes.length, policies: 0, mode: 'keyword' };
  }

  /**
   * Shared DraftOrderInput building (line items + shipping address) used by
   * both order creation and the shipping-rate calculation so the rates match
   * what the order will actually be.
   */
  /**
   * Exact, index-free customer lookup via `customerByIdentifier` (Admin API
   * 2024-10+). This is the RELIABLE path: Shopify's `customers(query: "phone:…")`
   * search goes through an eventually-consistent search index that frequently
   * misses an existing customer by phone — which left orders linked to NO
   * customer even when one existed. `customerByIdentifier` matches the stored
   * customer record directly. Returns null on miss / any error (best-effort).
   */
  private async lookupCustomerByIdentifier(
    api: { token: string; shopDomain: string; apiVersion: string },
    identifier: { phoneNumber: string } | { emailAddress: string },
  ): Promise<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  } | null> {
    const gql = `query($id: CustomerIdentifierInput!) {
      customerByIdentifier(identifier: $id) {
        id firstName lastName email phone
      }
    }`;
    let res: {
      data?: {
        customerByIdentifier?: {
          id: string;
          firstName: string | null;
          lastName: string | null;
          email: string | null;
          phone: string | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { id: identifier },
      );
    } catch (err) {
      this.logger.warn(
        `customerByIdentifier lookup failed (${JSON.stringify(
          identifier,
        )}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const node = res?.data?.customerByIdentifier;
    if (!node?.id) return null;
    return {
      id: node.id,
      firstName: node.firstName ?? null,
      lastName: node.lastName ?? null,
      email: node.email ?? null,
      phone: node.phone ?? null,
    };
  }

  /**
   * Search the merchant's customers by email and/or phone so the agent can
   * link an order to an existing customer (no duplicates). Requires the Admin
   * token's `read_customers` scope. Phone is matched both with and without a
   * leading "+" since Shopify stores E.164 (+92…) and our contacts store
   * digits (92…).
   */
  async searchCustomer(
    companyId: number,
    params: { phone?: string; email?: string },
  ): Promise<
    Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
    }>
  > {
    const api = await this.requireAdminApi(companyId);
    const email = (params.email || '').trim();
    const phoneDigits = (params.phone || '').replace(/\D/g, '');

    // 1) Exact, index-free lookups first (reliable). Phone (E.164) then email.
    //    The legacy `customers(query:)` search below is an eventually-consistent
    //    index that often misses an existing customer by phone.
    if (phoneDigits) {
      const byPhone = await this.lookupCustomerByIdentifier(api, {
        phoneNumber: `+${phoneDigits}`,
      });
      if (byPhone) return [byPhone];
    }
    if (email) {
      const byEmail = await this.lookupCustomerByIdentifier(api, {
        emailAddress: email,
      });
      if (byEmail) return [byEmail];
    }

    // 2) Fall back to the search index (kept as a safety net; may miss).
    const terms: string[] = [];
    if (email) terms.push(`email:${email}`);
    if (phoneDigits) {
      terms.push(`phone:+${phoneDigits}`);
      terms.push(`phone:${phoneDigits}`);
    }
    if (!terms.length) return [];
    const gql = `query($q: String) {
      customers(first: 5, query: $q) {
        edges { node { id firstName lastName email phone } }
      }
    }`;
    let res: {
      data?: {
        customers?: {
          edges: Array<{
            node: {
              id: string;
              firstName: string | null;
              lastName: string | null;
              email: string | null;
              phone: string | null;
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { q: terms.join(' OR ') },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify customer search failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to look up the customer.',
      );
    }
    if (res?.errors?.length) {
      throw new BadRequestException(
        `Shopify could not search customers (${res.errors
          .map((e) => e.message)
          .join('; ')}). Make sure the Admin token has the read_customers scope.`,
      );
    }
    return (res?.data?.customers?.edges ?? []).map((e) => ({
      id: e.node.id,
      firstName: e.node.firstName ?? null,
      lastName: e.node.lastName ?? null,
      email: e.node.email ?? null,
      phone: e.node.phone ?? null,
    }));
  }

  /**
   * Customer memory for the AI agent: the customer's saved default address +
   * recent orders, looked up by phone (best-effort, never throws). Needs the
   * Admin token's read_customers + read_orders scopes; returns `{found:false}`
   * on any miss/error so the agent can carry on without history.
   */
  async getCustomerOrders(
    companyId: number,
    phone: string,
    email?: string,
  ): Promise<{
    found: boolean;
    name?: string | null;
    email?: string | null;
    defaultAddress?: string | null;
    orders: Array<{
      name: string;
      createdAt: string;
      fulfillment?: string | null;
      financial?: string | null;
      total?: string | null;
    }>;
  }> {
    let cust:
      | { id: string; firstName: string | null; lastName: string | null }
      | undefined;
    try {
      const matches = await this.searchCustomer(companyId, { phone, email });
      cust = matches[0];
    } catch {
      return { found: false, orders: [] };
    }
    if (!cust) return { found: false, orders: [] };

    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { found: false, orders: [] };
    }
    const gql = `query($id: ID!) {
      customer(id: $id) {
        firstName lastName email
        defaultAddress { address1 address2 city province country zip }
        orders(first: 5, sortKey: CREATED_AT, reverse: true) {
          edges { node {
            name createdAt displayFulfillmentStatus displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
          } }
        }
      }
    }`;
    try {
      const res = await this.shopifyGraphql<{
        data?: {
          customer?: {
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            defaultAddress?: {
              address1: string | null;
              address2: string | null;
              city: string | null;
              province: string | null;
              country: string | null;
              zip: string | null;
            } | null;
            orders?: {
              edges: Array<{
                node: {
                  name: string;
                  createdAt: string;
                  displayFulfillmentStatus: string | null;
                  displayFinancialStatus: string | null;
                  currentTotalPriceSet?: {
                    shopMoney?: { amount: string; currencyCode: string };
                  } | null;
                };
              }>;
            };
          } | null;
        };
        errors?: Array<{ message: string }>;
      }>(api.shopDomain, api.apiVersion, api.token, gql, { id: cust.id });

      const c = res?.data?.customer;
      const name =
        [cust.firstName, cust.lastName].filter(Boolean).join(' ').trim() ||
        [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim() ||
        null;
      if (!c) return { found: true, name, orders: [] };
      const a = c.defaultAddress;
      const defaultAddress = a
        ? [a.address1, a.address2, a.city, a.province, a.country, a.zip]
            .filter(Boolean)
            .join(', ')
        : null;
      const orders = (c.orders?.edges ?? []).map((e) => ({
        name: e.node.name,
        createdAt: e.node.createdAt,
        fulfillment: e.node.displayFulfillmentStatus,
        financial: e.node.displayFinancialStatus,
        total: e.node.currentTotalPriceSet?.shopMoney
          ? `${e.node.currentTotalPriceSet.shopMoney.amount} ${e.node.currentTotalPriceSet.shopMoney.currencyCode}`
          : null,
      }));
      return { found: true, name, email: c.email, defaultAddress, orders };
    } catch {
      return { found: true, orders: [] };
    }
  }

  /**
   * Most recent order's line items + shipping address for a customer (by phone).
   * Used by the AI repeat-order flow (Enh 6.2) + customer memory (Enh 6.3) to
   * deterministically reorder the same products to the saved address. Returns
   * `found:false` / empty `items` on any miss — never throws.
   */
  async getLastOrderItems(
    companyId: number,
    phone: string,
    email?: string,
  ): Promise<{
    found: boolean;
    name?: string;
    shipping?: {
      name?: string;
      phone?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
    };
    items: Array<{ title: string; quantity: number; variantId?: string }>;
  }> {
    let cust:
      | { id: string; firstName: string | null; lastName: string | null }
      | undefined;
    try {
      const matches = await this.searchCustomer(companyId, { phone, email });
      cust = matches[0];
    } catch {
      return { found: false, items: [] };
    }
    if (!cust) return { found: false, items: [] };

    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { found: false, items: [] };
    }
    const gql = `query($id: ID!) {
      customer(id: $id) {
        firstName lastName
        orders(first: 1, sortKey: CREATED_AT, reverse: true) {
          edges { node {
            name
            shippingAddress { firstName lastName phone address1 address2 city countryCodeV2 }
            lineItems(first: 50) { edges { node { title quantity variant { id } } } }
          } }
        }
      }
    }`;
    try {
      const res = await this.shopifyGraphql<{
        data?: {
          customer?: {
            firstName: string | null;
            lastName: string | null;
            orders?: {
              edges: Array<{
                node: {
                  name: string;
                  shippingAddress?: {
                    firstName: string | null;
                    lastName: string | null;
                    phone: string | null;
                    address1: string | null;
                    address2: string | null;
                    city: string | null;
                    countryCodeV2: string | null;
                  } | null;
                  lineItems?: {
                    edges: Array<{
                      node: {
                        title: string;
                        quantity: number;
                        variant?: { id: string } | null;
                      };
                    }>;
                  };
                };
              }>;
            };
          } | null;
        };
        errors?: Array<{ message: string }>;
      }>(api.shopDomain, api.apiVersion, api.token, gql, { id: cust.id });

      const node = res?.data?.customer?.orders?.edges?.[0]?.node;
      const name =
        [cust.firstName, cust.lastName].filter(Boolean).join(' ').trim() ||
        undefined;
      if (!node) return { found: true, name, items: [] };
      const sa = node.shippingAddress;
      const shipping = sa
        ? {
            name:
              [sa.firstName, sa.lastName].filter(Boolean).join(' ').trim() ||
              undefined,
            phone: sa.phone ?? undefined,
            address1:
              [sa.address1, sa.address2].filter(Boolean).join(', ') || undefined,
            city: sa.city ?? undefined,
            countryCode: sa.countryCodeV2 ?? undefined,
          }
        : undefined;
      const items = (node.lineItems?.edges ?? [])
        .map((e) => ({
          title: e.node.title,
          quantity: e.node.quantity,
          variantId: e.node.variant?.id ?? undefined,
        }))
        .filter((i) => i.title && i.quantity > 0);
      return { found: true, name, shipping, items };
    } catch {
      return { found: true, items: [] };
    }
  }

  /**
   * Create a Shopify customer from the order fields (only after a search found
   * none — the UI enforces check-then-create). Requires `write_customers`.
   * Phone is normalized to +E.164 (Shopify rejects bare digits).
   */
  async createCustomer(
    companyId: number,
    dto: {
      customerName?: string;
      phone?: string;
      email?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
    },
  ): Promise<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  }> {
    const api = await this.requireAdminApi(companyId);
    const nameParts = (dto.customerName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const firstName = nameParts.shift();
    const lastName = nameParts.length ? nameParts.join(' ') : undefined;
    const phoneDigits = (dto.phone || '').replace(/\D/g, '');
    const email = (dto.email || '').trim();
    if (!email && !phoneDigits) {
      throw new BadRequestException(
        'A phone or email is required to create a customer.',
      );
    }
    const input: Record<string, unknown> = {};
    if (firstName) input.firstName = firstName;
    if (lastName) input.lastName = lastName;
    if (email) input.email = email;
    if (phoneDigits) input.phone = `+${phoneDigits}`;
    if (dto.address1 || dto.city) {
      const addr: Record<string, unknown> = {};
      if (firstName) addr.firstName = firstName;
      if (lastName) addr.lastName = lastName;
      if (dto.address1) addr.address1 = dto.address1;
      if (dto.city) addr.city = dto.city;
      if (phoneDigits) addr.phone = `+${phoneDigits}`;
      if (dto.countryCode) addr.countryCode = dto.countryCode.toUpperCase();
      input.addresses = [addr];
    }
    const gql = `mutation($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id firstName lastName email phone }
        userErrors { field message }
      }
    }`;
    let res: {
      data?: {
        customerCreate?: {
          customer?: {
            id: string;
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            phone: string | null;
          } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { input },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify customer create failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to create the customer.',
      );
    }
    const cust = res?.data?.customerCreate?.customer ?? null;
    if (!cust?.id) {
      const msgs =
        res?.data?.customerCreate?.userErrors ?? res?.errors ?? [];
      throw new BadRequestException(
        `Shopify could not create the customer: ${
          msgs.map((e) => e.message).join('; ') || 'unknown error'
        }. Make sure the Admin token has the write_customers scope.`,
      );
    }
    return {
      id: cust.id,
      firstName: cust.firstName ?? null,
      lastName: cust.lastName ?? null,
      email: cust.email ?? null,
      phone: cust.phone ?? null,
    };
  }

  /**
   * Best-effort: find an existing Shopify customer by phone/email, else create
   * one from the order details. Returns the customer GID or null. NEVER throws
   * — a customer-link failure (e.g. missing read_/write_customers scope) must
   * not block the order itself.
   */
  private async findOrCreateCustomer(
    companyId: number,
    dto: {
      customerName?: string;
      phone?: string;
      email?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
    },
  ): Promise<string | null> {
    const phone = (dto.phone || '').trim();
    const email = (dto.email || '').trim();
    if (!phone && !email) {
      this.logger.warn(
        `findOrCreateCustomer: NO customer linked (company ${companyId}) — order has neither phone nor email`,
      );
      return null;
    }
    try {
      // searchCustomer now does an exact customerByIdentifier lookup first,
      // so an existing customer is found reliably (no more orphan orders).
      const matches = await this.searchCustomer(companyId, { phone, email });
      if (matches[0]?.id) {
        this.logger.log(
          `findOrCreateCustomer: matched existing customer ${matches[0].id} (company ${companyId}, phone=${phone || '-'}, email=${email || '-'})`,
        );
        return matches[0].id;
      }
      try {
        const created = await this.createCustomer(companyId, dto);
        return created.id ?? null;
      } catch (createErr) {
        // Shopify enforces unique phone/email. If the create is rejected
        // because the value is already taken, the customer provably exists —
        // recover the existing id via the exact lookup instead of dropping it.
        const msg =
          createErr instanceof Error ? createErr.message : String(createErr);
        if (/taken|already exist|in use/i.test(msg)) {
          const api = await this.requireAdminApi(companyId);
          const phoneDigits = phone.replace(/\D/g, '');
          const recovered =
            (phoneDigits &&
              (await this.lookupCustomerByIdentifier(api, {
                phoneNumber: `+${phoneDigits}`,
              }))) ||
            (email &&
              (await this.lookupCustomerByIdentifier(api, {
                emailAddress: email,
              }))) ||
            null;
          if (recovered?.id) {
            this.logger.log(
              `findOrCreateCustomer recovered existing customer ${recovered.id} after a unique-constraint create error (company ${companyId})`,
            );
            return recovered.id;
          }
        }
        throw createErr;
      }
    } catch (err) {
      this.logger.warn(
        `findOrCreateCustomer failed (company ${companyId}, order continues without a linked customer): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Map a manual discount to Shopify's DraftOrderAppliedDiscountInput
   * (PERCENTAGE value = percent; FIXED_AMOUNT value = amount in store
   * currency). Returns undefined for a missing/zero discount.
   */
  private mapDiscount(
    d?: {
      type: 'percentage' | 'fixed';
      value: number;
    },
    title = 'Discount',
  ): Record<string, unknown> | undefined {
    if (!d || !(Number(d.value) > 0)) return undefined;
    return {
      value: Number(d.value),
      valueType: d.type === 'percentage' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
      title: title || 'Discount',
    };
  }

  /**
   * Ask Shopify to compute the AUTHORITATIVE totals for a cart + its manual
   * discounts (per-line + order-level) + shipping — via the non-persisting
   * `draftOrderCalculate`. The order form shows THESE numbers instead of doing
   * its own discount maths, so the total the agent sees always equals the order
   * Shopify actually creates (fixes divergence on fixed-amount + stacked
   * order/line discounts). Same `write_draft_orders` access the create uses.
   */
  async calculateOrder(
    companyId: number,
    dto: {
      lineItems: Array<{
        variantId?: string;
        title?: string;
        quantity: number;
        price?: number;
        discount?: { type: 'percentage' | 'fixed'; value: number };
      }>;
      customerName?: string;
      phone?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
      orderDiscount?: { type: 'percentage' | 'fixed'; value: number; title?: string };
      shippingLine?: { title: string; price: number };
    },
  ): Promise<{
    subtotal: number;
    discount: number;
    shipping: number;
    tax: number;
    total: number;
    currency: string | null;
    lineItems: Array<{
      title: string;
      quantity: number;
      original: number;
      discounted: number;
    }>;
  }> {
    const api = await this.requireAdminApi(companyId);
    const base = this.buildDraftBase(dto);
    const input: Record<string, unknown> = { lineItems: base.lineItems };
    if (base.shippingAddress) input.shippingAddress = base.shippingAddress;
    const orderDisc = this.mapDiscount(dto.orderDiscount, dto.orderDiscount?.title);
    if (orderDisc) input.appliedDiscount = orderDisc;
    if (dto.shippingLine && dto.shippingLine.title) {
      input.shippingLine = {
        title: dto.shippingLine.title,
        price: Number(dto.shippingLine.price ?? 0).toFixed(2),
      };
    }

    const gql = `mutation($input: DraftOrderInput!) {
      draftOrderCalculate(input: $input) {
        calculatedDraftOrder {
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalDiscountsSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems {
            title
            quantity
            originalTotalSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
          }
        }
        userErrors { field message }
      }
    }`;
    let res: {
      data?: {
        draftOrderCalculate?: {
          calculatedDraftOrder?: Record<string, any> | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { input },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify order calc failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to calculate the order.',
      );
    }
    if (res?.errors?.length) {
      throw new BadRequestException(
        `Shopify could not calculate the order (${res.errors
          .map((e) => e.message)
          .join('; ')}).`,
      );
    }
    const ue = res?.data?.draftOrderCalculate?.userErrors ?? [];
    if (ue.length) {
      throw new BadRequestException(`Shopify: ${ue.map((e) => e.message).join('; ')}`);
    }
    const c = res?.data?.draftOrderCalculate?.calculatedDraftOrder ?? {};
    const num = (x: any): number => Number(x?.shopMoney?.amount ?? 0) || 0;
    // Shopify's `subtotalPriceSet` on a calculated draft order is NET of the
    // order-level discount, so showing it beside a separate "Discount" line
    // makes the summary read `Subtotal − Discount ≠ Total`. Use the GROSS
    // subtotal (sum of each line's pre-discount original) instead, so that
    // `subtotal − discount + shipping + tax = total` always holds for the UI.
    const lineItems = (c.lineItems ?? []).map((li: any) => ({
      title: li.title,
      quantity: li.quantity,
      original: num(li.originalTotalSet),
      discounted: num(li.discountedTotalSet),
    }));
    const grossSubtotal = lineItems.reduce(
      (s: number, li: { original: number }) => s + li.original,
      0,
    );
    return {
      subtotal: grossSubtotal || num(c.subtotalPriceSet),
      discount: num(c.totalDiscountsSet),
      shipping: num(c.totalShippingPriceSet),
      tax: num(c.totalTaxSet),
      total: num(c.totalPriceSet),
      currency:
        c.totalPriceSet?.shopMoney?.currencyCode ??
        c.subtotalPriceSet?.shopMoney?.currencyCode ??
        null,
      lineItems,
    };
  }

  private buildDraftBase(dto: {
    lineItems: Array<{
      variantId?: string;
      title?: string;
      quantity: number;
      price?: number;
      discount?: { type: 'percentage' | 'fixed'; value: number };
    }>;
    customerName?: string;
    phone?: string;
    address1?: string;
    city?: string;
    countryCode?: string;
  }): { lineItems: unknown[]; shippingAddress?: Record<string, unknown> } {
    const lineItems = dto.lineItems.map((li) => {
      const item: Record<string, unknown> = li.variantId
        ? { variantId: li.variantId, quantity: li.quantity }
        : {
            title: li.title || 'Item',
            quantity: li.quantity,
            // Deprecated-but-functional Money scalar; custom fallback only.
            originalUnitPrice: Number(li.price ?? 0).toFixed(2),
          };
      const disc = this.mapDiscount(li.discount);
      if (disc) item.appliedDiscount = disc;
      return item;
    });
    const nameParts = (dto.customerName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const firstName = nameParts.shift();
    const lastName = nameParts.length ? nameParts.join(' ') : undefined;
    const addr: Record<string, unknown> = {};
    if (firstName) addr.firstName = firstName;
    if (lastName) addr.lastName = lastName;
    if (dto.address1) addr.address1 = dto.address1;
    if (dto.city) addr.city = dto.city;
    if (dto.phone) addr.phone = dto.phone;
    if (dto.countryCode) addr.countryCode = dto.countryCode.toUpperCase();
    return {
      lineItems,
      shippingAddress: Object.keys(addr).length ? addr : undefined,
    };
  }

  /**
   * Calculate the shipping rates Shopify offers for this cart + destination
   * (the store's own shipping zones/rates), so the agent picks a real rate
   * rather than guessing. `draftOrderCalculate` is non-persisting; needs the
   * same write_draft_orders access the order create already uses. Returns []
   * (not an error) when the store offers no rate for the destination.
   */
  async getShippingRates(
    companyId: number,
    dto: {
      lineItems: Array<{
        variantId?: string;
        title?: string;
        quantity: number;
        price?: number;
      }>;
      customerName?: string;
      phone?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
    },
  ): Promise<
    Array<{
      handle: string;
      title: string;
      amount: string;
      currencyCode: string;
    }>
  > {
    const api = await this.requireAdminApi(companyId);
    const base = this.buildDraftBase(dto);
    const input: Record<string, unknown> = { lineItems: base.lineItems };
    if (base.shippingAddress) input.shippingAddress = base.shippingAddress;

    const gql = `mutation($input: DraftOrderInput!) {
      draftOrderCalculate(input: $input) {
        calculatedDraftOrder {
          availableShippingRates {
            handle
            title
            price { amount currencyCode }
          }
        }
        userErrors { field message }
      }
    }`;
    let res: {
      data?: {
        draftOrderCalculate?: {
          calculatedDraftOrder?: {
            availableShippingRates?: Array<{
              handle: string;
              title: string;
              price: { amount: string; currencyCode: string };
            }>;
          } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        gql,
        { input },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify shipping calc failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to calculate shipping.',
      );
    }
    if (res?.errors?.length) {
      throw new BadRequestException(
        `Shopify could not calculate shipping (${res.errors
          .map((e) => e.message)
          .join('; ')}).`,
      );
    }
    const ue = res?.data?.draftOrderCalculate?.userErrors ?? [];
    if (ue.length) {
      throw new BadRequestException(
        `Shopify shipping error: ${ue.map((e) => e.message).join('; ')}`,
      );
    }
    const rates =
      res?.data?.draftOrderCalculate?.calculatedDraftOrder
        ?.availableShippingRates ?? [];
    return rates.map((r) => ({
      handle: r.handle,
      title: r.title,
      amount: r.price.amount,
      currencyCode: r.price.currencyCode,
    }));
  }

  /** Normalize a Shopify discount node into our StoreDiscount. Only the "basic"
   *  code/automatic discounts carry a single %/amount we can translate; anything
   *  else (BXGY, free-shipping, tiered) → appliesSimple:false. */
  private normalizeDiscount(id: string, d: any): StoreDiscount | null {
    const typename = d?.__typename;
    const title = d?.title ?? 'Discount';
    const code = d?.codes?.edges?.[0]?.node?.code ?? null;
    const status = d?.status ?? null;
    if (status && status !== 'ACTIVE') return null; // active discounts only
    const simpleType =
      typename === 'DiscountCodeBasic' || typename === 'DiscountAutomaticBasic';
    if (!simpleType) {
      return {
        id,
        title,
        code,
        valueType: null,
        value: null,
        appliesSimple: false,
        summary: `${title} — not a simple %/amount discount`,
      };
    }
    const v = d?.customerGets?.value;
    if (v?.__typename === 'DiscountPercentage' && v.percentage != null) {
      // Shopify returns a fraction (0.1 = 10%); normalize to 0–100.
      const pct = Number(v.percentage) <= 1 ? Number(v.percentage) * 100 : Number(v.percentage);
      const rounded = Math.round(pct * 100) / 100;
      return {
        id,
        title,
        code,
        valueType: 'percentage',
        value: rounded,
        appliesSimple: true,
        summary: `${rounded}% off`,
      };
    }
    if (v?.__typename === 'DiscountAmount' && v.amount?.amount != null) {
      const amt = Number(v.amount.amount) || 0;
      return {
        id,
        title,
        code,
        valueType: 'fixed',
        value: amt,
        appliesSimple: true,
        summary: `${amt} off`,
      };
    }
    return {
      id,
      title,
      code,
      valueType: null,
      value: null,
      appliesSimple: false,
      summary: title,
    };
  }

  /** The store's active discounts (code + automatic) for the order-form picker.
   *  Simple %/amount ones can be applied; complex ones are shown but flagged. */
  async listStoreDiscounts(companyId: number): Promise<StoreDiscount[]> {
    const api = await this.requireAdminApi(companyId);
    const gql = `query {
      discountNodes(first: 100) {
        edges { node {
          id
          discount {
            __typename
            ... on DiscountCodeBasic {
              title status
              codes(first: 1) { edges { node { code } } }
              customerGets { value { __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              } }
            }
            ... on DiscountAutomaticBasic {
              title status
              customerGets { value { __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              } }
            }
          }
        } }
      }
    }`;
    let res: any;
    try {
      res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, {});
    } catch (err) {
      this.logger.warn(
        `Shopify listStoreDiscounts failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    const edges = res?.data?.discountNodes?.edges ?? [];
    const out: StoreDiscount[] = [];
    for (const e of edges) {
      const norm = this.normalizeDiscount(e?.node?.id, e?.node?.discount);
      if (norm) out.push(norm);
    }
    return out;
  }

  /** Validate a typed discount CODE against the store; 404 if none/inactive. */
  async lookupStoreDiscount(companyId: number, code: string): Promise<StoreDiscount> {
    const clean = (code || '').trim();
    if (!clean) throw new BadRequestException('Enter a discount code.');
    const api = await this.requireAdminApi(companyId);
    const gql = `query($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title status
            codes(first: 1) { edges { node { code } } }
            customerGets { value { __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount } }
            } }
          }
        }
      }
    }`;
    let res: any;
    try {
      res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, {
        code: clean,
      });
    } catch {
      throw new ServiceUnavailableException('Could not reach Shopify to check the code.');
    }
    const node = res?.data?.codeDiscountNodeByCode;
    if (!node?.codeDiscount) {
      throw new NotFoundException(`No active discount found for "${clean}".`);
    }
    const norm = this.normalizeDiscount(node.id, node.codeDiscount);
    if (!norm) throw new NotFoundException(`"${clean}" isn't a usable discount.`);
    norm.code = clean; // preserve the exact code the agent typed
    return norm;
  }

  /**
   * Edit an order's shipping address in Shopify (orderUpdate) AND mirror the
   * change locally so the fulfilment queue / booking uses the corrected address
   * immediately. Writes only — reads stay PII-gated, but write_orders is enough
   * to correct an address. Surfaces Shopify userErrors as a clean 4xx.
   */
  async updateOrderAddress(
    companyId: number,
    dto: {
      orderGid: string;
      name?: string;
      phone?: string;
      email?: string;
      address1?: string;
      address2?: string;
      city?: string;
      countryCode?: string;
      zip?: string;
    },
  ): Promise<{ ok: true }> {
    const api = await this.requireAdminApi(companyId);
    const name = (dto.name ?? '').trim();
    const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
    const lastName = rest.join(' ');
    const shippingAddress: Record<string, unknown> = {};
    if (firstName) shippingAddress.firstName = firstName;
    if (lastName) shippingAddress.lastName = lastName;
    if (dto.address1 != null) shippingAddress.address1 = dto.address1;
    if (dto.address2 != null) shippingAddress.address2 = dto.address2;
    if (dto.city != null) shippingAddress.city = dto.city;
    if (dto.phone) shippingAddress.phone = dto.phone;
    if (dto.countryCode) shippingAddress.countryCode = dto.countryCode.toUpperCase();
    if (dto.zip != null) shippingAddress.zip = dto.zip;
    const email = (dto.email ?? '').trim();
    // Order email lives on the order itself, not the shipping address.
    const input: Record<string, unknown> = { id: dto.orderGid };
    if (Object.keys(shippingAddress).length) input.shippingAddress = shippingAddress;
    if (email) input.email = email;
    if (!input.shippingAddress && !input.email) {
      throw new BadRequestException('No fields to update.');
    }

    const gql = `mutation($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }`;
    let res: {
      data?: {
        orderUpdate?: {
          order?: { id: string } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, {
        input,
      });
    } catch (err) {
      this.logger.warn(
        `Shopify order address update failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException('Could not reach Shopify to update the address.');
    }
    const ue = res?.data?.orderUpdate?.userErrors ?? [];
    if (ue.length || !res?.data?.orderUpdate?.order?.id) {
      throw new BadRequestException(
        ue.map((e) => e.message).filter(Boolean).join('; ') ||
          res?.errors?.map((e) => e.message).join('; ') ||
          'Shopify rejected the address update.',
      );
    }

    // Mirror the corrected address locally (targeted, tenant-scoped — never
    // creates a row, never touches other fields). Name/phone only overwrite
    // when supplied.
    await this.prisma.shopifyOrder
      .updateMany({
        where: { company_id: companyId, shopify_order_gid: dto.orderGid },
        data: {
          ...(name ? { customer_name: name } : {}),
          ...(dto.phone ? { phone: dto.phone } : {}),
          ...(email ? { email } : {}),
          ...(dto.address1 != null ? { address1: dto.address1 } : {}),
          ...(dto.address2 != null ? { address2: dto.address2 } : {}),
          ...(dto.city != null ? { city: dto.city } : {}),
          ...(dto.countryCode ? { country_code: dto.countryCode.toUpperCase() } : {}),
          synced_at: new Date(),
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(
          `Order address mirror update failed (company ${companyId}, ${dto.orderGid}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );

    // Keep the CRM contact's address in sync with the correction (match by the
    // order's phone → contact; only when we have an address + a phone to match).
    const contactAddress =
      [dto.address1, dto.address2].filter(Boolean).join(', ') || null;
    if (dto.phone && (contactAddress || dto.city)) {
      const digits = dto.phone.replace(/\D/g, '').slice(-10);
      if (digits.length >= 7) {
        await this.prisma.contact
          .updateMany({
            where: { company_id: companyId, phone: { contains: digits }, deleted_at: null },
            data: {
              ...(contactAddress ? { address: contactAddress } : {}),
              ...(dto.city ? { city: dto.city } : {}),
            },
          })
          .catch(() => undefined);
      }
    }
    return { ok: true };
  }

  /**
   * Fetch an order's current line items for the in-app item editor. Line items
   * are NOT PII, so any authed tenant user may read them. Used to render the
   * edit modal before committing changes back to Shopify.
   */
  async getOrderEditableItems(
    companyId: number,
    orderGid: string,
  ): Promise<{
    fulfillmentStatus: string;
    editable: boolean;
    items: Array<{
      lineItemId: string;
      variantId: string | null;
      title: string;
      variantTitle: string | null;
      quantity: number;
      price: string | null;
      image: string | null;
    }>;
  }> {
    const api = await this.requireAdminApi(companyId);
    const query = `query($id: ID!) {
      order(id: $id) {
        id
        displayFulfillmentStatus
        lineItems(first: 100) {
          edges { node {
            id title quantity sku
            variant { id title price image { url } }
            originalUnitPriceSet { shopMoney { amount } }
          } }
        }
      }
    }`;
    type Res = {
      data?: {
        order?: {
          displayFulfillmentStatus?: string | null;
          lineItems?: {
            edges?: Array<{
              node?: {
                id: string;
                title?: string | null;
                quantity?: number | null;
                variant?: {
                  id?: string | null;
                  title?: string | null;
                  price?: string | null;
                  image?: { url?: string | null } | null;
                } | null;
                originalUnitPriceSet?: { shopMoney?: { amount?: string | null } } | null;
              };
            }>;
          };
        } | null;
      };
    };
    const res = await this.shopifyGraphql<Res>(api.shopDomain, api.apiVersion, api.token, query, {
      id: orderGid,
    });
    const order = res?.data?.order;
    if (!order) throw new NotFoundException('Order not found in Shopify.');
    const disp = (order.displayFulfillmentStatus ?? '').toLowerCase();
    return {
      fulfillmentStatus: disp || 'unfulfilled',
      // Editing a fulfilled order is refused by Shopify — only offer it while
      // still unfulfilled.
      editable: disp === '' || disp === 'unfulfilled',
      items: (order.lineItems?.edges ?? []).map((e) => ({
        lineItemId: e.node!.id,
        variantId: e.node!.variant?.id ?? null,
        title: e.node!.title ?? 'Item',
        variantTitle: e.node!.variant?.title ?? null,
        quantity: e.node!.quantity ?? 0,
        price: e.node!.variant?.price ?? e.node!.originalUnitPriceSet?.shopMoney?.amount ?? null,
        image: e.node!.variant?.image?.url ?? null,
      })),
    };
  }

  /**
   * Edit an order's line items (change quantity / remove / add) and COMMIT the
   * change back to Shopify via the order-editing API (orderEditBegin →
   * setQuantity/addVariant → orderEditCommit), then refresh the local mirror's
   * totals + line items. Existing lines are matched to the calculated order by
   * variant id (or title for custom lines). Customer is NOT notified.
   */
  async editOrderItems(
    companyId: number,
    orderGid: string,
    changes: {
      updates?: Array<{
        variantId?: string | null;
        title?: string | null;
        quantity: number;
        discount?: { type: 'percentage' | 'fixed'; value: number } | null;
      }>;
      adds?: Array<{
        variantId: string;
        quantity: number;
        discount?: { type: 'percentage' | 'fixed'; value: number } | null;
      }>;
    },
  ): Promise<{ ok: true }> {
    const api = await this.requireAdminApi(companyId);
    const g = <T>(query: string, variables: Record<string, unknown>) =>
      this.shopifyGraphql<T>(api.shopDomain, api.apiVersion, api.token, query, variables);

    // 1. Begin the edit → a calculated order we mutate then commit.
    type BeginRes = {
      data?: {
        orderEditBegin?: {
          calculatedOrder?: {
            id: string;
            totalPriceSet?: { shopMoney?: { currencyCode?: string } } | null;
            lineItems?: {
              edges?: Array<{
                node?: { id: string; title?: string | null; variant?: { id?: string | null } | null };
              }>;
            };
          } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    const begin = await g<BeginRes>(
      `mutation($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            totalPriceSet { shopMoney { currencyCode } }
            lineItems(first: 100) { edges { node { id title variant { id } } } }
          }
          userErrors { field message }
        }
      }`,
      { id: orderGid },
    );
    const co = begin?.data?.orderEditBegin?.calculatedOrder;
    if (!co?.id) {
      throw new BadRequestException(
        begin?.data?.orderEditBegin?.userErrors?.map((e) => e.message).join('; ') ||
          'Shopify could not start the order edit (already fulfilled?).',
      );
    }
    const calcId = co.id;
    const currencyCode = co.totalPriceSet?.shopMoney?.currencyCode ?? 'PKR';
    const calcLines = (co.lineItems?.edges ?? []).map((e) => e.node!).filter(Boolean);

    // Stage a per-line discount on a calculated line item (percentage or fixed).
    // Order-editing discounts are ADDITIVE per commit — see the caveat in the
    // controller/UI: re-editing a line that already carries a discount stacks.
    const applyLineDiscount = async (
      lineItemId: string,
      disc?: { type: 'percentage' | 'fixed'; value: number } | null,
    ) => {
      const value = Number(disc?.value);
      if (!disc || !(value > 0)) return;
      const discount =
        disc.type === 'percentage'
          ? { percentValue: Math.min(value, 100), description: 'Discount' }
          : {
              fixedValue: { amount: value.toFixed(2), currencyCode },
              description: 'Discount',
            };
      await g(
        `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
          orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
            userErrors { field message }
          }
        }`,
        { id: calcId, lineItemId, discount },
      );
    };

    // 2. Apply quantity changes to existing lines (0 removes) + any discount.
    for (const u of changes.updates ?? []) {
      const cl = calcLines.find((c) =>
        u.variantId ? c.variant?.id === u.variantId : c.title === u.title,
      );
      if (!cl) continue;
      const q = Math.max(0, Math.floor(u.quantity));
      await g(
        `mutation($id: ID!, $lineItemId: ID!, $q: Int!) {
          orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $q) {
            userErrors { message }
          }
        }`,
        { id: calcId, lineItemId: cl.id, q },
      );
      if (q > 0) await applyLineDiscount(cl.id, u.discount);
    }

    // 3. Add new variants (+ discount on the freshly-added line).
    type AddRes = {
      data?: {
        orderEditAddVariant?: {
          calculatedLineItem?: { id?: string | null } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    for (const a of changes.adds ?? []) {
      if (!a.variantId || a.quantity <= 0) continue;
      const added = await g<AddRes>(
        `mutation($id: ID!, $variantId: ID!, $q: Int!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $q) {
            calculatedLineItem { id }
            userErrors { message }
          }
        }`,
        { id: calcId, variantId: a.variantId, q: Math.floor(a.quantity) },
      );
      const addedId = added?.data?.orderEditAddVariant?.calculatedLineItem?.id;
      if (addedId) await applyLineDiscount(addedId, a.discount);
    }

    // 4. Commit.
    type CommitRes = {
      data?: {
        orderEditCommit?: {
          order?: { id: string } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    const commit = await g<CommitRes>(
      `mutation($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Items edited in CodesApp") {
          order { id }
          userErrors { field message }
        }
      }`,
      { id: calcId },
    );
    const ue = commit?.data?.orderEditCommit?.userErrors ?? [];
    if (ue.length || !commit?.data?.orderEditCommit?.order?.id) {
      throw new BadRequestException(
        ue.map((e) => e.message).filter(Boolean).join('; ') ||
          'Shopify rejected the order edit.',
      );
    }

    // 5. Refresh the mirror's line items + totals (COD/value change with items).
    await this.refreshOrderTotals(companyId, orderGid).catch(() => undefined);
    return { ok: true };
  }

  /** Refresh a mirror order's line items + totals after an edit (non-PII). */
  private async refreshOrderTotals(companyId: number, orderGid: string): Promise<void> {
    const api = await this.requireAdminApi(companyId);
    // NOTE: read `currentQuantity`, NOT `quantity`. After an order edit, a line's
    // `quantity` stays at the ORIGINAL ordered amount — a removed line still
    // reports quantity 2 with currentQuantity 0, and a reduced line keeps its
    // original quantity. Using `quantity` here left removed/reduced products in
    // the mirror even though the total (currentTotalPriceSet) had updated.
    const query = `query($id: ID!) {
      order(id: $id) {
        currencyCode
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount } }
        lineItems(first: 100) {
          edges { node {
            title quantity currentQuantity
            variant { id title price }
          } }
        }
      }
    }`;
    type Res = {
      data?: {
        order?: {
          currencyCode?: string | null;
          currentTotalPriceSet?: { shopMoney?: { amount?: string | null; currencyCode?: string | null } } | null;
          totalOutstandingSet?: { shopMoney?: { amount?: string | null } } | null;
          lineItems?: {
            edges?: Array<{
              node?: {
                title?: string | null;
                quantity?: number | null;
                currentQuantity?: number | null;
                variant?: { id?: string | null; title?: string | null; price?: string | null } | null;
              };
            }>;
          };
        } | null;
      };
    };
    const res = await this.shopifyGraphql<Res>(api.shopDomain, api.apiVersion, api.token, query, {
      id: orderGid,
    });
    const order = res?.data?.order;
    if (!order) return;
    const items = (order.lineItems?.edges ?? [])
      .map((e) => ({
        title: e.node?.title ?? 'Item',
        // currentQuantity = qty after edits; falls back to quantity for stores/
        // versions that don't return it. Removed lines (0) are filtered out below.
        quantity: e.node?.currentQuantity ?? e.node?.quantity ?? 0,
        variantTitle: e.node?.variant?.title ?? null,
        variantId: e.node?.variant?.id ?? null,
        price: e.node?.variant?.price ?? null,
      }))
      .filter((i) => i.quantity > 0);
    const summary = formatLineItemsSummary(items);
    const totalPrice = order.currentTotalPriceSet?.shopMoney?.amount;
    const outstanding = order.totalOutstandingSet?.shopMoney?.amount;
    const currency = order.currentTotalPriceSet?.shopMoney?.currencyCode || order.currencyCode || undefined;
    await this.prisma.shopifyOrder.updateMany({
      where: { company_id: companyId, shopify_order_gid: orderGid },
      data: {
        line_items: items,
        line_items_summary: summary,
        ...(totalPrice != null ? { total_price: totalPrice } : {}),
        ...(outstanding != null ? { total_outstanding: outstanding } : {}),
        ...(currency ? { currency } : {}),
        synced_at: new Date(),
      },
    });
  }

  /**
   * Archive (orderClose) or unarchive (orderOpen) orders in Shopify and mirror
   * the state locally (archived_at). Archiving removes an order from Shopify's
   * open Orders list and from CodesApp's working queue, keeping it on record.
   * Best-effort per order; returns how many succeeded + any errors.
   */
  async archiveOrders(
    companyId: number,
    orderGids: string[],
    archive: boolean,
  ): Promise<{ done: number; failed: number; errors: string[] }> {
    const api = await this.requireAdminApi(companyId);
    const gql = archive
      ? `mutation($input: OrderCloseInput!) {
          orderClose(input: $input) { order { id } userErrors { message } }
        }`
      : `mutation($input: OrderOpenInput!) {
          orderOpen(input: $input) { order { id } userErrors { message } }
        }`;
    const key = archive ? 'orderClose' : 'orderOpen';
    let done = 0;
    let failed = 0;
    const errors: string[] = [];
    const okGids: string[] = [];
    for (const gid of orderGids) {
      try {
        const res = await this.shopifyGraphql<{
          data?: Record<string, { order?: { id: string } | null; userErrors?: Array<{ message: string }> }>;
          errors?: Array<{ message: string }>;
        }>(api.shopDomain, api.apiVersion, api.token, gql, { input: { id: gid } });
        const node = res?.data?.[key];
        const ue = node?.userErrors ?? [];
        if (node?.order?.id && !ue.length) {
          done++;
          okGids.push(gid);
        } else {
          failed++;
          const msg = ue.map((e) => e.message).join('; ') || res?.errors?.map((e) => e.message).join('; ');
          if (msg && errors.length < 5) errors.push(msg);
        }
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    // Mirror the state for the ones that succeeded (targeted, tenant-scoped).
    if (okGids.length) {
      await this.prisma.shopifyOrder
        .updateMany({
          where: { company_id: companyId, shopify_order_gid: { in: okGids } },
          data: { archived_at: archive ? new Date() : null, synced_at: new Date() },
        })
        .catch(() => null);
    }
    return { done, failed, errors };
  }

  /**
   * Mark a COD order PAID in Shopify — the courier collected the cash and has
   * now remitted it, so `orderMarkAsPaid` records the payment against the order's
   * outstanding balance (Shopify creates the transaction itself).
   *
   * ONLY call this once the money is genuinely confirmed received (i.e. from an
   * applied courier settlement statement). It is a real financial write; there is
   * no per-call notification flag, so customer emails are governed by the store's
   * own notification settings.
   *
   * Best-effort + non-throwing: an already-paid order simply reports a userError,
   * which the caller treats as "nothing to do". Mirrors the local row on success.
   */
  async markOrderPaid(
    companyId: number,
    orderGid: string,
  ): Promise<{ ok: boolean; alreadyPaid: boolean; error?: string }> {
    const api = await this.requireAdminApi(companyId);
    try {
      const res = await this.shopifyGraphql<{
        data?: {
          orderMarkAsPaid?: {
            order?: { id: string; displayFinancialStatus?: string | null } | null;
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      }>(
        api.shopDomain,
        api.apiVersion,
        api.token,
        `mutation($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order { id displayFinancialStatus }
            userErrors { field message }
          }
        }`,
        { input: { id: orderGid } },
      );
      const node = res?.data?.orderMarkAsPaid;
      const ue = node?.userErrors ?? [];
      if (node?.order?.id && !ue.length) {
        await this.prisma.shopifyOrder
          .updateMany({
            where: { company_id: companyId, shopify_order_gid: orderGid },
            data: {
              financial_status: node.order.displayFinancialStatus ?? 'PAID',
              total_outstanding: 0,
              synced_at: new Date(),
            },
          })
          .catch(() => null);
        return { ok: true, alreadyPaid: false };
      }
      const msg =
        ue.map((e) => e.message).join('; ') ||
        res?.errors?.map((e) => e.message).join('; ') ||
        'orderMarkAsPaid returned no order';
      // Shopify rejects a second mark-as-paid — treat that as success, not failure.
      const already = /already|no.*outstanding|cannot be marked/i.test(msg);
      if (already) {
        await this.prisma.shopifyOrder
          .updateMany({
            where: { company_id: companyId, shopify_order_gid: orderGid },
            data: { financial_status: 'PAID', total_outstanding: 0, synced_at: new Date() },
          })
          .catch(() => null);
      } else {
        this.logger.warn(`orderMarkAsPaid failed for ${orderGid} (company ${companyId}): ${msg}`);
      }
      return { ok: already, alreadyPaid: already, error: already ? undefined : msg };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`orderMarkAsPaid threw for ${orderGid} (company ${companyId}): ${msg}`);
      return { ok: false, alreadyPaid: false, error: msg };
    }
  }

  /**
   * Backfill `shopify_orders.gateway_payment_ref` — the payment gateway's own
   * per-transaction reference (PayFast `paymentId`), read from each order's SALE
   * transaction. That ref equals a gateway settlement file's `Order_Id`, so it's
   * the exact key used to reconcile a PayFast payout file back to orders. Pages
   * orders (newest first) within the given created-at window and writes the ref
   * where it's still null. Best-effort — never throws; returns {scanned,updated}.
   */
  async backfillGatewayPaymentRefs(
    companyId: number,
    opts: { sinceISO?: string; untilISO?: string; maxPages?: number } = {},
  ): Promise<{ scanned: number; updated: number }> {
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { scanned: 0, updated: 0 };
    }
    const filter = [
      opts.sinceISO ? `created_at:>=${opts.sinceISO}` : '',
      opts.untilISO ? `created_at:<=${opts.untilISO}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    const q = `query($cur:String){ orders(first:200, after:$cur, sortKey:CREATED_AT, reverse:true, query:${JSON.stringify(
      filter,
    )}){ pageInfo{ hasNextPage endCursor } edges{ node{ id transactions(first:6){ kind paymentId } } } } }`;
    type Res = {
      data?: {
        orders?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          edges?: Array<{
            node?: {
              id?: string;
              transactions?: Array<{ kind?: string; paymentId?: string | null }>;
            };
          }>;
        };
      };
    };
    let cur: string | null = null;
    let pages = 0;
    let scanned = 0;
    let updated = 0;
    const maxPages = opts.maxPages ?? 60;
    while (pages < maxPages) {
      let res: Res;
      try {
        res = await this.shopifyGraphql<Res>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          q,
          { cur },
        );
      } catch {
        break;
      }
      const d = res?.data?.orders;
      if (!d) break;
      for (const e of d.edges ?? []) {
        scanned++;
        const node = e.node;
        if (!node?.id) continue;
        const txs = node.transactions ?? [];
        const ref =
          txs.find(
            (t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.paymentId,
          )?.paymentId ?? txs.find((t) => t.paymentId)?.paymentId;
        if (!ref) continue;
        const r = await this.prisma.shopifyOrder
          .updateMany({
            where: {
              company_id: companyId,
              shopify_order_gid: node.id,
              gateway_payment_ref: null,
            },
            data: { gateway_payment_ref: ref },
          })
          .catch(() => ({ count: 0 }));
        updated += r.count;
      }
      pages++;
      if (!d.pageInfo?.hasNextPage) break;
      cur = d.pageInfo.endCursor ?? null;
    }
    return { scanned, updated };
  }

  /**
   * RTO (return-to-origin) side effects on Shopify for a returned parcel:
   * cancel the order (restock, no refund, no customer notice) then archive it,
   * and mark the local mirror cancelled + archived so it leaves the working
   * queue. Each Shopify call is best-effort/non-throwing — an already-cancelled
   * or already-closed order must not abort the caller (the blacklist + local
   * state still apply). Refunds are deliberately NOT issued automatically
   * (money movement stays a human decision, esp. for prepaid orders).
   */
  async processOrderReturn(
    companyId: number,
    orderGid: string,
  ): Promise<{ cancelled: boolean; archived: boolean }> {
    const api = await this.requireAdminApi(companyId);
    let cancelled = false;
    try {
      const gql = `mutation($orderId: ID!, $notifyCustomer: Boolean, $refund: Boolean!, $restock: Boolean!, $reason: OrderCancelReason!, $staffNote: String) {
        orderCancel(orderId: $orderId, notifyCustomer: $notifyCustomer, refund: $refund, restock: $restock, reason: $reason, staffNote: $staffNote) {
          job { id }
          orderCancelUserErrors { message }
        }
      }`;
      const res = await this.shopifyGraphql<{
        data?: { orderCancel?: { job?: { id: string } | null; orderCancelUserErrors?: Array<{ message: string }> } };
        errors?: Array<{ message: string }>;
      }>(api.shopDomain, api.apiVersion, api.token, gql, {
        orderId: orderGid,
        notifyCustomer: false,
        refund: false,
        restock: true,
        reason: 'CUSTOMER',
        staffNote: 'RTO — parcel returned (auto via CodesApp)',
      });
      const ue = res?.data?.orderCancel?.orderCancelUserErrors ?? [];
      if (!res?.errors?.length && !ue.length) {
        cancelled = true;
      } else {
        this.logger.warn(
          `orderCancel for ${orderGid} (company ${companyId}) reported: ${JSON.stringify(
            res?.errors ?? ue,
          )} (may already be cancelled)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `orderCancel failed for ${orderGid} (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Close/archive in Shopify (best-effort — a cancelled order is often
    // auto-closed already; the local archived_at below is what hides it here).
    const arch = await this.archiveOrders(companyId, [orderGid], true).catch(
      () => ({ done: 0, failed: 1, errors: [] as string[] }),
    );

    // Local mirror: cancelled + archived regardless of the Shopify close result,
    // so the order leaves the working queue immediately.
    await this.prisma.shopifyOrder
      .updateMany({
        where: { company_id: companyId, shopify_order_gid: orderGid },
        data: {
          cancelled_at: new Date(),
          archived_at: new Date(),
          synced_at: new Date(),
        },
      })
      .catch(() => null);

    return { cancelled, archived: arch.done > 0 };
  }

  /**
   * Batch-read each order's fulfillment tracking (company + number) and Shopify
   * `displayStatus`, keyed by order GID. Used by the courier status-sync to
   * (a) backfill tracking numbers our shipments are missing and (b) fall back to
   * Shopify's own delivery status for couriers with no pull API. Best-effort.
   */
  async getFulfillmentTracking(
    companyId: number,
    orderGids: string[],
  ): Promise<
    Map<
      string,
      {
        company: string | null;
        number: string | null;
        displayStatus: string | null;
        fulfillmentGid: string | null;
      }
    >
  > {
    const out = new Map<
      string,
      {
        company: string | null;
        number: string | null;
        displayStatus: string | null;
        fulfillmentGid: string | null;
      }
    >();
    if (!orderGids.length) return out;
    const api = await this.requireAdminApi(companyId);
    const q = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order { id fulfillments(first:5){ id displayStatus status trackingInfo{ company number } } } } }`;
    for (let i = 0; i < orderGids.length; i += 50) {
      const batch = orderGids.slice(i, i + 50);
      try {
        const res = await this.shopifyGraphql<{
          data?: {
            nodes?: Array<{
              id?: string;
              fulfillments?: Array<{
                id?: string | null;
                displayStatus?: string | null;
                status?: string | null;
                trackingInfo?: Array<{ company?: string | null; number?: string | null }>;
              }>;
            } | null>;
          };
        }>(api.shopDomain, api.apiVersion, api.token, q, { ids: batch });
        for (const n of res?.data?.nodes ?? []) {
          if (!n?.id) continue;
          const fs = n.fulfillments ?? [];
          const f = fs.find((x) => x.status === 'SUCCESS') ?? fs[0];
          const trk = (f?.trackingInfo ?? [])[0] ?? {};
          out.set(n.id, {
            company: trk.company ?? null,
            number: trk.number ?? null,
            displayStatus: f?.displayStatus ?? null,
            fulfillmentGid: f?.id ?? null,
          });
        }
      } catch (e) {
        this.logger.warn(
          `getFulfillmentTracking batch failed (company ${companyId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return out;
  }

  /**
   * Manually create a Shopify order from the chat (agent-driven). Uses the
   * company's stored Admin API token + the configured store domain/version.
   * Implemented as draftOrderCreate → draftOrderComplete so it yields a real
   * Order: COD → `paymentPending: true` (unpaid); prepaid → `false` (marked
   * paid). Line items are Shopify variants (price comes from the store); a
   * custom title+price line is the fallback when no variantId is given.
   * Throws clean 4xx/5xx for the UI; never silently swallows.
   */
  async createOrder(
    companyId: number,
    dto: {
      lineItems: Array<{
        variantId?: string;
        title?: string;
        quantity: number;
        price?: number;
        discount?: { type: 'percentage' | 'fixed'; value: number };
      }>;
      customerName?: string;
      phone?: string;
      email?: string;
      address1?: string;
      city?: string;
      countryCode?: string;
      note?: string;
      tags?: string[];
      prepaid?: boolean;
      shippingLine?: { title: string; price: number };
      orderDiscount?: { type: 'percentage' | 'fixed'; value: number };
      customerId?: string;
      // Optional conversation context (additive). The AI path passes it so a
      // prevented-duplicate event is attributable; the manual modal omits it.
      conversationId?: number;
      // 'abandoned_cart' when created from the Abandoned Checkouts button.
      source?: 'abandoned_cart' | 'inbox';
    },
    // Agent who created this order via the modal. Recorded on the idempotency
    // row so the orders/create webhook can stamp the confirmation message's
    // user_id → correct "orders per agent" analytics. Undefined for AI-auto
    // and storefront orders (no human creator).
    createdByUserId?: number,
  ): Promise<{ orderId: string; orderName: string; adminUrl: string }> {
    const api = await this.requireAdminApi(companyId);
    const { shopDomain } = api;

    // ── Order Idempotency Protection (#2) ───────────────────────────────
    // Deterministic, cross-path guard against duplicate orders from queue
    // retries, worker crashes, duplicated webhooks, and ambiguous Shopify
    // timeouts. Reserve the fingerprint BEFORE any Shopify mutation; a duplicate
    // hit returns the SAME order instead of creating a second. A null hash means
    // the order is too sparse to fingerprint safely → dedup is skipped (the
    // create proceeds exactly as before — fully backward compatible).
    const idemHash = OrderIdempotencyService.computeHash({
      phone: dto.phone,
      address1: dto.address1,
      city: dto.city,
      countryCode: dto.countryCode,
      lineItems: dto.lineItems,
      prepaid: dto.prepaid,
    });
    let reservationId = -1;
    if (idemHash) {
      const reservation = await this.orderIdempotency.reserve(
        companyId,
        dto.conversationId ?? null,
        idemHash,
        createdByUserId ?? null,
      );
      if (reservation.kind === 'duplicate') {
        this.logger.warn(
          `Shopify order create de-duplicated (company ${companyId}) → returning ${reservation.order.orderName}`,
        );
        return reservation.order;
      }
      reservationId = reservation.reservationId;
    }

    try {
    const base = this.buildDraftBase(dto);
    const input: Record<string, unknown> = { lineItems: base.lineItems };
    // Use the same address for shipping AND billing so Shopify has a complete
    // customer record (the customer/address auto-created below comes from it).
    if (base.shippingAddress) {
      input.shippingAddress = base.shippingAddress;
      input.billingAddress = base.shippingAddress;
    }
    // Link the order to a Shopify customer. Prefer an explicitly chosen
    // customerId (from the lookup UI, currently deferred); otherwise
    // find-or-create one from the order's name/phone/email/address so the
    // order is always tied to a real customer. Best-effort — never blocks.
    let customerId = dto.customerId;
    if (!customerId) {
      customerId =
        (await this.findOrCreateCustomer(companyId, dto)) ?? undefined;
    }
    if (customerId) input.purchasingEntity = { customerId };
    else
      this.logger.warn(
        `createOrder: proceeding WITHOUT a linked Shopify customer (company ${companyId}, source=${dto.source ?? 'inbox'}, phone=${dto.phone ?? '-'}, email=${dto.email ?? '-'})`,
      );
    if (dto.email) input.email = dto.email;
    if (dto.note) input.note = dto.note;
    const tags = (dto.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (tags.length) input.tags = tags;
    // Order-level manual discount (per-line discounts are on the line items).
    const orderDisc = this.mapDiscount(dto.orderDiscount);
    if (orderDisc) input.appliedDiscount = orderDisc;
    // Selected shipping rate → a shipping line (title + price). Sent as a
    // custom line carrying exactly what the agent picked from Shopify's
    // calculated rates (reliable across versions vs. a stale rate handle).
    if (dto.shippingLine && dto.shippingLine.title) {
      input.shippingLine = {
        title: dto.shippingLine.title,
        price: Number(dto.shippingLine.price ?? 0).toFixed(2),
      };
    }

    const errMsg = (
      ue?: Array<{ message: string }> | undefined,
      gql?: Array<{ message: string }> | undefined,
    ) =>
      (ue && ue.length ? ue : gql ?? [])
        .map((e) => e.message)
        .filter(Boolean)
        .join('; ') || 'unknown error';

    // 1) Create the draft.
    let createRes: {
      data?: {
        draftOrderCreate?: {
          draftOrder?: { id: string } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      createRes = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        `mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id }
            userErrors { field message }
          }
        }`,
        { input },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify draftOrderCreate failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach Shopify to create the order. Check the Admin token and store domain.',
      );
    }
    const draftId = createRes?.data?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) {
      throw new BadRequestException(
        `Shopify rejected the order: ${errMsg(
          createRes?.data?.draftOrderCreate?.userErrors,
          createRes?.errors,
        )}`,
      );
    }
    // Shopify can return field-level userErrors (e.g. a rejected discount)
    // even when the draft IS created — surface them in logs so a silently
    // dropped order/line discount is diagnosable instead of invisible.
    const createUe = createRes?.data?.draftOrderCreate?.userErrors ?? [];
    if (createUe.length) {
      this.logger.warn(
        `draftOrderCreate userErrors (company ${companyId}, draft created anyway): ${createUe
          .map((e) => e.message)
          .join('; ')}`,
      );
    }

    // 2) Complete it (payment pending → real unpaid order).
    let completeRes: {
      data?: {
        draftOrderComplete?: {
          draftOrder?: {
            order?: {
              id: string;
              name: string;
              totalPriceSet?: {
                shopMoney?: { amount?: string; currencyCode?: string };
              } | null;
            } | null;
          } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    try {
      completeRes = await this.shopifyGraphql(
        api.shopDomain,
        api.apiVersion,
        api.token,
        // COD → paymentPending true (unpaid); prepaid → false (marked paid).
        // totalPriceSet is captured so analytics can report per-agent order value.
        `mutation($id: ID!, $paymentPending: Boolean) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder { order { id name customer { id } totalPriceSet { shopMoney { amount currencyCode } } } }
            userErrors { field message }
          }
        }`,
        { id: draftId, paymentPending: !dto.prepaid },
      );
    } catch (err) {
      this.logger.warn(
        `Shopify draftOrderComplete failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'The order draft was created but Shopify could not complete it.',
      );
    }
    const order =
      completeRes?.data?.draftOrderComplete?.draftOrder?.order ?? null;
    if (!order?.id) {
      throw new BadRequestException(
        `Order draft created but completion failed: ${errMsg(
          completeRes?.data?.draftOrderComplete?.userErrors,
          completeRes?.errors,
        )}`,
      );
    }

    const numericId = order.id.split('/').pop();
    // Log whether the customer actually stuck. `customerId` set but
    // `order.customer` null means purchasingEntity did NOT link (a different
    // problem from failing to find/create the customer in the first place).
    const linkedCustomer =
      (order as { customer?: { id?: string } | null }).customer?.id ?? null;
    this.logger.log(
      `Shopify order ${order.name} created from chat (company ${companyId}, source=${
        dto.source ?? 'inbox'
      }, customerSent=${customerId ?? 'none'}, customerOnOrder=${
        linkedCustomer ?? 'NONE'
      })`,
    );
    const ref = {
      orderId: order.id,
      orderName: order.name,
      adminUrl: `https://${shopDomain}/admin/orders/${numericId}`,
    };
    // Commit the idempotency reservation only now that a REAL order exists.
    // Pass the order total so per-agent order-value analytics can sum it.
    await this.orderIdempotency.finalize(
      reservationId,
      ref,
      {
        total: order.totalPriceSet?.shopMoney?.amount ?? null,
        currency: order.totalPriceSet?.shopMoney?.currencyCode ?? null,
      },
      dto.source === 'abandoned_cart' ? 'abandoned_cart' : 'inbox',
    );
    // Seed the orders mirror immediately (source='codesapp') so this order is in
    // the fulfilment queue at once; the orders/create webhook echo will UPDATE
    // the same row (canonical GID) rather than create a second — no doubling.
    void this.orderSync
      .upsertOrder(
        companyId,
        {
          orderGid: order.id,
          orderName: order.name,
          orderNumber: numericId ?? null,
          customerName: dto.customerName ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          city: dto.city ?? null,
          address1: dto.address1 ?? null,
          countryCode: dto.countryCode ?? null,
          totalPrice: order.totalPriceSet?.shopMoney?.amount
            ? Number(order.totalPriceSet.shopMoney.amount)
            : null,
          totalOutstanding: dto.prepaid
            ? 0
            : order.totalPriceSet?.shopMoney?.amount
              ? Number(order.totalPriceSet.shopMoney.amount)
              : null,
          currency: order.totalPriceSet?.shopMoney?.currencyCode ?? null,
          fulfillmentStatus: 'unfulfilled',
          shopifyCreatedAt: new Date(),
        },
        'codesapp',
      )
      .catch(() => undefined);
    return ref;
    } catch (e) {
      // Any failure between reservation and a confirmed order → release the
      // slot (marked 'failed' with a short TTL so an immediate retry can't
      // double-create, but a genuine later retry can proceed). Then rethrow the
      // original error so the caller's contract is unchanged.
      await this.orderIdempotency.release(reservationId);
      throw e;
    }
  }

  private shopifyGraphql<T>(
    shopDomain: string,
    apiVersion: string,
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const body = JSON.stringify({ query, variables });
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: shopDomain,
          method: 'POST',
          path: `/admin/api/${apiVersion}/graphql.json`,
          headers: {
            'x-shopify-access-token': token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: SHOPIFY_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw) as T);
              } catch {
                reject(new Error('Shopify API parse error'));
              }
            } else {
              reject(
                new Error(
                  `Shopify API ${res.statusCode}: ${raw.slice(0, 300)}`,
                ),
              );
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Shopify API timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  getOAuthUrl(companyId: number): { url: string } {
    const clientId = this.config.get('SHOPIFY_CLIENT_ID');
    const appUrl = this.config.get('APP_URL');
    const state = Buffer.from(JSON.stringify({ companyId })).toString('base64');
    const redirectUri = `${appUrl}/integrations/shopify/callback`;
    const scopes = 'read_orders,read_customers';

    // Shop domain must be provided by client — this returns the template URL
    const url = `https://{shop}.myshopify.com/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return { url };
  }

  async handleCallback(shop: string, code: string, state: string) {
    let companyId: number;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      companyId = decoded.companyId;
    } catch {
      throw new UnauthorizedException('Invalid OAuth state');
    }

    // Exchange code for access token
    const clientId = this.config.get('SHOPIFY_CLIENT_ID');
    const clientSecret = this.config.get('SHOPIFY_CLIENT_SECRET');
    const appUrl = this.config.get('APP_URL');

    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!res.ok) throw new UnauthorizedException('Shopify token exchange failed');

    const { access_token } = (await res.json()) as { access_token: string };
    const webhookSecret = this.config.get('SHOPIFY_WEBHOOK_SECRET') ?? '';

    const encryptedToken = this.encryption.encrypt(access_token);
    const encryptedSecret = this.encryption.encrypt(webhookSecret);

    await this.prisma.shopifyIntegration.upsert({
      where: { company_id: companyId },
      create: {
        company_id: companyId,
        shop_domain: shop,
        access_token_encrypted: encryptedToken,
        webhook_secret_encrypted: encryptedSecret,
        active_events: [
          'orders/create',
          'orders/fulfilled',
          'orders/cancelled',
          'fulfillments/update',
          'checkouts/create',
          'checkouts/update',
        ],
        status: 'active',
      },
      update: {
        shop_domain: shop,
        access_token_encrypted: encryptedToken,
        webhook_secret_encrypted: encryptedSecret,
        status: 'active',
      },
    });

    return { message: 'Shopify connected', shop };
  }

  async handleWebhook(
    topic: string,
    hmac: string,
    rawBody: Buffer,
  ): Promise<void> {
    const secret = this.config.get('SHOPIFY_WEBHOOK_SECRET');
    if (!secret) return;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid Shopify HMAC');
    }

    this.logger.log(`Shopify webhook received: ${topic}`);

    // TODO (Phase 2): Wire up order event handlers when templates module exists
    // Handlers needed: orders/create, orders/fulfilled, orders/cancelled, orders/paid
  }

  async getIntegration(companyId: number) {
    const integration = await this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
    if (!integration) throw new NotFoundException('No Shopify integration found');
    return integration;
  }

  /** Settings UI variant — returns null instead of throwing when unlinked. */
  async getIntegrationOrNull(companyId: number) {
    return this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
  }

  async updateEvents(companyId: number, events: string[]) {
    const allowed = [
      'orders/create',
      'orders/paid',
      'orders/fulfilled',
      'orders/cancelled',
      'fulfillments/update',
      'checkouts/create',
      'checkouts/update',
    ];
    const clean = Array.from(
      new Set(events.filter((e) => allowed.includes(e))),
    );
    const integration = await this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException('No Shopify integration found');
    return this.prisma.shopifyIntegration.update({
      where: { company_id: companyId },
      data: { active_events: clean },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
  }

  async disconnect(companyId: number) {
    await this.prisma.shopifyIntegration.delete({
      where: { company_id: companyId },
    });
    return { message: 'Shopify disconnected' };
  }

  /**
   * Per-tenant Shopify webhook key (mirrors Meta Option B `webhook_key`).
   * Immutable, company-name-seeded, generated once — the client pastes
   * `/webhooks/shopify/{key}` into their own Shopify app's webhook config.
   */
  private async ensureShopifyWebhookKey(companyId: number): Promise<string> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, shopify_webhook_key: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.shopify_webhook_key) return company.shopify_webhook_key;

    const slug =
      company.company_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'company';
    let key = `${slug}-sh-${crypto.randomBytes(6).toString('hex')}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = `${slug}-sh-${crypto
        .randomBytes(attempt === 0 ? 3 : 5)
        .toString('hex')}`;
      const clash = await this.prisma.company.findFirst({
        where: { shopify_webhook_key: candidate },
        select: { id: true },
      });
      if (!clash) {
        key = candidate;
        break;
      }
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { shopify_webhook_key: key },
    });
    return key;
  }

  /** The per-tenant Shopify webhook callback URL (origin + `/webhooks/shopify/{key}`). */
  private async tenantWebhookUrl(companyId: number): Promise<string> {
    const key = await this.ensureShopifyWebhookKey(companyId);
    const origin = (this.config.get<string>('APP_URL') ?? 'https://apps.codentra.pk').replace(
      /\/+$/,
      '',
    );
    return `${origin}/webhooks/shopify/${key}`;
  }

  /**
   * Auto-register the abandoned-cart webhook topics (checkouts/create + update)
   * on the tenant's Shopify store via the Admin API, pointing at THEIR per-tenant
   * URL — so carts flow in without the client editing Shopify by hand. Idempotent:
   * an "already taken" (same topic+URL) is treated as success. Owner/admin only.
   *
   * NOTE: Admin-API-created webhooks are HMAC-signed with the custom app's API
   * SECRET KEY, so the tenant's stored Shopify webhook secret must equal that for
   * inbound verification to pass — surfaced to the UI as `secretHint`.
   */
  async registerCheckoutWebhooks(companyId: number): Promise<{
    url: string;
    results: Array<{ topic: string; ok: boolean; message: string }>;
    secretHint: string;
  }> {
    const api = await this.requireAdminApi(companyId);
    const url = await this.tenantWebhookUrl(companyId);
    const topics = ['CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE'];
    const mutation = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`;
    type Res = {
      data?: {
        webhookSubscriptionCreate?: {
          webhookSubscription?: { id?: string } | null;
          userErrors?: Array<{ message?: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    const results: Array<{ topic: string; ok: boolean; message: string }> = [];
    for (const topic of topics) {
      try {
        const res = await this.shopifyGraphql<Res>(
          api.shopDomain,
          api.apiVersion,
          api.token,
          mutation,
          { topic, sub: { callbackUrl: url, format: 'JSON' } },
        );
        const errs = res?.data?.webhookSubscriptionCreate?.userErrors ?? [];
        const created = res?.data?.webhookSubscriptionCreate?.webhookSubscription?.id;
        const taken = errs.some((e) =>
          /already been taken|already exists/i.test(e.message ?? ''),
        );
        if (created || taken) {
          results.push({ topic, ok: true, message: taken ? 'already registered' : 'registered' });
        } else {
          results.push({
            topic,
            ok: false,
            message:
              errs.map((e) => e.message).filter(Boolean).join('; ') ||
              res?.errors?.map((e) => e.message).join('; ') ||
              'failed',
          });
        }
      } catch (e) {
        results.push({
          topic,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return {
      url,
      results,
      secretHint:
        'Set your Shopify webhook signing secret (Settings → Shopify) to your custom app’s API secret key so incoming webhooks verify.',
    };
  }

  /**
   * Which of the two checkout topics are currently subscribed to OUR URL.
   * Best-effort (empty on any Admin-API failure) so the settings page never
   * breaks on this read.
   */
  async checkoutWebhookStatus(companyId: number): Promise<{
    url: string;
    create: boolean;
    update: boolean;
  }> {
    const url = await this.tenantWebhookUrl(companyId).catch(() => '');
    const out = { url, create: false, update: false };
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return out;
    }
    const query = `query {
      webhookSubscriptions(first: 100) {
        edges { node { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
      }
    }`;
    type Res = {
      data?: {
        webhookSubscriptions?: {
          edges: Array<{
            node: {
              topic?: string;
              endpoint?: { callbackUrl?: string | null } | null;
            };
          }>;
        };
      };
    };
    try {
      const res = await this.shopifyGraphql<Res>(
        api.shopDomain,
        api.apiVersion,
        api.token,
        query,
        {},
      );
      for (const edge of res?.data?.webhookSubscriptions?.edges ?? []) {
        const cb = edge.node.endpoint?.callbackUrl ?? '';
        if (url && cb !== url) continue;
        if (edge.node.topic === 'CHECKOUTS_CREATE') out.create = true;
        if (edge.node.topic === 'CHECKOUTS_UPDATE') out.update = true;
      }
    } catch {
      /* best-effort */
    }
    return out;
  }

  /**
   * Per-tenant Shopify webhook receiver (Phase 2). Resolves the company by
   * the URL key, verifies the HMAC with THAT company's stored signing
   * secret, and parses `orders/create`. Phase 2 only validates + parses +
   * logs; the template send + order tagging come in Phase 4.
   */
  async handleTenantOrderWebhook(
    key: string,
    topic: string,
    hmacHeader: string,
    rawBody: Buffer,
    shopDomain: string,
  ): Promise<{ received: true; ignored?: string }> {
    const company = await this.prisma.company.findFirst({
      where: { shopify_webhook_key: key },
      select: { id: true, shopify_webhook_secret_encrypted: true },
    });
    if (!company) {
      throw new UnauthorizedException('Unknown Shopify webhook key');
    }
    if (!company.shopify_webhook_secret_encrypted) {
      throw new UnauthorizedException(
        'Shopify webhook secret not configured for this company',
      );
    }

    let secret: string;
    try {
      secret = this.encryption.decrypt(
        company.shopify_webhook_secret_encrypted,
      );
    } catch {
      throw new UnauthorizedException('Cannot decrypt Shopify webhook secret');
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    const a = Buffer.from(hmacHeader || '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Shopify HMAC');
    }

    // Abandoned-cart recovery — a started-but-not-completed checkout. Records
    // it + schedules a delayed recovery template (gated; dark unless enabled).
    if (topic === 'checkouts/create' || topic === 'checkouts/update') {
      return this.handleAbandonedCheckout(company.id, rawBody);
    }

    // Cancellation accounting + orders-mirror sync FIRST — must run regardless
    // of whether delivery notifications are enabled (routeDeliveryNotification
    // returns early when they're off, which would otherwise skip these).
    if (topic.startsWith('orders/')) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8')) as ShopifyOrderPayload;
        await this.applyOrderCancellationState(company.id, parsed);
        // Keep the local orders mirror current. Upsert on the canonical GID —
        // an order created in CodesApp is UPDATED here, never duplicated.
        await this.orderSync.upsertFromWebhook(
          company.id,
          parsed as unknown as Record<string, unknown>,
        );
        // A cancelled order must drop its parcel out of the Courier payments +
        // Shipments tabs (it's no longer collectable). Any-source: this fires
        // whenever Shopify sends an orders/* webhook carrying cancelled_at.
        const oGid =
          parsed.admin_graphql_api_id ??
          (parsed.id != null ? `gid://shopify/Order/${parsed.id}` : '');
        if (oGid && parsed.cancelled_at) {
          await this.orderSync.cancelShipmentForOrder(company.id, oGid, 'cancelled');
        }
      } catch {
        /* unparseable body — the topic handlers below report it */
      }
    } else if (topic.startsWith('fulfillments/')) {
      // A fulfilment was created/updated in Shopify. This topic is NOT orders/*
      // (so upsertFromWebhook never runs) but it's the ONLY signal many stores
      // emit on fulfilment — orders/updated/orders/fulfilled are often not
      // subscribed. Re-pull the order's authoritative fulfilment status so the
      // mirror row flips to 'fulfilled' and leaves the fulfilment queue.
      try {
        const f = JSON.parse(rawBody.toString('utf8')) as {
          order_id?: number | string | null;
          admin_graphql_api_id?: string | null;
          status?: string | null;
        };
        const gid =
          f.order_id != null ? `gid://shopify/Order/${f.order_id}` : '';
        if (gid) {
          await this.orderSync.refreshFulfillmentStatus(company.id, gid);
          // A cancelled fulfilment means the parcel was pulled back from the
          // courier — drop it out of Courier payments. Otherwise capture the
          // courier + delivery lifecycle (creates the shipment on first sight).
          if (String(f.status ?? '').toLowerCase() === 'cancelled') {
            await this.orderSync.cancelShipmentForOrder(
              company.id,
              gid,
              'fulfillment cancelled',
            );
          } else {
            await this.orderSync.applyFulfillmentEvent(
              company.id,
              gid,
              f as unknown as Record<string, unknown>,
            );
          }
        }
      } catch {
        /* unparseable body — fall through to the delivery-notification router */
      }
    }

    // Delivery notifications — orders/fulfilled (shipped), orders/cancelled,
    // and fulfillments/update (out_for_delivery/delivered/attempted/failed via
    // shipment_status). Gated by the feature framework (plan + tenant); each
    // event is dark until its template is configured, so the worker no-ops.
    {
      const deliveryResult = await this.routeDeliveryNotification(
        company.id,
        topic,
        rawBody,
      );
      if (deliveryResult) return deliveryResult;
    }

    // Only orders/create drives the confirmation flow.
    if (topic !== 'orders/create') {
      this.logger.log(
        `Shopify webhook for company ${company.id} ignored (topic=${topic})`,
      );
      return { received: true, ignored: topic };
    }

    let order: ShopifyOrderPayload;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn(
        `Shopify orders/create for company ${company.id}: unparseable body`,
      );
      return { received: true, ignored: 'bad-json' };
    }

    // Convert any matching abandoned checkout so its recovery never fires.
    await this.markCheckoutConverted(company.id, order);

    // Shopify can fire a checkouts/create|update a few minutes AFTER this order
    // (the shopper revisits the site / bounces off the thank-you page), creating
    // a "pending" cart the immediate match above can't see — the cart doesn't
    // exist yet. Schedule delayed re-matches (20 min catches the common case,
    // 90 min the stragglers) that re-run the order→cart match. Works even for a
    // pure self-checkout with no earlier cart, since the match keys off the
    // ORDER's phone/email/name. Deduped per order+delay so redeliveries no-op.
    {
      const gid =
        order.admin_graphql_api_id ??
        (order.id != null ? `gid://shopify/Order/${order.id}` : '');
      if (gid) {
        for (const min of [20, 90]) {
          await this.jobQueue.enqueue(
            'shopify',
            { kind: 'reconcileOrderCarts', companyId: company.id, order },
            {
              delayMs: min * 60_000,
              dedupKey: `shopify-cartreconcile:${company.id}:${gid}:${min}`,
            },
          );
        }
      }
    }

    // Ack fast (Shopify needs 200 within 5s) — do the send on the worker.
    // Idempotency: Shopify delivers orders/create at-least-once. dedupKey makes a
    // redelivered webhook a no-op enqueue, and serialKey single-flights the same
    // order so two near-simultaneous deliveries can't both pass the in-handler
    // duplicate check and send two confirmations (Finding #24).
    const orderGid =
      order.admin_graphql_api_id ??
      (order.id != null ? `gid://shopify/Order/${order.id}` : '');
    const orderKey = orderGid
      ? `shopify-order:${company.id}:${orderGid}`
      : undefined;
    await this.jobQueue.enqueue(
      'shopify',
      {
        kind: 'send',
        companyId: company.id,
        shopDomain: shopDomain || '',
        order,
      },
      orderKey ? { serialKey: orderKey, dedupKey: orderKey } : undefined,
    );
    this.logger.log(
      `Shopify orders/create company=${company.id} order=${
        order.name ?? order.id
      } enqueued for confirmation send`,
    );
    return { received: true };
  }

  /**
   * The tenant's MANUAL abandoned-cart message template (the per-row "Send
   * message" button). Stored in the raw `abandoned_manual_template` JSON column,
   * deliberately separate from the automated recovery sequence so a tenant can
   * message carts by hand without enabling any automation. Never throws.
   */
  private async loadManualTemplate(
    companyId: number,
  ): Promise<{ templateId: number | null; variableMap: Record<string, string> }> {
    const empty = { templateId: null, variableMap: {} };
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ t: unknown }[]>(
        `SELECT abandoned_manual_template t FROM shopify_order_configs WHERE company_id = ? LIMIT 1`,
        companyId,
      );
      const raw = rows[0]?.t;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object') return empty;
      const obj = parsed as Record<string, unknown>;
      const id = Number(obj.templateId);
      return {
        templateId: Number.isFinite(id) && id > 0 ? id : null,
        variableMap:
          (obj.variableMap as Record<string, string>) ?? ({} as Record<string, string>),
      };
    } catch {
      return empty;
    }
  }

  async getOrderConfig(companyId: number) {
    const [row, company, webhookKey, stepsRaw] = await Promise.all([
      this.prisma.shopifyOrderConfig.findUnique({
        where: { company_id: companyId },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          shopify_webhook_secret_encrypted: true,
          shopify_admin_token_encrypted: true,
          proactive_notifications_enabled: true,
          subscription: { select: { proactive_notifications: true } },
        },
      }),
      this.ensureShopifyWebhookKey(companyId),
      this.prisma
        .$queryRawUnsafe<{ steps: unknown }[]>(
          `SELECT abandoned_cart_steps steps FROM shopify_order_configs WHERE company_id = ? LIMIT 1`,
          companyId,
        )
        .catch(() => [] as { steps: unknown }[]),
    ]);
    const manualTemplate = await this.loadManualTemplate(companyId);
    // Parse the raw multi-step column (not in schema.prisma).
    let abandonedCartSteps: AbandonedCartStep[] = [];
    try {
      const raw = stepsRaw?.[0]?.steps;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) abandonedCartSteps = parsed;
    } catch {
      abandonedCartSteps = [];
    }
    const config = row
      ? {
          enabled: row.enabled,
          templateId: row.template_id,
          languageCode: row.language_code,
          variableMap: (row.variable_map as Record<string, string>) ?? {},
          confirmTag: row.confirm_tag,
          cancelTag: row.cancel_tag,
          pendingTag: row.pending_tag ?? 'confirmation pending',
          decisionWindowMinutes: row.decision_window_minutes ?? 2,
          shopDomain: row.shop_domain ?? '',
          apiVersion: row.api_version ?? DEFAULT_SHOPIFY_API_VERSION,
          deliveryNotifications: this.deliveryConfigMap(
            row.delivery_notifications,
          ),
          abandonedCartDelayMinutes: row.abandoned_cart_delay_minutes ?? 180,
          abandonedCartSteps,
          abandonedManualTemplate: manualTemplate,
        }
      : {
          enabled: false,
          templateId: null,
          languageCode: null,
          variableMap: {},
          confirmTag: 'confirmed',
          cancelTag: 'cancelled',
          pendingTag: 'confirmation pending',
          decisionWindowMinutes: 2,
          shopDomain: '',
          apiVersion: DEFAULT_SHOPIFY_API_VERSION,
          deliveryNotifications: this.deliveryConfigMap(null),
          abandonedCartDelayMinutes: 180,
          abandonedCartSteps,
          abandonedManualTemplate: manualTemplate,
        };
    return {
      config,
      fields: SHOPIFY_ORDER_FIELDS,
      apiVersions: SHOPIFY_API_VERSIONS,
      webhookKey,
      webhookSecretSet: !!company?.shopify_webhook_secret_encrypted,
      adminTokenSet: !!company?.shopify_admin_token_encrypted,
      // Delivery notifications: `proactivePlan` = the plan includes the feature
      // (super-admin authority); `proactiveEnabled` = the tenant master toggle;
      // `deliveryEvents` = the catalogue the UI renders.
      proactivePlan: !!company?.subscription?.proactive_notifications,
      proactiveEnabled: !!company?.proactive_notifications_enabled,
      deliveryEvents: DELIVERY_EVENTS,
    };
  }

  /** Ensure the per-company config row exists (so partial section saves
   *  don't need every field). Returns nothing. */
  private async ensureConfigRow(companyId: number): Promise<void> {
    const existing = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
      select: { id: true },
    });
    if (!existing) {
      await this.prisma.shopifyOrderConfig.create({
        data: { company_id: companyId, variable_map: {} },
      });
    }
  }

  /** Block 1 — Credentials: webhook signing secret, Admin API token,
   *  store domain, API version. Secrets blank = keep existing. */
  async updateCredentials(
    companyId: number,
    dto: {
      webhookSecret?: string;
      adminToken?: string;
      shopDomain?: string;
      apiVersion?: string;
    },
  ) {
    await this.ensureConfigRow(companyId);
    const shopDomain = (dto.shopDomain ?? '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    const apiVersion =
      dto.apiVersion && SHOPIFY_API_VERSIONS.includes(dto.apiVersion)
        ? dto.apiVersion
        : DEFAULT_SHOPIFY_API_VERSION;
    await this.prisma.shopifyOrderConfig.update({
      where: { company_id: companyId },
      data: { shop_domain: shopDomain || null, api_version: apiVersion },
    });
    if (dto.webhookSecret && dto.webhookSecret.trim()) {
      await this.setWebhookSecret(companyId, dto.webhookSecret.trim());
    }
    if (dto.adminToken && dto.adminToken.trim()) {
      await this.setAdminToken(companyId, dto.adminToken.trim());
    }
    return this.getOrderConfig(companyId);
  }

  /** Block 2 — Template: which approved template + variable mapping +
   *  enabled flag. */
  /**
   * Block 5 — the MANUAL abandoned-cart message template (the per-row "Send
   * message" button). Its own block/endpoint, exactly like the order
   * -confirmation template: independent of the delivery-notification automation
   * (which keeps owning the timed auto-send under block 4). Null templateId
   * clears it. Stored in the raw `abandoned_manual_template` JSON column.
   */
  async updateAbandonedTemplate(
    companyId: number,
    dto: { templateId?: number | null; variableMap?: Record<string, string> },
  ) {
    const variableMap = dto.variableMap ?? {};
    for (const [slot, src] of Object.entries(variableMap)) {
      if (!SHOPIFY_ORDER_FIELD_KEYS.has(src)) {
        throw new BadRequestException(
          `Variable {{${slot}}} is mapped to an unknown field "${src}"`,
        );
      }
    }
    if (dto.templateId) {
      const tpl = await this.prisma.template.findFirst({
        where: { id: dto.templateId, company_id: companyId, deleted_at: null },
        select: { status: true },
      });
      if (!tpl) throw new NotFoundException('Template not found');
      if (tpl.status !== 'approved') {
        throw new BadRequestException(
          'The selected template is not approved by Meta',
        );
      }
    }
    await this.ensureConfigRow(companyId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE shopify_order_configs SET abandoned_manual_template = ? WHERE company_id = ?`,
      dto.templateId
        ? JSON.stringify({ templateId: Number(dto.templateId), variableMap })
        : null,
      companyId,
    );
    return this.getOrderConfig(companyId);
  }

  async updateTemplate(
    companyId: number,
    dto: {
      enabled: boolean;
      templateId?: number | null;
      variableMap: Record<string, string>;
    },
  ) {
    for (const [slot, src] of Object.entries(dto.variableMap ?? {})) {
      if (!SHOPIFY_ORDER_FIELD_KEYS.has(src)) {
        throw new BadRequestException(
          `Variable {{${slot}}} is mapped to an unknown field "${src}"`,
        );
      }
    }
    let languageCode: string | null = null;
    if (dto.enabled) {
      if (!dto.templateId) {
        throw new BadRequestException(
          'Select an approved template to enable order confirmations',
        );
      }
      const tpl = await this.prisma.template.findFirst({
        where: { id: dto.templateId, company_id: companyId, deleted_at: null },
        select: { status: true, content: true },
      });
      if (!tpl) throw new NotFoundException('Template not found');
      if (tpl.status !== 'approved') {
        throw new BadRequestException(
          'The selected template is not approved by Meta',
        );
      }
      languageCode =
        (tpl.content as { language?: string } | null)?.language ?? 'en_US';
    }
    await this.ensureConfigRow(companyId);
    await this.prisma.shopifyOrderConfig.update({
      where: { company_id: companyId },
      data: {
        enabled: dto.enabled,
        template_id: dto.templateId ?? null,
        language_code: languageCode,
        variable_map: (dto.variableMap ?? {}) as object,
      },
    });
    return this.getOrderConfig(companyId);
  }

  /**
   * Delivery notifications: the tenant master toggle + per-event config
   * (template + variable map + enabled) for each delivery event. Requires the
   * plan to include the feature (super-admin authority); the runtime send is
   * also gated by FeatureService so a plan downgrade silently stops sends.
   */
  async updateProactive(
    companyId: number,
    dto: {
      enabled: boolean;
      notifications: Record<
        string,
        {
          templateId?: number | null;
          variableMap?: Record<string, string>;
          enabled?: boolean;
        }
      >;
      abandonedCartDelayMinutes?: number;
      abandonedCartSteps?: Array<{
        delayMinutes?: number;
        templateId?: number | null;
        variableMap?: Record<string, string>;
      }>;
    },
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscription: { select: { proactive_notifications: true } } },
    });
    if (dto.enabled && !company?.subscription?.proactive_notifications) {
      throw new BadRequestException(
        'Delivery notifications are not included in your plan',
      );
    }

    const assertApproved = async (id: number) => {
      const tpl = await this.prisma.template.findFirst({
        where: { id, company_id: companyId, deleted_at: null },
        select: { status: true },
      });
      if (!tpl) throw new NotFoundException('Template not found');
      if (tpl.status !== 'approved') {
        throw new BadRequestException(
          'A selected template is not approved by Meta',
        );
      }
    };

    // Normalize + validate each event; only known events are persisted.
    const clean: Record<string, DeliveryNotificationCfg> = {};
    let anyEventReady = false;
    for (const key of DELIVERY_EVENT_KEYS) {
      const incoming = dto.notifications?.[key] ?? {};
      const map = incoming.variableMap ?? {};
      for (const [slot, src] of Object.entries(map)) {
        if (!SHOPIFY_ORDER_FIELD_KEYS.has(src)) {
          throw new BadRequestException(
            `Variable {{${slot}}} is mapped to an unknown field "${src}"`,
          );
        }
      }
      const templateId =
        typeof incoming.templateId === 'number' ? incoming.templateId : null;
      const evtEnabled = !!incoming.enabled;
      if (evtEnabled && !templateId) {
        const label =
          DELIVERY_EVENTS.find((e) => e.key === key)?.label ?? key;
        throw new BadRequestException(
          `Select an approved template for "${label}" to enable it`,
        );
      }
      if (templateId) await assertApproved(templateId);
      if (evtEnabled && templateId) anyEventReady = true;
      clean[key] = { templateId, variableMap: map, enabled: evtEnabled };
    }

    if (dto.enabled && !anyEventReady) {
      throw new BadRequestException(
        'Enable at least one event with an approved template to turn on delivery notifications',
      );
    }

    // Multi-step abandoned-cart sequence (raw JSON column). Each step needs an
    // approved template; mapped variables must be known fields. Empty → cleared
    // (falls back to the single legacy template).
    const cleanSteps: AbandonedCartStep[] = [];
    for (const s of dto.abandonedCartSteps ?? []) {
      const templateId = typeof s.templateId === 'number' ? s.templateId : null;
      if (!templateId) continue;
      const map = s.variableMap ?? {};
      for (const [slot, src] of Object.entries(map)) {
        if (!SHOPIFY_ORDER_FIELD_KEYS.has(src)) {
          throw new BadRequestException(
            `Step variable {{${slot}}} is mapped to an unknown field "${src}"`,
          );
        }
      }
      await assertApproved(templateId);
      const delayMinutes =
        typeof s.delayMinutes === 'number' && s.delayMinutes > 0
          ? Math.round(s.delayMinutes)
          : 180;
      cleanSteps.push({ delayMinutes, templateId, variableMap: map });
    }

    await this.ensureConfigRow(companyId);
    await this.prisma.$transaction([
      this.prisma.shopifyOrderConfig.update({
        where: { company_id: companyId },
        data: {
          delivery_notifications: clean as object,
          abandoned_cart_delay_minutes:
            dto.abandonedCartDelayMinutes && dto.abandonedCartDelayMinutes > 0
              ? Math.round(dto.abandonedCartDelayMinutes)
              : null,
        },
      }),
      this.prisma.company.update({
        where: { id: companyId },
        data: { proactive_notifications_enabled: dto.enabled },
      }),
    ]);
    // Raw column (not in schema.prisma) — write after the typed transaction.
    await this.prisma
      .$executeRawUnsafe(
        `UPDATE shopify_order_configs SET abandoned_cart_steps = ? WHERE company_id = ?`,
        cleanSteps.length ? JSON.stringify(cleanSteps) : null,
        companyId,
      )
      .catch((e) =>
        this.logger.warn(
          `abandoned_cart_steps save failed (company ${companyId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    // NOTE: the MANUAL abandoned-cart template is deliberately NOT saved here —
    // it has its own block/endpoint (`updateAbandonedTemplate`). This endpoint
    // owns only the automated delivery notifications + timed recovery sequence.
    return this.getOrderConfig(companyId);
  }

  /**
   * Manually send the configured abandoned-cart template to ONE cart (the
   * per-row "Send message" button). Reuses the proactive template sender, so
   * contact/conversation get-or-create and the 24h-window exemption behave
   * exactly like the automated recovery. Independent of the automation toggle —
   * only a configured template is required.
   */
  async sendAbandonedMessage(
    companyId: number,
    id: number,
  ): Promise<{ sent: boolean }> {
    const { templateId, variableMap } = await this.loadManualTemplate(companyId);
    if (!templateId) {
      throw new BadRequestException(
        'No abandoned-cart message template configured. Set one in Settings → Shopify.',
      );
    }
    const row = await this.prisma.shopifyAbandonedCheckout.findFirst({
      where: { id, company_id: companyId },
    });
    if (!row) throw new NotFoundException('Abandoned checkout not found');
    if (!row.phone) {
      throw new BadRequestException(
        'This cart has no phone number, so it cannot be messaged on WhatsApp.',
      );
    }
    // Shape the cart as an order-ish payload for the shared sender + var mapping.
    // Cart value / line items are raw columns, so read them separately — a
    // recovery message commonly maps {{n}} to the items, total or recovery URL.
    const extra = await this.prisma
      .$queryRawUnsafe<
        Array<{ total_price: unknown; currency: string | null; items_json: unknown }>
      >(
        `SELECT total_price, currency, items_json FROM shopify_abandoned_checkouts
          WHERE id = ? AND company_id = ? LIMIT 1`,
        id,
        companyId,
      )
      .catch(() => []);
    let cartLines: Array<{ quantity?: number; title?: string }> = [];
    try {
      const raw = extra[0]?.items_json;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        cartLines = parsed.map((it: Record<string, unknown>) => ({
          quantity: Number(it.quantity ?? 1) || 1,
          title: String(it.title ?? 'item'),
        }));
      }
    } catch {
      cartLines = [];
    }
    const nameParts = (row.contact_name ?? '').trim().split(/\s+/).filter(Boolean);
    const order: ShopifyOrderPayload = {
      id: row.checkout_token,
      phone: row.phone,
      email: row.email ?? undefined,
      customer: {
        first_name: nameParts.shift(),
        last_name: nameParts.length ? nameParts.join(' ') : undefined,
        phone: row.phone,
        email: row.email ?? undefined,
      },
      line_items: cartLines,
      total_price:
        extra[0]?.total_price != null ? String(extra[0].total_price) : undefined,
      currency: extra[0]?.currency ?? undefined,
      recovery_url: row.recovery_url ?? undefined,
    };
    await this.sendProactiveTemplate(
      companyId,
      order,
      templateId,
      variableMap,
      'abandoned_manual',
    );
    // Stamp first-send so recovery attribution matches the automated path.
    await this.prisma
      .$executeRawUnsafe(
        `UPDATE shopify_abandoned_checkouts
            SET recovery_sent_at = COALESCE(recovery_sent_at, NOW(3))
          WHERE id = ? AND company_id = ?`,
        id,
        companyId,
      )
      .catch(() => undefined);
    return { sent: true };
  }

  /** Block 3 — Tags: confirm/cancel/pending tag names + decision window. */
  async updateTags(
    companyId: number,
    dto: {
      confirmTag: string;
      cancelTag: string;
      pendingTag?: string;
      decisionWindowMinutes?: number;
    },
  ) {
    if (!dto.confirmTag.trim() || !dto.cancelTag.trim()) {
      throw new BadRequestException(
        'Confirm and Cancel tag names are required',
      );
    }
    const win =
      dto.decisionWindowMinutes && dto.decisionWindowMinutes > 0
        ? Math.min(Math.floor(dto.decisionWindowMinutes), 1440)
        : 2;
    await this.ensureConfigRow(companyId);
    await this.prisma.shopifyOrderConfig.update({
      where: { company_id: companyId },
      data: {
        confirm_tag: dto.confirmTag.trim(),
        cancel_tag: dto.cancelTag.trim(),
        pending_tag: (dto.pendingTag || 'confirmation pending').trim(),
        decision_window_minutes: win,
      },
    });
    return this.getOrderConfig(companyId);
  }

  async getWebhookConfig(companyId: number) {
    const webhookKey = await this.ensureShopifyWebhookKey(companyId);
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        shopify_webhook_secret_encrypted: true,
        shopify_admin_token_encrypted: true,
      },
    });
    return {
      webhookKey,
      webhookSecretSet: !!c?.shopify_webhook_secret_encrypted,
      adminTokenSet: !!c?.shopify_admin_token_encrypted,
    };
  }

  async setWebhookSecret(companyId: number, secret: string) {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured — refusing to store secrets.',
      );
    }
    const trimmed = secret.trim();
    if (trimmed.length < 8) {
      throw new BadRequestException(
        'Shopify webhook signing secret looks too short',
      );
    }
    await this.ensureShopifyWebhookKey(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        shopify_webhook_secret_encrypted: this.encryption.encrypt(trimmed),
      },
    });
    return { webhookSecretSet: true };
  }

  // ── Native order-detail view (mirror + live hydrate) ────────────────────

  /** Resolve one order from the local mirror by its gid OR order number. */
  private async findOrderDetailRow(
    companyId: number,
    key: { gid?: string; number?: string },
  ) {
    if (key.gid) {
      return this.prisma.shopifyOrder.findFirst({
        where: { company_id: companyId, shopify_order_gid: key.gid },
      });
    }
    const num = (key.number || '').replace(/[^0-9]/g, '');
    if (!num) return null;
    return this.prisma.shopifyOrder.findFirst({
      where: {
        company_id: companyId,
        OR: [{ order_number: num }, { order_name: `#${num}` }, { order_name: num }],
      },
    });
  }

  /**
   * The COMPLETE order, assembled from CodesApp's own data (instant, no Shopify
   * call): the mirror row + its shipment, WhatsApp confirmation, assigned agent,
   * conversation link, admin URL and public-tracking link. The `/live` companion
   * hydrates transactions/refunds/timeline from Shopify on demand.
   */
  async getOrderDetail(companyId: number, key: { gid?: string; number?: string }) {
    const o = await this.findOrderDetailRow(companyId, key);
    if (!o) throw new NotFoundException('Order not found.');

    const numericId = o.shopify_order_gid.split('/').pop() ?? null;
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
      select: { shop_domain: true },
    });
    const shopDomain = (cfg?.shop_domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    const adminUrl =
      shopDomain && numericId ? `https://${shopDomain}/admin/orders/${numericId}` : null;

    const [shipment, confirmation, agent, company] = await Promise.all([
      this.prisma.shipment.findFirst({
        where: { company_id: companyId, shopify_order_gid: o.shopify_order_gid },
        select: {
          id: true,
          courier_type: true,
          status: true,
          courier_tracking_number: true,
          destination_city: true,
          conversation_id: true,
          loadsheet_batch_id: true,
          booked_at: true,
          delivered_at: true,
          cancelled_at: true,
          courier_settled_at: true,
          courier_invoice_id: true,
          last_courier_status_raw: true,
          shipper_advice_status: true,
        },
      }),
      this.prisma.shopifyOrderMessage.findFirst({
        where: { company_id: companyId, shopify_order_gid: o.shopify_order_gid },
        orderBy: { created_at: 'desc' },
        select: {
          status: true,
          created_at: true,
          updated_at: true,
          conversation_id: true,
          message_id: true,
        },
      }),
      o.assigned_user_id
        ? this.prisma.user.findFirst({
            where: { id: o.assigned_user_id, company_id: companyId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { public_slug: true },
      }),
    ]);

    // Creating agent (who made the order) — distinct from assigned_user_id. It
    // lives on the pending_order_hash written when the agent submits the
    // Create-order modal; fall back to the confirmation message's sender. This
    // is the same attribution the /orders agent list uses.
    let createdByAgent: { id: number; name: string } | null = null;
    {
      const poh = await this.prisma.pendingOrderHash.findFirst({
        where: {
          company_id: companyId,
          order_gid: o.shopify_order_gid,
          created_by_user_id: { not: null },
        },
        orderBy: { created_at: 'desc' },
        select: { created_by_user_id: true },
      });
      let creatorId = poh?.created_by_user_id ?? null;
      if (!creatorId && confirmation?.message_id) {
        const msg = await this.prisma.message.findFirst({
          where: { id: confirmation.message_id },
          select: { user_id: true },
        });
        creatorId = msg?.user_id ?? null;
      }
      if (creatorId) {
        createdByAgent = await this.prisma.user.findFirst({
          where: { id: creatorId, company_id: companyId },
          select: { id: true, name: true },
        });
      }
    }

    // Conversation to jump into the WhatsApp chat: prefer the shipment/confirmation
    // link, else resolve the contact by phone.
    let conversationId = shipment?.conversation_id ?? confirmation?.conversation_id ?? null;
    if (!conversationId && o.phone) {
      const normalized = this.normalizePhone(o.phone);
      if (normalized) {
        const contact = await this.prisma.contact.findFirst({
          where: {
            company_id: companyId,
            OR: [{ phone: normalized }, { phone: o.phone }],
          },
          select: { conversations: { select: { id: true }, take: 1 } },
        });
        conversationId = contact?.conversations?.[0]?.id ?? null;
      }
    }

    // Public tracking link — read-only (never mints a token here).
    let publicTrackingUrl: string | null = null;
    if (o.public_token && company?.public_slug && numericId) {
      const base =
        this.config.get<string>('PUBLIC_TRACKING_BASE_URL') ||
        `${(this.config.get<string>('APP_URL') || '').replace(/\/+$/, '')}/track`;
      if (base && base !== '/track') {
        publicTrackingUrl = `${base.replace(/\/+$/, '')}/${company.public_slug}/${numericId}?k=${o.public_token}`;
      }
    }

    const trackingUrl =
      shipment?.courier_tracking_number && shipment.courier_type
        ? courierTrackingUrl(shipment.courier_type, shipment.courier_tracking_number) ?? null
        : null;

    return {
      order: {
        orderGid: o.shopify_order_gid,
        orderName: o.order_name,
        orderNumber: o.order_number,
        numericId,
        adminUrl,
        customerName: o.customer_name,
        phone: o.phone,
        email: o.email,
        city: o.city,
        address1: o.address1,
        address2: o.address2,
        countryCode: o.country_code,
        totalPrice: o.total_price == null ? null : Number(o.total_price),
        totalOutstanding: o.total_outstanding == null ? null : Number(o.total_outstanding),
        currency: o.currency,
        financialStatus: o.financial_status,
        paymentGateway: o.payment_gateway,
        gatewayReconciledAt: o.gateway_reconciled_at,
        fulfillmentStatus: o.fulfillment_status,
        deliveryStatus: o.delivery_status,
        trackingCompany: o.tracking_company,
        trackingNumber: o.tracking_number,
        deliveredAt: o.delivered_at,
        cancelledAt: o.cancelled_at,
        archivedAt: o.archived_at,
        manualConfirmedAt: o.manual_confirmed_at,
        internalNote: o.internal_note,
        source: o.source,
        createdAt: o.shopify_created_at ?? o.created_at,
        publicTrackingUrl,
      },
      lineItems: Array.isArray(o.line_items) ? o.line_items : [],
      lineItemsSummary: o.line_items_summary,
      createdByAgent,
      assignedAgent: agent,
      shipment: shipment
        ? {
            id: shipment.id,
            courierType: shipment.courier_type,
            status: shipment.status,
            trackingNumber: shipment.courier_tracking_number,
            trackingUrl,
            city: shipment.destination_city,
            bookedAt: shipment.booked_at,
            deliveredAt: shipment.delivered_at,
            cancelledAt: shipment.cancelled_at,
            settledAt: shipment.courier_settled_at,
            invoiceId: shipment.courier_invoice_id,
            loadsheetBatchId: shipment.loadsheet_batch_id,
            lastStatusRaw: shipment.last_courier_status_raw,
            shipperAdvice: shipment.shipper_advice_status,
          }
        : null,
      confirmation: confirmation
        ? {
            status: confirmation.status,
            sentAt: confirmation.created_at,
            updatedAt: confirmation.updated_at,
          }
        : null,
      conversationId,
    };
  }

  /**
   * The authoritative live slice from Shopify — transactions, refunds, the
   * event timeline and current line items (with images). Never throws: on any
   * failure returns `{ ok: false }` so the mirror view still stands.
   */
  async getOrderLiveDetail(
    companyId: number,
    key: { gid?: string; number?: string },
  ): Promise<{ ok: boolean; [k: string]: unknown }> {
    const o = await this.findOrderDetailRow(companyId, key);
    if (!o) throw new NotFoundException('Order not found.');
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { ok: false, reason: 'not_connected' };
    }

    const query = `query($id: ID!) {
      order(id: $id) {
        name processedAt
        displayFinancialStatus displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount } }
        netPaymentSet { shopMoney { amount } }
        totalOutstandingSet { shopMoney { amount } }
        transactions(first: 25) {
          id kind status gateway processedAt
          amountSet { shopMoney { amount currencyCode } }
        }
        refunds(first: 25) {
          id createdAt note
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        lineItems(first: 100) {
          edges { node {
            title quantity variantTitle
            originalUnitPriceSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
            image { url }
          } }
        }
        events(first: 40) { edges { node { __typename createdAt
          ... on BasicEvent { message }
          ... on CommentEvent { message }
        } } }
      }
    }`;

    try {
      type Money = { shopMoney?: { amount?: string; currencyCode?: string } } | null;
      type Res = {
        data?: {
          order?: {
            name?: string;
            processedAt?: string | null;
            displayFinancialStatus?: string | null;
            displayFulfillmentStatus?: string | null;
            totalPriceSet?: Money;
            totalRefundedSet?: Money;
            netPaymentSet?: Money;
            totalOutstandingSet?: Money;
            transactions?: Array<{
              id: string;
              kind?: string;
              status?: string;
              gateway?: string;
              processedAt?: string | null;
              amountSet?: Money;
            }>;
            refunds?: Array<{
              id: string;
              createdAt?: string | null;
              note?: string | null;
              totalRefundedSet?: Money;
            }>;
            lineItems?: {
              edges?: Array<{
                node?: {
                  title?: string;
                  quantity?: number;
                  variantTitle?: string | null;
                  originalUnitPriceSet?: Money;
                  discountedTotalSet?: Money;
                  image?: { url?: string } | null;
                };
              }>;
            };
            events?: { edges?: Array<{ node?: { createdAt?: string; message?: string } }> };
          } | null;
        };
        errors?: Array<{ message: string }>;
      };
      const res = await this.shopifyGraphql<Res>(
        api.shopDomain,
        api.apiVersion,
        api.token,
        query,
        { id: o.shopify_order_gid },
      );
      const ord = res?.data?.order;
      if (!ord) return { ok: false, reason: 'not_found' };
      const amt = (m?: Money) => (m?.shopMoney?.amount != null ? Number(m.shopMoney.amount) : null);
      const strip = (s?: string | null) => (s ?? '').replace(/<[^>]+>/g, '').trim();

      return {
        ok: true,
        financialStatus: ord.displayFinancialStatus ?? null,
        fulfillmentStatus: ord.displayFulfillmentStatus ?? null,
        currency: ord.totalPriceSet?.shopMoney?.currencyCode ?? null,
        totalPrice: amt(ord.totalPriceSet),
        totalRefunded: amt(ord.totalRefundedSet),
        netPayment: amt(ord.netPaymentSet),
        totalOutstanding: amt(ord.totalOutstandingSet),
        transactions: (ord.transactions ?? []).map((t) => ({
          id: t.id,
          kind: t.kind ?? null,
          status: t.status ?? null,
          gateway: t.gateway ?? null,
          processedAt: t.processedAt ?? null,
          amount: amt(t.amountSet),
        })),
        refunds: (ord.refunds ?? []).map((r) => ({
          id: r.id,
          createdAt: r.createdAt ?? null,
          note: r.note ?? null,
          amount: amt(r.totalRefundedSet),
        })),
        lineItems: (ord.lineItems?.edges ?? []).map((e) => ({
          title: e.node?.title ?? '',
          quantity: e.node?.quantity ?? 0,
          variantTitle: e.node?.variantTitle ?? null,
          unitPrice: amt(e.node?.originalUnitPriceSet ?? null),
          lineTotal: amt(e.node?.discountedTotalSet ?? null),
          image: e.node?.image?.url ?? null,
        })),
        timeline: (ord.events?.edges ?? [])
          .map((e) => ({ at: e.node?.createdAt ?? null, message: strip(e.node?.message) }))
          .filter((e) => e.message),
      };
    } catch (err) {
      this.logger.warn(
        `getOrderLiveDetail failed (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, reason: 'error' };
    }
  }

  /** Teammates who can own an order (the assign dropdown). Tenant-scoped. */
  async listAssignableUsers(companyId: number) {
    return this.prisma.user.findMany({
      where: { company_id: companyId },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Set/clear an order's assigned agent (CodesApp-owned — never synced to Shopify). */
  async assignOrder(companyId: number, orderGid: string, userId: number | null) {
    if (userId != null) {
      const u = await this.prisma.user.findFirst({
        where: { id: userId, company_id: companyId },
        select: { id: true },
      });
      if (!u) throw new BadRequestException('That teammate is not in this workspace.');
    }
    const res = await this.prisma.shopifyOrder.updateMany({
      where: { company_id: companyId, shopify_order_gid: orderGid },
      data: { assigned_user_id: userId },
    });
    if (!res.count) throw new NotFoundException('Order not found.');
    return { ok: true, assignedUserId: userId };
  }
}
