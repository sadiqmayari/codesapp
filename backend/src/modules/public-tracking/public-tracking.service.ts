import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { ShipmentService } from '../couriers/shipment.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { WorkspaceService } from '../workspace/workspace.service';
import {
  COURIER_DISPLAY_NAME,
  courierTrackingUrl,
} from '../couriers/couriers.constants';
import { numifyDecimals } from '../../common/utils/decimal';

interface StoredLineItem {
  title?: string | null;
  quantity?: number | null;
  variantId?: string | null;
  variantTitle?: string | null;
  price?: string | null;
}

/**
 * Public per-order tracking page. NO auth — access is gated purely by the
 * per-order secret token in the URL (constant-time compared). The response is a
 * hand-built sanitized DTO: it carries only what the buyer already owns (their
 * items / address / COD + the courier timeline) and NEVER internal_note, cost,
 * agent, email, or any other order.
 */
@Injectable()
export class PublicTrackingService {
  private readonly logger = new Logger(PublicTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly shipments: ShipmentService,
    private readonly shopify: ShopifyService,
    private readonly workspace: WorkspaceService,
  ) {}

  async getOrder(slug: string, orderId: string, token: string | undefined) {
    // 1. Resolve tenant by public slug. 404 (never reveal which slugs exist).
    const cleanSlug = (slug || '').toLowerCase().trim();
    if (!cleanSlug) throw new NotFoundException('Not found');
    const company = await this.prisma.company.findUnique({
      where: { public_slug: cleanSlug },
      select: { id: true, company_name: true, logo_url: true },
    });
    if (!company) throw new NotFoundException('Not found');

    // 2. Resolve order by the stable gid built from the numeric id in the path.
    const numericId = (orderId || '').replace(/\D/g, '');
    if (!numericId) throw new NotFoundException('Not found');
    const orderGid = `gid://shopify/Order/${numericId}`;
    const order = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: company.id,
          shopify_order_gid: orderGid,
        },
      },
    });

    // 3. Constant-time token compare. Any miss → identical 404 (no existence
    //    leak, no timing leak). An order without a minted token can't be opened.
    if (!order || !order.public_token || !this.tokenMatches(order.public_token, token)) {
      throw new NotFoundException('Not found');
    }

    // 4. Delivery timeline (cached 5m so a leaked URL can't hammer courier APIs).
    const shipment = await this.prisma.shipment.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: company.id,
          shopify_order_gid: orderGid,
        },
      },
      select: { id: true, courier_type: true, courier_tracking_number: true, status: true },
    });

    let delivery: PublicDelivery | null = null;
    if (shipment) {
      delivery = await this.resolveDelivery(company.id, shipment);
    }

    // 5. Sanitized DTO.
    const items = this.mapItems(order.line_items);
    await this.attachImages(company.id, numericId, items);
    const whatsapp = await this.resolveWhatsApp(company.id);
    const address = [order.address1, order.address2, order.city]
      .filter((x) => x && String(x).trim())
      .join(', ');

    return numifyDecimals({
      brand: {
        name: company.company_name,
        logo_url: company.logo_url ?? null,
        whatsapp,
      },
      order: {
        order_name: order.order_name ?? `#${numericId}`,
        created_at: order.shopify_created_at ?? order.created_at,
        currency: order.currency ?? null,
        items,
        total_price: order.total_price ?? null,
        total_outstanding: order.total_outstanding ?? null,
        financial_status: order.financial_status ?? null,
        fulfillment_status: order.fulfillment_status ?? null,
        // The buyer's own contact details (they already own these) — shown in a
        // "Contact details" card. Not PII beyond what's on their order.
        customer_name: order.customer_name ?? null,
        phone: order.phone ?? null,
        city: order.city ?? null,
        address: address || null,
      },
      delivery,
    });
  }

  private tokenMatches(stored: string, provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private async resolveDelivery(
    companyId: number,
    shipment: {
      id: number;
      courier_type: CourierType;
      courier_tracking_number: string | null;
      status: string;
    },
  ): Promise<PublicDelivery> {
    const cacheKey = `public-track:${shipment.id}`;
    const cached = this.cache.get<PublicDelivery>(cacheKey);
    if (cached) return cached;

    let checkpoints: { status: string; detail?: string; at?: string }[] = [];
    try {
      const history = await this.shipments.getTrackingHistory(companyId, shipment.id);
      checkpoints = Array.isArray(history.checkpoints) ? history.checkpoints : [];
    } catch (e) {
      this.logger.warn(
        `public tracking history failed (shipment ${shipment.id}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const tn = shipment.courier_tracking_number;
    const delivery: PublicDelivery = {
      courier_name: COURIER_DISPLAY_NAME[shipment.courier_type] ?? shipment.courier_type,
      status: shipment.status,
      tracking_number: tn ?? null,
      courier_url: tn ? courierTrackingUrl(shipment.courier_type, tn) ?? null : null,
      checkpoints,
    };
    this.cache.set(cacheKey, delivery, 300);
    return delivery;
  }

  private mapItems(raw: unknown): PublicItem[] {
    if (!Array.isArray(raw)) return [];
    return (raw as StoredLineItem[]).map((li) => ({
      title: li?.title ?? 'Item',
      variant: li?.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : null,
      qty: Number(li?.quantity ?? 1) || 1,
      price: li?.price ?? null,
      variant_id: li?.variantId ?? null,
      image: null,
    }));
  }

  /**
   * Best-effort product thumbnails. Resolves the stored variant gids to a small
   * CDN-resized image via Shopify (cached 1h per order — images rarely change).
   * NEVER throws: on any miss the items keep `image: null` and the page renders
   * a placeholder. `variant_id` is dropped from the outgoing item before return.
   */
  private async attachImages(
    companyId: number,
    numericOrderId: string,
    items: PublicItem[],
  ): Promise<void> {
    try {
      const gids = items
        .map((i) => i.variant_id)
        .filter((x): x is string => !!x);
      if (gids.length > 0) {
        const cacheKey = `public-track-img:${companyId}:${numericOrderId}`;
        let map = this.cache.get<Record<string, string>>(cacheKey);
        if (!map) {
          const resolved = await this.shopify.getVariantImages(companyId, gids);
          map = Object.fromEntries(resolved);
          this.cache.set(cacheKey, map, 3600);
        }
        for (const it of items) {
          if (it.variant_id && map[it.variant_id]) it.image = map[it.variant_id];
        }
      }
    } catch (e) {
      this.logger.warn(
        `public tracking images failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      // Never expose the internal variant gid to the public page.
      for (const it of items) delete it.variant_id;
    }
  }

  /** Tenant WhatsApp display number for the contact/call buttons; null on miss. */
  private async resolveWhatsApp(companyId: number): Promise<string | null> {
    try {
      const { number } = await this.workspace.getWhatsAppNumber(companyId);
      return number ?? null;
    } catch {
      return null;
    }
  }
}

export interface PublicItem {
  title: string;
  variant: string | null;
  qty: number;
  price: string | null;
  /** Internal-only: stripped before the DTO leaves the service. */
  variant_id?: string | null;
  image: string | null;
}

export interface PublicDelivery {
  courier_name: string;
  status: string;
  tracking_number: string | null;
  courier_url: string | null;
  checkpoints: { status: string; detail?: string; at?: string }[];
}
