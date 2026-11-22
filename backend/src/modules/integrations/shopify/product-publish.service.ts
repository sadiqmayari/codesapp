import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ShopifyService } from './shopify.service';
import { ShopifyInventoryService } from './shopify-inventory.service';
import { WooCommerceService } from '../commerce/woocommerce.service';

/** Payload stored on product_publish_jobs (one row per product × store). */
export interface PublishPayload {
  title: string;
  descriptionHtml?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  status: 'active' | 'unlisted' | 'draft' | 'archived';
  /** web paths (/storage/...) or absolute https URLs */
  images?: string[];
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    itemId: number;
    optionValues: string[];
    sku?: string | null;
    barcode?: string | null;
    price: number;
    compareAt?: number | null;
    cost?: number | null;
  }>;
  /** update: the existing product row id + only these fields */
  productId?: number;
}

/**
 * Inventory v2 — writes products CodesApp created / edited to the store
 * (Shopify productSet, Woo REST) and mirrors the result back, linked to the
 * master items so the new listings share stock from the first minute.
 * Runs on the `inventory` queue via ShopifyInventoryService.publishDelegate.
 */
@Injectable()
export class ProductPublishService implements OnModuleInit {
  private readonly logger = new Logger(ProductPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly inventory: ShopifyInventoryService,
    private readonly woo: WooCommerceService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.inventory.publishDelegate = (companyId, jobId) => this.publish(companyId, jobId);
  }

