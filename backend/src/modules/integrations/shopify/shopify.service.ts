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
import { JobQueueService } from '../../../common/services/job-queue.service';
import { UsageMeteringService } from '../../usage-metering/usage-metering.service';
import { InboxService } from '../../inbox/inbox.service';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { AiKnowledgeService } from '../../ai/ai-knowledge.service';
import { AiRagService, RagItem } from '../../ai/ai-rag.service';

interface ShopifyOrderPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  order_number?: number | string;
  number?: number | string;
  total_price?: string;
  currency?: string;
  financial_status?: string;
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
}

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
  | { kind: 'syncKnowledge'; companyId: number };

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
];
const SHOPIFY_ORDER_FIELD_KEYS = new Set(
  SHOPIFY_ORDER_FIELDS.map((f) => f.key),
);

@Injectable()
export class ShopifyService implements OnModuleInit {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly jobQueue: JobQueueService,
    private readonly metering: UsageMeteringService,
    private readonly inbox: InboxService,
    private readonly aiKnowledge: AiKnowledgeService,
    private readonly rag: AiRagService,
  ) {}

  onModuleInit(): void {
    // 120s lease — Shopify GraphQL (order create/complete, tag mutations,
    // knowledge sync) can exceed the default 30s; a short lease risks a second
    // worker double-executing a draftOrderComplete (duplicate order).
    this.jobQueue.registerWorker(
      'shopify',
      (p) => this.processJob(p as ShopifyJob),
      3,
      120,
    );
    this.logger.log('Registered shopify worker (concurrency=3, lease=120s)');
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

  private async processOrderSend(
    companyId: number,
    shopDomain: string,
    order: ShopifyOrderPayload,
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
    if (this.isPaidOrder(order)) {
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
    if (orderGid) {
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

    // Get-or-create contact (mirrors MetaWebhookService.handleInbound).
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
      // Backfill the email onto an existing contact (don't overwrite one
      // the team may have curated).
      contact = await this.prisma.contact.update({
        where: { id: contact.id },
        data: { email },
      });
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

    // Templates are allowed regardless of the 24h window.
    const message = (await this.inbox.sendMessage(companyId, convo.id, {
      type: SendMessageType.template,
      templateId: cfg.template_id,
      variables,
    })) as { id: number };

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
          featuredImage { url }
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
   * Look up an order's current status by its number (e.g. "1001"), so the AI can
   * give the customer a FACTUAL status instead of guessing. Requires the Admin
   * token's read_orders scope. Never throws — returns `{ found:false, error }`
   * on any failure so the autonomous caller can ask/hand off cleanly.
   */
  async getOrderStatus(
    companyId: number,
    orderNumber: string,
  ): Promise<{
    found: boolean;
    error?: boolean;
    name?: string;
    fulfillmentStatus?: string;
    financialStatus?: string;
    tracking?: Array<{ url: string | null; number: string | null; company: string | null }>;
  }> {
    const digits = (orderNumber || '').replace(/[^0-9]/g, '');
    if (!digits) return { found: false };
    let api: Awaited<ReturnType<typeof this.requireAdminApi>>;
    try {
      api = await this.requireAdminApi(companyId);
    } catch {
      return { found: false, error: true };
    }
    const gql = `query($q: String) {
      orders(first: 1, query: $q) {
        edges { node {
          name
          displayFulfillmentStatus
          displayFinancialStatus
          fulfillments(first: 5) { trackingInfo { number url company } }
        } }
      }
    }`;
    try {
      const res = await this.shopifyGraphql<{
        data?: {
          orders?: {
            edges: Array<{
              node: {
                name: string;
                displayFulfillmentStatus: string | null;
                displayFinancialStatus: string | null;
                fulfillments: Array<{
                  trackingInfo: Array<{
                    number: string | null;
                    url: string | null;
                    company: string | null;
                  }>;
                }>;
              };
            }>;
          };
        };
        errors?: Array<{ message: string }>;
      }>(api.shopDomain, api.apiVersion, api.token, gql, {
        q: `name:#${digits}`,
      });
      if (res?.errors?.length) {
        this.logger.warn(
          `Shopify order status errors (company ${companyId}): ${res.errors
            .map((e) => e.message)
            .join('; ')}`,
        );
        return { found: false, error: true };
      }
      const node = res?.data?.orders?.edges?.[0]?.node;
      if (!node) return { found: false };
      const tracking = (node.fulfillments ?? [])
        .flatMap((f) => f.trackingInfo ?? [])
        .map((t) => ({
          url: t.url ?? null,
          number: t.number ?? null,
          company: t.company ?? null,
        }))
        .filter((t) => t.url || t.number);
      return {
        found: true,
        name: node.name,
        fulfillmentStatus: node.displayFulfillmentStatus ?? undefined,
        financialStatus: node.displayFinancialStatus ?? undefined,
        tracking,
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
    if (!phone && !email) return null;
    try {
      // searchCustomer now does an exact customerByIdentifier lookup first,
      // so an existing customer is found reliably (no more orphan orders).
      const matches = await this.searchCustomer(companyId, { phone, email });
      if (matches[0]?.id) return matches[0].id;
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
  private mapDiscount(d?: {
    type: 'percentage' | 'fixed';
    value: number;
  }): Record<string, unknown> | undefined {
    if (!d || !(Number(d.value) > 0)) return undefined;
    return {
      value: Number(d.value),
      valueType: d.type === 'percentage' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
      title: 'Discount',
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
    },
  ): Promise<{ orderId: string; orderName: string; adminUrl: string }> {
    const api = await this.requireAdminApi(companyId);
    const { shopDomain } = api;

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
          draftOrder?: { order?: { id: string; name: string } | null } | null;
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
        `mutation($id: ID!, $paymentPending: Boolean) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder { order { id name } }
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
    this.logger.log(
      `Shopify order ${order.name} created from chat (company ${companyId})`,
    );
    return {
      orderId: order.id,
      orderName: order.name,
      adminUrl: `https://${shopDomain}/admin/orders/${numericId}`,
    };
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
        active_events: ['orders/create', 'orders/fulfilled'],
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

    // Only orders/create drives the confirmation flow for now.
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

  async getOrderConfig(companyId: number) {
    const [row, company, webhookKey] = await Promise.all([
      this.prisma.shopifyOrderConfig.findUnique({
        where: { company_id: companyId },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          shopify_webhook_secret_encrypted: true,
          shopify_admin_token_encrypted: true,
        },
      }),
      this.ensureShopifyWebhookKey(companyId),
    ]);
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
        };
    return {
      config,
      fields: SHOPIFY_ORDER_FIELDS,
      apiVersions: SHOPIFY_API_VERSIONS,
      webhookKey,
      webhookSecretSet: !!company?.shopify_webhook_secret_encrypted,
      adminTokenSet: !!company?.shopify_admin_token_encrypted,
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
}
