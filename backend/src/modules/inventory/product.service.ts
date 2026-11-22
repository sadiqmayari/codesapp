import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { MediaService } from '../../common/services/media.service';
import { InventoryLedgerService, INVENTORY_QUEUE } from './core/inventory-ledger.service';
import { normSku } from './core/sku';
import { LlmService } from '../ai/llm.service';
import { AiMeteringService } from '../ai/ai-metering.service';

export type ProductStatus = 'active' | 'unlisted' | 'draft' | 'archived';
export const PRODUCT_STATUSES: ProductStatus[] = ['active', 'unlisted', 'draft', 'archived'];

export interface CreateProductInput {
  title: string;
  descriptionHtml?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  images?: string[];
  supplierId?: number | null;
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    optionValues: string[];
    sku?: string | null;
    barcode?: string | null;
    price: number;
    compareAt?: number | null;
    cost?: number | null;
    /** opening stock per our location id */
    stock?: Record<string, number>;
  }>;
  stores: Array<{ storeId: number; status: ProductStatus; priceDelta?: number | null }>;
}

/**
 * Inventory v2 — products CodesApp creates or edits, pushed to the stores:
 * create (master items + opening stock + one publish job per store), status
 * (Active / Unlisted / Draft / Archived, single + bulk with a preview),
 * detail edits, image upload, AI description.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly jobQueue: JobQueueService,
    private readonly media: MediaService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
  ) {}

  async create(companyId: number, dto: CreateProductInput, userId: number) {
    const title = (dto.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the product a title');
    if (!dto.variants?.length) throw new BadRequestException('Add at least one variant');
    if (dto.variants.length > 100) throw new BadRequestException('Up to 100 variants per product');
    if (!dto.stores?.length) throw new BadRequestException('Pick at least one store');
    const options = (dto.options ?? []).filter((o) => o.name.trim() && o.values.length).slice(0, 3);
    for (const v of dto.variants) {
      if (!(v.price > 0)) throw new BadRequestException('Every variant needs a price above 0');
      if (v.compareAt != null && v.compareAt > 0 && v.compareAt <= v.price) {
        throw new BadRequestException('Compare-at must be higher than the price');
      }
      if (options.length && v.optionValues.length !== options.length) throw new BadRequestException('Every variant needs a value for each option');
    }
    // SKUs must be unique among the variants and not used by another item
    const skus = dto.variants.map((v) => normSku(v.sku)).filter((s): s is string => !!s);
    if (new Set(skus).size !== skus.length) throw new BadRequestException('Two variants share a SKU');
    if (skus.length) {
      const taken = await this.prisma.inventoryItem.findFirst({
        where: { company_id: companyId, sku: { in: skus }, archived_at: null },
        select: { sku: true },
      });
      if (taken) throw new BadRequestException(`SKU ${taken.sku} is already used by another item`);
    }
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: companyId, id: { in: dto.stores.map((s) => s.storeId) }, status: 'active' },
      select: { id: true },
    });
    if (stores.length !== new Set(dto.stores.map((s) => s.storeId)).size) throw new BadRequestException('A store was not found');
    const locations = await this.prisma.inventoryLocation.findMany({ where: { company_id: companyId }, select: { id: true } });
    const locIds = new Set(locations.map((l) => l.id));

    // 1) one master item per variant
    const itemIds: number[] = [];
    for (const v of dto.variants) {
      const variantTitle = options.length ? v.optionValues.join(' / ') : null;
      const item = await this.prisma.inventoryItem.create({
        data: {
          company_id: companyId,
          title: title.slice(0, 400),
          variant_title: variantTitle,
          sku: normSku(v.sku),
          barcode: v.barcode?.trim() || null,
          category: dto.productType?.trim() || null,
          avg_cost: v.cost ?? null,
          supplier_id: dto.supplierId ?? null,
          image_url: dto.images?.[0] ?? null,
        },
        select: { id: true },
      });
      itemIds.push(item.id);
      if (v.cost != null) {
        await this.prisma.inventoryCostHistory.create({
          data: { company_id: companyId, item_id: item.id, new_cost: v.cost, source: 'manual', actor_user_id: userId },
        });
      }
      // 2) opening stock per location (the stores get it at create time)
      const lines = Object.entries(v.stock ?? {})
        .map(([loc, qty]) => ({ itemId: item.id, locationId: Number(loc), delta: Math.max(0, Math.trunc(qty)) }))
        .filter((l) => locIds.has(l.locationId) && l.delta > 0);
      if (lines.length) {
        await this.ledger.apply(companyId, lines, { reason: 'set', note: 'Opening stock (new product)', refType: 'manual', actorUserId: userId }, { push: false });
      }
    }

    // 3) one publish job per store
    const batchKey = crypto.randomUUID();
    for (const s of dto.stores) {
      const delta = s.priceDelta ?? 0;
      const payload = {
        title,
        descriptionHtml: dto.descriptionHtml ?? null,
        productType: dto.productType ?? null,
        vendor: dto.vendor ?? null,
        tags: (dto.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 50),
        status: s.status,
        images: dto.images ?? [],
        options,
        variants: dto.variants.map((v, i) => ({
          itemId: itemIds[i],
          optionValues: v.optionValues,
          sku: v.sku?.trim() || null,
          barcode: v.barcode?.trim() || null,
          price: Math.max(0.01, Math.round((v.price + delta) * 100) / 100),
          compareAt: v.compareAt ?? null,
          cost: v.cost ?? null,
        })),
      };
      const job = await this.prisma.productPublishJob.create({
        data: { company_id: companyId, batch_key: batchKey, store_id: s.storeId, action: 'create', payload: payload as unknown as Prisma.InputJsonValue, created_by: userId },
      });
      await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'publishProduct', companyId, jobId: job.id }, { dedupKey: `inv2-publish:${job.id}`, maxAttempts: 2 });
    }
    return { batchKey, itemIds };
  }

  async jobs(companyId: number, batchKey: string) {
    const rows = await this.prisma.productPublishJob.findMany({ where: { company_id: companyId, batch_key: batchKey }, orderBy: { id: 'asc' } });
    const stores = await this.prisma.shopifyStore.findMany({ where: { company_id: companyId }, select: { id: true, label: true, shop_domain: true } });
    const sBy = new Map(stores.map((s) => [s.id, s.label || s.shop_domain]));
    return rows.map((r) => ({ id: r.id, storeId: r.store_id, store: sBy.get(r.store_id) ?? `Store ${r.store_id}`, status: r.status, error: r.error, productGid: r.product_gid }));
  }

  async retryJob(companyId: number, jobId: number) {
    const r = await this.prisma.productPublishJob.findFirst({ where: { id: jobId, company_id: companyId } });
    if (!r) throw new NotFoundException('Not found');
    if (r.status === 'ok') return { queued: false };
    await this.prisma.productPublishJob.update({ where: { id: jobId }, data: { status: 'pending', error: null } });
    await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'publishProduct', companyId, jobId }, { dedupKey: `inv2-publish:${jobId}`, maxAttempts: 2 });
    return { queued: true };
  }

  // ── Status ───────────────────────────────────────────────────────────────

  /** What a bulk status change would do, per store, and what to warn about. */
  async statusPreview(companyId: number, productIds: number[], status: ProductStatus) {
    const rows = await this.prisma.inventoryProduct.findMany({
      where: { company_id: companyId, id: { in: productIds.slice(0, 2000) } },
      select: { id: true, status: true, shopify_store_id: true, variants: { select: { item_id: true } } },
    });
    const stores = await this.prisma.shopifyStore.findMany({ where: { company_id: companyId }, select: { id: true, label: true, shop_domain: true } });
    const sBy = new Map(stores.map((s) => [s.id, s.label || s.shop_domain]));
    const changing = rows.filter((r) => r.status !== status);
    const perStore = new Map<number, number>();
    changing.forEach((r) => perStore.set(r.shopify_store_id, (perStore.get(r.shopify_store_id) ?? 0) + 1));
    let withStock = 0;
    if (status === 'draft' || status === 'archived') {
      const itemIds = [...new Set(changing.flatMap((r) => r.variants.map((v) => v.item_id)).filter((x): x is number => !!x))];
      if (itemIds.length) {
        const lv = await this.prisma.inventoryLevel.groupBy({ by: ['item_id'], where: { item_id: { in: itemIds } }, _sum: { available: true } });
        const stocked = new Set(lv.filter((l) => (l._sum.available ?? 0) > 0).map((l) => l.item_id));
        withStock = changing.filter((r) => r.variants.some((v) => v.item_id && stocked.has(v.item_id))).length;
      }
    }
    return {
      changing: changing.length,
      unchanged: rows.length - changing.length,
      perStore: [...perStore.entries()].map(([storeId, count]) => ({ storeId, store: sBy.get(storeId) ?? `Store ${storeId}`, count })),
      withStock,
    };
  }

  async setStatus(companyId: number, productIds: number[], status: ProductStatus) {
    if (!PRODUCT_STATUSES.includes(status)) throw new BadRequestException('Unknown status');
    const rows = await this.prisma.inventoryProduct.findMany({
      where: { company_id: companyId, id: { in: productIds.slice(0, 2000) }, NOT: { status } },
      select: { id: true },
    });
    for (const r of rows) {
      await this.prisma.inventoryProduct.update({ where: { id: r.id }, data: { status, status_push_status: 'pending', status_push_error: null } });
      await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'setProductStatus', companyId, productId: r.id }, { dedupKey: `inv2-status:${r.id}`, maxAttempts: 2 });
    }
    this.ledger.emit(companyId, 'inventory.changed', { products: rows.map((r) => r.id), status });
    return { updated: rows.length };
  }

  /** Item ids → their store product rows (the catalogue selects items). */
  async productIdsForItems(companyId: number, itemIds: number[], storeId?: number) {
    const rows = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, item_id: { in: itemIds.slice(0, 2000) }, ...(storeId ? { shopify_store_id: storeId } : {}) },
      select: { product_id: true },
      distinct: ['product_id'],
    });
    return rows.map((r) => r.product_id);
  }

  // ── Edit details ─────────────────────────────────────────────────────────

  async getProduct(companyId: number, productId: number) {
    const p = await this.prisma.inventoryProduct.findFirst({
      where: { id: productId, company_id: companyId },
      include: { variants: { select: { id: true, item_id: true, variant_title: true, sku: true, price: true } } },
    });
    if (!p) throw new NotFoundException('Product not found');
    return {
      id: p.id, storeId: p.shopify_store_id, title: p.title, descriptionHtml: p.description_html, productType: p.product_type,
      vendor: p.vendor, tags: Array.isArray(p.tags) ? (p.tags as string[]) : [], status: p.status, image: p.image_url,
      variants: p.variants.map((v) => ({ id: v.id, itemId: v.item_id, title: v.variant_title, sku: v.sku, price: v.price != null ? Number(v.price) : null })),
    };
  }

  async updateDetails(
    companyId: number,
    productId: number,
    dto: { title: string; descriptionHtml?: string | null; productType?: string | null; vendor?: string | null; tags?: string[] },
    userId: number,
  ) {
    const p = await this.prisma.inventoryProduct.findFirst({ where: { id: productId, company_id: companyId } });
    if (!p) throw new NotFoundException('Product not found');
    if (p.shopify_product_gid.startsWith('woo://')) throw new BadRequestException('Edit WooCommerce products in WooCommerce for now');
    const job = await this.prisma.productPublishJob.create({
      data: {
        company_id: companyId,
        batch_key: crypto.randomUUID(),
        store_id: p.shopify_store_id,
        action: 'update',
        payload: { ...dto, title: dto.title.trim() || p.title, productId, options: [], variants: [], status: (p.status ?? 'active') as ProductStatus } as unknown as Prisma.InputJsonValue,
        created_by: userId,
      },
    });
    await this.jobQueue.enqueue(INVENTORY_QUEUE, { kind: 'publishProduct', companyId, jobId: job.id }, { dedupKey: `inv2-publish:${job.id}`, maxAttempts: 2 });
    return { batchKey: job.batch_key };
  }

  // ── Media + AI ───────────────────────────────────────────────────────────

  uploadImage(companyId: number, file: { buffer?: Buffer; mimetype?: string; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach an image');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype ?? '')) throw new BadRequestException('Use a JPG, PNG, WebP or GIF image');
    const saved = this.media.saveBuffer(file.buffer, file.mimetype!, companyId, file.originalname);
    const base = (this.config.get<string>('APP_URL') ?? '').replace(/\/+$/, '');
    return { path: saved.webPath, url: `${base}${saved.webPath}` };
  }

  async describe(companyId: number, userId: number, dto: { title: string; notes?: string; productType?: string; options?: string }) {
    await this.metering.assertAllowed(companyId);
    const res = await this.llm.complete({
      tier: 'fast',
      system: [
        {
          text:
            'You write product descriptions for an online store. Plain, specific, honest — no invented materials, sizes, ' +
            'awards or claims the input does not give. 2 short paragraphs then up to 5 bullet points. Output simple HTML ' +
            '(<p>, <ul>, <li>, <strong>) only, no headings, no markdown, no prices.',
        },
      ],
      userText: `Product: ${dto.title}\nType: ${dto.productType ?? ''}\nOptions: ${dto.options ?? ''}\nWhat the owner says about it: ${dto.notes ?? ''}`,
      maxTokens: 500,
      temperature: 0.4,
    });
    await this.metering.recordUsage(companyId, userId, 'inventory', res.provider, 'fast', res.usage);
    return { html: res.text.replace(/^```(?:html)?|```$/gm, '').trim() };
  }
}