  private absolute(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const base = (this.config.get<string>('APP_URL') ?? '').replace(/\/+$/, '');
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  async publish(companyId: number, jobId: number): Promise<void> {
    const job = await this.prisma.productPublishJob.findFirst({ where: { id: jobId, company_id: companyId } });
    if (!job || job.status === 'ok') return;
    const payload = job.payload as unknown as PublishPayload;
    const store = await this.prisma.shopifyStore.findFirst({ where: { id: job.store_id, company_id: companyId } });
    if (!store) {
      await this.mark(jobId, 'error', 'Store not found');
      return;
    }
    await this.mark(jobId, 'running');
    try {
      const gid =
        job.action === 'update'
          ? await this.updateShopify(companyId, store.id, payload)
          : store.provider === 'woocommerce'
            ? await this.createWoo(companyId, store.id, payload)
            : await this.createShopify(companyId, store.id, payload);
      await this.prisma.productPublishJob.update({ where: { id: jobId }, data: { status: 'ok', error: null, product_gid: gid } });
    } catch (err) {
      const msg = this.shopify.pushErrText(err);
      await this.mark(jobId, 'error', msg);
      this.logger.warn(`publish job ${jobId}: ${msg}`);
      throw err;
    }
  }

  private async mark(id: number, status: string, error?: string) {
    await this.prisma.productPublishJob.update({ where: { id }, data: { status, error: error?.slice(0, 1000) ?? null } }).catch(() => undefined);
  }

  /** Our location id → this store's Shopify location gid. */
  private async storeLocations(companyId: number, storeId: number) {
    await this.inventory.ensureLocations(companyId, storeId).catch(() => undefined);
    return this.prisma.inventoryLocationLink.findMany({ where: { company_id: companyId, store_id: storeId, sync_enabled: true } });
  }

  private async createShopify(companyId: number, storeId: number, p: PublishPayload): Promise<string> {
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const links = await this.storeLocations(companyId, storeId);
    const levels = await this.prisma.inventoryLevel.findMany({
      where: { company_id: companyId, item_id: { in: p.variants.map((v) => v.itemId) } },
    });
    const options = p.options.length ? p.options : [{ name: 'Title', values: ['Default Title'] }];
    const input = {
      title: p.title,
      descriptionHtml: p.descriptionHtml ?? '',
      productType: p.productType ?? undefined,
      vendor: p.vendor ?? undefined,
      tags: p.tags ?? [],
      // UNLISTED/active publication is applied after create (version-safe)
      status: p.status === 'draft' ? 'DRAFT' : p.status === 'archived' ? 'ARCHIVED' : 'ACTIVE',
      productOptions: options.map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((v) => ({ name: v })) })),
      files: (p.images ?? []).slice(0, 10).map((u) => ({ originalSource: this.absolute(u), contentType: 'IMAGE' })),
      variants: p.variants.map((v) => ({
        optionValues: options.map((o, i) => ({ optionName: o.name, name: p.options.length ? v.optionValues[i] ?? o.values[0] : 'Default Title' })),
        price: String(v.price),
        compareAtPrice: v.compareAt != null && v.compareAt > v.price ? String(v.compareAt) : null,
        ...(v.sku ? { sku: v.sku } : {}),
        ...(v.barcode ? { barcode: v.barcode } : {}),
        inventoryItem: { tracked: true, ...(v.cost != null ? { cost: String(v.cost) } : {}) },
        inventoryQuantities: links.map((k) => ({
          locationId: k.external_location_gid,
          name: 'available',
          quantity: Math.max(0, levels.find((l) => l.item_id === v.itemId && l.location_id === k.location_id)?.available ?? 0),
        })),
      })),
    };
    const res = await this.shopify.shopifyGraphql<{
      data?: {
        productSet?: {
          product?: { id: string; variants: { nodes: Array<{ id: string; sku: string | null }> } } | null;
          userErrors: Array<{ field?: string[] | null; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    }>(
      api.shopDomain,
      api.apiVersion,
      api.token,
      `mutation($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(input: $input, synchronous: $synchronous) {
          product { id variants(first: 100) { nodes { id sku } } }
          userErrors { field message }
        }
      }`,
      { input, synchronous: true },
    );
    const ue = res.data?.productSet?.userErrors ?? [];
    const product = res.data?.productSet?.product;
    if (ue.length || res.errors?.length || !product) {
      const msg = [...ue.map((e) => e.message), ...(res.errors ?? []).map((e) => e.message)].join('; ') || 'Shopify did not create the product';
      throw new Error(`Shopify rejected the product: ${msg}.${this.shopify.scopeHint(msg, 'write_products')}`);
    }
    // returned variants follow input order; also key by sku
    const preLink = new Map<string, number>();
    product.variants.nodes.forEach((n, i) => {
      const v = p.variants[i];
      if (v) preLink.set(n.id, v.itemId);
    });
    p.variants.forEach((v) => v.sku && preLink.set(`sku:${v.sku.trim().toLowerCase()}`, v.itemId));
    await this.inventory.onProductWebhook(companyId, storeId, product.id, false, preLink);
    // Unlisted / Active publication on the Online Store channel
    const row = await this.prisma.inventoryProduct.findFirst({
      where: { company_id: companyId, shopify_store_id: storeId, shopify_product_gid: product.id },
      select: { id: true },
    });
    if (row && (p.status === 'unlisted' || p.status === 'active')) {
      await this.prisma.inventoryProduct.update({ where: { id: row.id }, data: { status: p.status, status_push_status: 'pending' } });
      await this.inventory.pushProductStatus(companyId, row.id).catch((e) => this.logger.warn(`status after create: ${(e as Error).message}`));
    }
    return product.id;
  }

  private async createWoo(companyId: number, storeId: number, p: PublishPayload): Promise<string> {
    const links = await this.storeLocations(companyId, storeId);
    const link = links[0];
    const levels = await this.prisma.inventoryLevel.findMany({
      where: { company_id: companyId, item_id: { in: p.variants.map((v) => v.itemId) }, ...(link ? { location_id: link.location_id } : {}) },
    });
    const r = await this.woo.createProduct(companyId, storeId, {
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      status: p.status,
      tags: p.tags,
      imageUrls: (p.images ?? []).map((u) => this.absolute(u)),
      options: p.options,
      variants: p.variants.map((v) => ({
        sku: v.sku,
        price: v.price,
        compareAt: v.compareAt,
        qty: levels.find((l) => l.item_id === v.itemId)?.available ?? 0,
        optionValues: v.optionValues,
      })),
    });
    // mirror the store, then link the new listings to their items
    await this.inventory.syncStore(companyId, storeId);
    const ids = p.variants.length > 1 || p.options.length
      ? p.variants.map((v) => (v.sku ? r.variationIds[v.sku] : undefined))
      : [r.productId];
    for (let i = 0; i < p.variants.length; i++) {
      const id = ids[i];
      if (!id) continue;
      await this.prisma.inventoryVariant.updateMany({
        where: { company_id: companyId, shopify_store_id: storeId, shopify_variant_gid: `woo://${storeId}/item/${id}` },
        data: { item_id: p.variants[i].itemId, link_source: 'created' },
      });
    }
    return `woo://${storeId}/product/${r.productId}`;
  }

  /** Edit title / description / type / vendor / tags of an existing Shopify product. */
  private async updateShopify(companyId: number, storeId: number, p: PublishPayload): Promise<string> {
    const row = await this.prisma.inventoryProduct.findFirst({ where: { id: p.productId, company_id: companyId } });
    if (!row) throw new Error('Product not found');
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const res = await this.shopify.shopifyGraphql<{
      data?: { productUpdate?: { userErrors: Array<{ message: string }> } };
      errors?: Array<{ message: string }>;
    }>(
      api.shopDomain,
      api.apiVersion,
      api.token,
      `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
      {
        product: {
          id: row.shopify_product_gid,
          title: p.title,
          ...(p.descriptionHtml != null ? { descriptionHtml: p.descriptionHtml } : {}),
          ...(p.productType != null ? { productType: p.productType } : {}),
          ...(p.vendor != null ? { vendor: p.vendor } : {}),
          ...(p.tags ? { tags: p.tags } : {}),
        },
      },
    );
    const e = [...(res.errors ?? []), ...(res.data?.productUpdate?.userErrors ?? [])].map((x) => x.message).join('; ');
    if (e) throw new Error(`Shopify rejected the change: ${e}.${this.shopify.scopeHint(e, 'write_products')}`);
    await this.prisma.inventoryProduct.update({
      where: { id: row.id },
      data: {
        title: p.title.slice(0, 400),
        ...(p.descriptionHtml != null ? { description_html: p.descriptionHtml } : {}),
        ...(p.productType != null ? { product_type: p.productType } : {}),
        ...(p.vendor != null ? { vendor: p.vendor } : {}),
        ...(p.tags ? { tags: p.tags } : {}),
      },
    });
    return row.shopify_product_gid;
  }
}
