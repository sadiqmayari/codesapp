import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { FeatureService } from '../../../common/services/feature.service';
import { runsBackground } from '../../../common/utils/process-role';
import { InventoryLedgerService, INVENTORY_QUEUE } from '../../inventory/core/inventory-ledger.service';
import { groupListings, LinkSource, normBarcode, normSku, titleKey } from '../../inventory/core/sku';
import { interpretWebhook, planPush, reasonForStoreDelta } from '../../inventory/core/push-plan';
import { resolveInventorySettings } from '../../inventory/core/settings';
import { ShopifyService } from './shopify.service';
import { WooCommerceService } from '../commerce/woocommerce.service';

/** Jobs on the `inventory` queue (worker only). */
export type InventoryJob =
  | { kind: 'bootstrap'; companyId: number }
  | { kind: 'syncStore'; companyId: number; storeId: number; seed?: boolean }
  | { kind: 'pushItem'; companyId: number; itemId: number }
  | {
      kind: 'levelWebhook';
      companyId: number;
      storeId: number;
      inventoryItemId: string;
      locationGid: string;
      available: number;
      at: string | null;
    }
  | { kind: 'productWebhook'; companyId: number; storeId: number; productGid: string; deleted: boolean }
  | { kind: 'restockReturn'; companyId: number; shipmentId: number }
  | { kind: 'setProductStatus'; companyId: number; productId: number }
  | { kind: 'publishProduct'; companyId: number; jobId: number }
  | { kind: 'pushPrice'; companyId: number; variantId: number }
  | { kind: 'pushCost'; companyId: number; itemId: number };

type Api = Awaited<ReturnType<ShopifyService['requireAdminApi']>>;

interface LevelQty {
  available: number;
  committed: number;
  incoming: number;
}

/** woo listing gid: woo://<storeId>/item/<variationId|productId> */
export const wooListingGid = (storeId: number, id: number | string) => `woo://${storeId}/item/${id}`;
export const wooProductGid = (storeId: number, id: number | string) => `woo://${storeId}/product/${id}`;

const SCHEDULER_TICK_MS = 10 * 60_000;

const VARIANT_FIELDS = `
  id title sku barcode price compareAtPrice inventoryQuantity
  inventoryItem { id tracked unitCost { amount } }
  requiresComponents
  productVariantComponents(first: 25) { edges { node { quantity productVariant { id } } } }`;

const PRODUCT_FIELDS = `
  id title handle status productType vendor tags
  featuredImage { url(transform: { maxWidth: 200, maxHeight: 200 }) }`;

interface VariantNode {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: { id: string | null; tracked?: boolean | null; unitCost?: { amount?: string | null } | null } | null;
  requiresComponents?: boolean | null;
  productVariantComponents?: { edges: Array<{ node: { quantity: number; productVariant: { id: string } | null } }> };
  inventoryItemLevels?: Map<string, LevelQty>;
}

interface ProductNode {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  productType: string | null;
  vendor: string | null;
  tags?: string[];
  featuredImage: { url: string | null } | null;
  variants: { pageInfo?: { hasNextPage: boolean; endCursor?: string | null }; edges: Array<{ node: VariantNode }> };
}

/**
 * Inventory v2 — every store-facing stock operation (Shopify GraphQL + Woo
 * REST): location mapping, the catalogue + per-location stock mirror, linking
 * listings to master items, pushing the shared pool to every linked store,
 * store webhooks, return restocks, product status, and the reconcile sweep.
 * Stock itself is only ever changed through InventoryLedgerService.
 */
@Injectable()
export class ShopifyInventoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopifyInventoryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastReconcile = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly woo: WooCommerceService,
    private readonly jobQueue: JobQueueService,
    private readonly ledger: InventoryLedgerService,
    private readonly feature: FeatureService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(INVENTORY_QUEUE, (p) => this.process(p as InventoryJob), 2, 600);
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), SCHEDULER_TICK_MS);
    setTimeout(() => void this.tick().catch(() => undefined), 90_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async process(job: InventoryJob): Promise<void> {
    switch (job.kind) {
      case 'bootstrap':
        return this.bootstrap(job.companyId);
      case 'syncStore':
        return this.syncStore(job.companyId, job.storeId, { seed: !!job.seed });
      case 'pushItem':
        return this.pushItem(job.companyId, job.itemId);
      case 'levelWebhook':
        return this.onLevelWebhook(job);
      case 'productWebhook':
        return this.onProductWebhook(job.companyId, job.storeId, job.productGid, job.deleted);
      case 'restockReturn':
        return this.restockReturn(job.companyId, job.shipmentId);
      case 'setProductStatus':
        return this.pushProductStatus(job.companyId, job.productId);
      case 'pushPrice':
        await this.shopify.pushVariantPrice(job.companyId, job.variantId);
        return;
      case 'pushCost':
        return this.pushItemCost(job.companyId, job.itemId);
      case 'publishProduct':
        // Implemented in ProductPublishService (registered on the same queue
        // would double-register; it hooks in via this delegate).
        if (this.publishDelegate) await this.publishDelegate(job.companyId, job.jobId);
        return;
    }
  }

  /** Set by ProductPublishService (same module) to avoid a constructor cycle. */
  publishDelegate?: (companyId: number, jobId: number) => Promise<void>;

  // ── Scheduler (worker only) ───────────────────────────────────────────────

  private async tick(): Promise<void> {
    const on = await this.feature.companiesWith('inventory');
    if (!on.size) return;
    const companies = await this.prisma.company.findMany({
      where: { id: { in: [...on] } },
      select: { id: true, inventory_v2_at: true, inventory_settings: true },
    });
    for (const c of companies) {
      if (!c.inventory_v2_at) {
        await this.enqueue({ kind: 'bootstrap', companyId: c.id }, `inv2-boot:${c.id}`);
        continue;
      }
      const mins = resolveInventorySettings(c.inventory_settings).reconcileMinutes;
      const stores = await this.prisma.shopifyStore.findMany({
        where: { company_id: c.id, status: 'active' },
        select: { id: true },
      });
      for (const s of stores) {
        const key = `${c.id}:${s.id}`;
        if (Date.now() - (this.lastReconcile.get(key) ?? 0) < mins * 60_000) continue;
        this.lastReconcile.set(key, Date.now());
        await this.enqueue({ kind: 'syncStore', companyId: c.id, storeId: s.id }, `inv2-sync:${c.id}:${s.id}`);
      }
    }
  }

  async enqueue(job: InventoryJob, dedupKey?: string, delayMs?: number): Promise<void> {
    await this.jobQueue.enqueue(INVENTORY_QUEUE, job, { dedupKey, delayMs, maxAttempts: 3 });
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  /** One-time (re-runnable) v2 seed: locations → catalogue + stock → links → pool. */
  async bootstrap(companyId: number): Promise<void> {
    if (!(await this.feature.inventoryEnabled(companyId))) return;
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: companyId, status: 'active' },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
    });
    for (const s of stores) {
      try {
        await this.syncStore(companyId, s.id, { seed: true });
      } catch (e) {
        this.logger.warn(`bootstrap store ${s.id} (company ${companyId}): ${(e as Error).message}`);
      }
    }
    await this.prisma.company.update({ where: { id: companyId }, data: { inventory_v2_at: new Date() } });
    this.ledger.emit(companyId, 'inventory.changed', { bootstrap: true });
  }

  // ── Locations ────────────────────────────────────────────────────────────

  async ensureLocations(companyId: number, storeId: number): Promise<void> {
    const store = await this.prisma.shopifyStore.findFirst({ where: { id: storeId, company_id: companyId } });
    if (!store) return;
    const ours = await this.prisma.inventoryLocation.findMany({ where: { company_id: companyId } });
    const byName = new Map(ours.map((l) => [l.name.trim().toLowerCase(), l]));
    const ensureLoc = async (name: string) => {
      const key = name.trim().toLowerCase();
      const hit = byName.get(key);
      if (hit) return hit;
      const created = await this.prisma.inventoryLocation.create({
        data: { company_id: companyId, name: name.slice(0, 120), is_default: ours.length === 0 && byName.size === 0 },
      });
      byName.set(key, created);
      return created;
    };
    const link = async (locationId: number, gid: string, extName: string | null) => {
      await this.prisma.inventoryLocationLink.upsert({
        where: { company_id_store_id_external_location_gid: { company_id: companyId, store_id: storeId, external_location_gid: gid } },
        create: { company_id: companyId, store_id: storeId, location_id: locationId, external_location_gid: gid, external_name: extName },
        update: { external_name: extName },
      });
    };
    if (store.provider === 'woocommerce') {
      const exists = await this.prisma.inventoryLocationLink.findFirst({
        where: { company_id: companyId, store_id: storeId, external_location_gid: 'default' },
      });
      if (!exists) {
        const def = ours.find((l) => l.is_default) ?? (await ensureLoc('Main warehouse'));
        await link(def.id, 'default', 'WooCommerce stock');
      }
      return;
    }
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const res = await this.shopify.shopifyGraphql<{
      data?: { locations?: { edges: Array<{ node: { id: string; name: string; isActive: boolean } }> } };
      errors?: Array<{ message: string }>;
    }>(api.shopDomain, api.apiVersion, api.token, `query { locations(first: 50) { edges { node { id name isActive } } } }`, {});
    if (res.errors?.length) {
      throw new BadRequestException(
        `Shopify locations unavailable (${res.errors.map((e) => e.message).join('; ')}). The token needs read_locations.`,
      );
    }
    const existingLinks = await this.prisma.inventoryLocationLink.findMany({
      where: { company_id: companyId, store_id: storeId },
      select: { external_location_gid: true },
    });
    const linked = new Set(existingLinks.map((l) => l.external_location_gid));
    for (const { node } of res.data?.locations?.edges ?? []) {
      if (!node.isActive || linked.has(node.id)) continue;
      const loc = await ensureLoc(node.name || 'Shopify location');
      await link(loc.id, node.id, node.name);
    }
    if (!(await this.prisma.inventoryLocation.findFirst({ where: { company_id: companyId, is_default: true } }))) {
      const first = await this.prisma.inventoryLocation.findFirst({ where: { company_id: companyId }, orderBy: { id: 'asc' } });
      if (first) await this.prisma.inventoryLocation.update({ where: { id: first.id }, data: { is_default: true } });
    }
  }

  /** The location a store's returns/creates default to (its primary Shopify location's link). */
  async defaultLocationForStore(companyId: number, storeId: number | null): Promise<number | null> {
    if (storeId) {
      const store = await this.prisma.shopifyStore.findFirst({
        where: { id: storeId, company_id: companyId },
        select: { primary_location_gid: true },
      });
      const links = await this.prisma.inventoryLocationLink.findMany({
        where: { company_id: companyId, store_id: storeId, sync_enabled: true },
        orderBy: { id: 'asc' },
      });
      const prim = links.find((l) => l.external_location_gid === store?.primary_location_gid) ?? links[0];
      if (prim) return prim.location_id;
    }
    const def = await this.prisma.inventoryLocation.findFirst({
      where: { company_id: companyId, is_active: true },
      orderBy: [{ is_default: 'desc' }, { id: 'asc' }],
    });
    return def?.id ?? null;
  }

  // ── Catalogue + stock mirror ─────────────────────────────────────────────

  /**
   * Full mirror of one store: every product (all statuses), every variant
   * (variant pages beyond 100 too), stock per linked location. `seed` = set
   * the pool from the store (bootstrap); otherwise a store value that differs
   * from what we last saw is a missed change → applied to the pool as
   * `external` and fanned out to the other stores.
   */
  async syncStore(companyId: number, storeId: number, opts: { seed?: boolean } = {}): Promise<void> {
    const store = await this.prisma.shopifyStore.findFirst({ where: { id: storeId, company_id: companyId } });
    if (!store) return;
    await this.ensureLocations(companyId, storeId);
    if (store.provider === 'woocommerce') return this.syncWooStore(companyId, storeId, !!opts.seed);

    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const now = new Date();
    const seenVariants = new Set<number>();
    const seenProducts = new Set<number>();
    let cursor: string | null = null;
    let complete = false;
    for (let page = 0; page < 400; page++) {
      const res: {
        data?: { products?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: ProductNode }> } };
        errors?: Array<{ message: string }>;
      } = await this.gql(api, storeId, `query($cursor: String) {
        products(first: 40, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${PRODUCT_FIELDS}
            variants(first: 100) { pageInfo { hasNextPage endCursor } edges { node { ${VARIANT_FIELDS} } } }
          } }
        }
      }`, { cursor });
      if (res.errors?.length) {
        throw new BadRequestException(
          `Shopify could not return products (${res.errors.map((e) => e.message).join('; ')}). The token needs read_products + read_inventory.`,
        );
      }
      const conn = res.data?.products;
      if (!conn) break;
      for (const { node } of conn.edges) {
        if (node.variants.pageInfo?.hasNextPage) await this.loadMoreVariants(api, storeId, node);
        const ids = await this.upsertProductNode(companyId, storeId, now, node);
        seenProducts.add(ids.productId);
        ids.variantIds.forEach((v) => seenVariants.add(v));
      }
      if (!conn.pageInfo.hasNextPage) {
        complete = true;
        break;
      }
      cursor = conn.pageInfo.endCursor;
    }

    // Deleted in Shopify → drop the listing (its master item + history stay).
    if (complete) {
      await this.prisma.inventoryVariant.deleteMany({
        where: { company_id: companyId, shopify_store_id: storeId, id: { notIn: [...seenVariants] } },
      });
      await this.prisma.inventoryProduct.deleteMany({
        where: { company_id: companyId, shopify_store_id: storeId, id: { notIn: [...seenProducts] } },
      });
    }

    await this.linkUnlinked(companyId);

    // Per-location stock.
    const links = await this.prisma.inventoryLocationLink.findMany({
      where: { company_id: companyId, store_id: storeId, sync_enabled: true },
    });
    for (const link of links) {
      const levels = await this.fetchLocationLevels(api, storeId, link.external_location_gid);
      await this.applyStoreLevels(companyId, storeId, link.id, link.location_id, levels, !!opts.seed);
    }
    await this.refreshLegacyMirror(companyId, storeId);
    await this.shopify.ensureInventoryWebhook(companyId, storeId).catch(() => undefined);
    this.ledger.emit(companyId, 'inventory.changed', { storeId, sync: true });
  }

  private async gql<T>(api: Api, storeId: number, query: string, vars: Record<string, unknown>): Promise<T> {
    try {
      return await this.shopify.shopifyGraphql<T>(api.shopDomain, api.apiVersion, api.token, query, vars);
    } catch (err) {
      await this.shopify.flagTokenMaybeInvalid(storeId, err);
      throw err;
    }
  }

  private async loadMoreVariants(api: Api, storeId: number, node: ProductNode): Promise<void> {
    let after = node.variants.pageInfo?.endCursor ?? null;
    for (let i = 0; i < 30 && after; i++) {
      const r = await this.gql<{
        data?: { product?: { variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: VariantNode }> } } };
      }>(api, storeId, `query($id: ID!, $after: String) {
        product(id: $id) { variants(first: 100, after: $after) { pageInfo { hasNextPage endCursor } edges { node { ${VARIANT_FIELDS} } } } }
      }`, { id: node.id, after });
      const v = r.data?.product?.variants;
      if (!v) break;
      node.variants.edges.push(...v.edges);
      after = v.pageInfo.hasNextPage ? v.pageInfo.endCursor : null;
    }
  }

  /** inventoryItem gid → quantities at one Shopify location (paged, 250 per call). */
  private async fetchLocationLevels(api: Api, storeId: number, locationGid: string): Promise<Map<string, LevelQty>> {
    const out = new Map<string, LevelQty>();
    let after: string | null = null;
    for (let i = 0; i < 400; i++) {
      const r: {
        data?: {
          location?: {
            inventoryLevels: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              edges: Array<{ node: { item: { id: string } | null; quantities: Array<{ name: string; quantity: number }> } }>;
            };
          } | null;
        };
      } = await this.gql(api, storeId, `query($loc: ID!, $after: String) {
        location(id: $loc) {
          inventoryLevels(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { item { id } quantities(names: ["available", "committed", "incoming"]) { name quantity } } }
          }
        }
      }`, { loc: locationGid, after });
      const conn = r.data?.location?.inventoryLevels;
      if (!conn) break;
      for (const { node } of conn.edges) {
        if (!node.item?.id) continue;
        const q = (n: string) => node.quantities.find((x) => x.name === n)?.quantity ?? 0;
        out.set(node.item.id, { available: q('available'), committed: q('committed'), incoming: q('incoming') });
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  /** Upsert one product + its variants (listings). Respects pending local edits. */
  private async upsertProductNode(
    companyId: number,
    storeId: number,
    now: Date,
    p: ProductNode,
  ): Promise<{ productId: number; variantIds: number[] }> {
    const existing = await this.prisma.inventoryProduct.findUnique({
      where: { company_id_shopify_store_id_shopify_product_gid: { company_id: companyId, shopify_store_id: storeId, shopify_product_gid: p.id } },
      select: { id: true, status_push_status: true },
    });
    const keepStatus = existing?.status_push_status === 'pending' || existing?.status_push_status === 'error';
    const base = {
      title: (p.title ?? '').slice(0, 400),
      handle: p.handle ?? null,
      product_type: p.productType ?? null,
      vendor: p.vendor ?? null,
      image_url: p.featuredImage?.url ?? null,
      tags: (p.tags ?? []) as Prisma.InputJsonValue,
      synced_at: now,
    };
    const status = (p.status ?? '').toLowerCase() || null;
    const product = existing
      ? await this.prisma.inventoryProduct.update({
          where: { id: existing.id },
          data: { ...base, ...(keepStatus ? {} : { status }) },
          select: { id: true },
        })
      : await this.prisma.inventoryProduct.create({
          data: { company_id: companyId, shopify_store_id: storeId, shopify_product_gid: p.id, status, ...base },
          select: { id: true },
        });
    const variantIds: number[] = [];
    for (const { node: v } of p.variants.edges) {
      // reuse the proven listing upsert (keeps local edits, bundles, cost)
      await this.shopify.upsertInventoryVariantNode(companyId, storeId, now, product.id, {
        ...v,
        inventoryQuantity: v.inventoryQuantity,
      });
      const row = await this.prisma.inventoryVariant.findUnique({
        where: { company_id_shopify_store_id_shopify_variant_gid: { company_id: companyId, shopify_store_id: storeId, shopify_variant_gid: v.id } },
        select: { id: true, item_id: true },
      });
      if (row) {
        variantIds.push(row.id);
        if (row.item_id && v.inventoryItem?.tracked === false) {
          await this.prisma.inventoryItem.updateMany({ where: { id: row.item_id, track: true }, data: { track: false } });
        }
      }
    }
    return { productId: product.id, variantIds };
  }

  /**
   * Record one store location's stock for its listings. seed → pool takes the
   * store value (max across stores, never pushed: disagreements surface as
   * conflicts). Otherwise a store value that moved since we last saw it is a
   * missed change → ledger `external` (fanned out to the other stores).
   */
  private async applyStoreLevels(
    companyId: number,
    storeId: number,
    linkId: number,
    locationId: number,
    levels: Map<string, LevelQty>,
    seed: boolean,
  ): Promise<void> {
    const listings = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, shopify_store_id: storeId, shopify_inventory_item_gid: { not: null } },
      select: { id: true, item_id: true, is_bundle: true, shopify_inventory_item_gid: true, item: { select: { track: true } } },
    });
    const states = await this.prisma.listingPushState.findMany({ where: { company_id: companyId, location_link_id: linkId } });
    const stateBy = new Map(states.map((s) => [s.variant_id, s]));
    const committedByItem = new Map<number, number>();
    for (const l of listings) {
      const q = levels.get(l.shopify_inventory_item_gid!);
      if (!q || l.is_bundle) continue; // not stocked at this location / bundle
      const st = stateBy.get(l.id);
      await this.prisma.listingPushState.upsert({
        where: { variant_id_location_link_id: { variant_id: l.id, location_link_id: linkId } },
        create: { company_id: companyId, variant_id: l.id, location_link_id: linkId, last_seen: q.available, committed: q.committed, status: 'ok' },
        update: { last_seen: q.available, committed: q.committed },
      });
      if (!l.item_id || l.item?.track === false) continue;
      committedByItem.set(l.item_id, (committedByItem.get(l.item_id) ?? 0) + q.committed);
      const level = await this.prisma.inventoryLevel.findUnique({
        where: { item_id_location_id: { item_id: l.item_id, location_id: locationId } },
        select: { available: true },
      });
      if (!level || (seed && q.available > level.available)) {
        // Seed: the pool adopts the store value; across stores the MAX wins
        // (a lower store shows as a conflict until someone resolves it).
        await this.ledger.apply(
          companyId,
          [{ itemId: l.item_id, locationId, delta: q.available - (level?.available ?? 0), variantId: l.id }],
          { reason: 'bootstrap', refType: 'webhook', note: 'Seeded from store stock' },
          { push: false },
        );
        continue;
      }
      if (seed) continue;
      if (st?.last_seen == null) {
        // first time this listing is tracked here while the pool already has
        // stock → make the store match the pool
        await this.ledger.queuePush(companyId, l.item_id);
        continue;
      }
      const v = interpretWebhook(st.last_seen, q.available);
      if (v.kind === 'change') {
        await this.ledger.apply(
          companyId,
          [{ itemId: l.item_id, locationId, delta: v.delta, variantId: l.id }],
          { reason: 'external', refType: 'webhook', note: 'Found during store reconcile' },
        );
      }
    }
    for (const [itemId, committed] of committedByItem) {
      await this.ledger.setCounters(companyId, itemId, locationId, { committed });
    }
  }

  /** Keep the legacy listing columns meaningful for old readers. */
  private async refreshLegacyMirror(companyId: number, storeId: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE inventory_variants v
      LEFT JOIN (
        SELECT ps.variant_id, SUM(COALESCE(ps.last_seen, 0)) AS seen, SUM(COALESCE(l.available, 0)) AS pool
        FROM listing_push_state ps
        JOIN inventory_location_links k ON k.id = ps.location_link_id AND k.sync_enabled = 1
        JOIN inventory_variants vv ON vv.id = ps.variant_id
        LEFT JOIN inventory_levels l ON l.item_id = vv.item_id AND l.location_id = k.location_id
        WHERE ps.company_id = ${companyId}
        GROUP BY ps.variant_id
      ) x ON x.variant_id = v.id
      SET v.shopify_qty = COALESCE(x.seen, v.shopify_qty),
          v.local_qty = COALESCE(x.pool, v.local_qty)
      WHERE v.company_id = ${companyId} AND v.shopify_store_id = ${storeId} AND v.is_bundle = 0`;
  }

  // ── Woo stock mirror ─────────────────────────────────────────────────────

  private async syncWooStore(companyId: number, storeId: number, seed: boolean): Promise<void> {
    const rows = await this.woo.listInventoryCatalogue(companyId, storeId);
    const now = new Date();
    const seenVariants: number[] = [];
    const seenProducts = new Set<number>();
    const levels = new Map<string, LevelQty>();
    for (const r of rows) {
      const productGid = wooProductGid(storeId, r.productId);
      const product = await this.prisma.inventoryProduct.upsert({
        where: { company_id_shopify_store_id_shopify_product_gid: { company_id: companyId, shopify_store_id: storeId, shopify_product_gid: productGid } },
        create: {
          company_id: companyId, shopify_store_id: storeId, shopify_product_gid: productGid,
          title: r.productTitle.slice(0, 400), handle: r.handle, product_type: r.productType, image_url: r.image, status: r.status, synced_at: now,
        },
        update: { title: r.productTitle.slice(0, 400), handle: r.handle, product_type: r.productType, image_url: r.image, status: r.status, synced_at: now },
        select: { id: true },
      });
      seenProducts.add(product.id);
      const gid = wooListingGid(storeId, r.variationId ?? r.productId);
      const stock = r.manageStock ? r.stock ?? 0 : null;
      const existing = await this.prisma.inventoryVariant.findUnique({
        where: { company_id_shopify_store_id_shopify_variant_gid: { company_id: companyId, shopify_store_id: storeId, shopify_variant_gid: gid } },
        select: { id: true, price_push_status: true },
      });
      const keepPrice = existing?.price_push_status === 'pending' || existing?.price_push_status === 'error';
      const data = {
        product_id: product.id,
        provider: 'woocommerce',
        // the woo listing uses its own gid as the "inventory item" key
        shopify_inventory_item_gid: gid,
        sku: r.sku,
        variant_title: r.variantTitle,
        ...(keepPrice ? {} : { price: r.price, compare_at_price: r.compareAt }),
        shopify_qty: stock ?? 0,
        qty_synced_at: now,
      };
      const row = existing
        ? await this.prisma.inventoryVariant.update({ where: { id: existing.id }, data, select: { id: true } })
        : await this.prisma.inventoryVariant.create({
            data: { company_id: companyId, shopify_store_id: storeId, shopify_variant_gid: gid, local_qty: stock ?? 0, ...data },
            select: { id: true },
          });
      seenVariants.push(row.id);
      if (stock != null) levels.set(gid, { available: stock, committed: 0, incoming: 0 });
    }
    await this.prisma.inventoryVariant.deleteMany({
      where: { company_id: companyId, shopify_store_id: storeId, id: { notIn: seenVariants } },
    });
    await this.prisma.inventoryProduct.deleteMany({
      where: { company_id: companyId, shopify_store_id: storeId, id: { notIn: [...seenProducts] } },
    });
    await this.linkUnlinked(companyId);
    const link = await this.prisma.inventoryLocationLink.findFirst({
      where: { company_id: companyId, store_id: storeId, external_location_gid: 'default' },
    });
    if (link) await this.applyStoreLevels(companyId, storeId, link.id, link.location_id, levels, seed);
    await this.refreshLegacyMirror(companyId, storeId);
    this.ledger.emit(companyId, 'inventory.changed', { storeId, sync: true });
  }

  // ── Linking listings → master items ──────────────────────────────────────

  /** Link every unlinked listing: existing item by sku → barcode → title, else new items. */
  async linkUnlinked(companyId: number): Promise<number> {
    const unlinked = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, item_id: null },
      include: { product: { select: { title: true, image_url: true } } },
      orderBy: { id: 'asc' },
    });
    if (!unlinked.length) return 0;
    const items = await this.prisma.inventoryItem.findMany({
      where: { company_id: companyId, archived_at: null },
      select: { id: true, sku: true, barcode: true, title: true, variant_title: true, listings: { select: { shopify_store_id: true } } },
    });
    const bySku = new Map<string, (typeof items)[number]>();
    const byBarcode = new Map<string, (typeof items)[number]>();
    const byTitle = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      if (it.sku) bySku.set(it.sku, it);
      const bc = normBarcode(it.barcode);
      if (bc) byBarcode.set(bc, it);
      const tk = titleKey(it.title, it.variant_title);
      if (tk && !byTitle.has(tk)) byTitle.set(tk, it);
    }
    const storesOf = new Map(items.map((i) => [i.id, new Set(i.listings.map((l) => l.shopify_store_id))]));
    const leftovers: typeof unlinked = [];
    for (const v of unlinked) {
      const tries: Array<[LinkSource, (typeof items)[number] | undefined]> = [
        ['sku', normSku(v.sku) ? bySku.get(normSku(v.sku)!) : undefined],
        ['barcode', normBarcode(v.barcode) ? byBarcode.get(normBarcode(v.barcode)!) : undefined],
        ['title', byTitle.get(titleKey(v.product.title, v.variant_title) ?? '')],
      ];
      const hit = tries.find(([, it]) => it && !storesOf.get(it.id)?.has(v.shopify_store_id));
      if (hit) {
        const [source, it] = hit;
        await this.prisma.inventoryVariant.update({ where: { id: v.id }, data: { item_id: it!.id, link_source: source } });
        storesOf.get(it!.id)!.add(v.shopify_store_id);
        continue;
      }
      leftovers.push(v);
    }
    const groups = groupListings(
      leftovers.map((v) => ({
        id: v.id, storeId: v.shopify_store_id, sku: v.sku, barcode: v.barcode,
        title: v.product.title, variantTitle: v.variant_title, qty: v.local_qty,
      })),
    );
    const byId = new Map(leftovers.map((v) => [v.id, v]));
    for (const g of groups) {
      const ls = g.listingIds.map((id) => byId.get(id)!);
      const first = ls[0];
      const pick = <T>(f: (x: (typeof ls)[number]) => T | null | undefined): T | null =>
        ls.map(f).find((x) => x != null && x !== '') ?? null;
      const item = await this.prisma.inventoryItem.create({
        data: {
          company_id: companyId,
          sku: normSku(pick((x) => x.sku)),
          barcode: pick((x) => x.barcode),
          title: (first.product.title || first.variant_title || 'Untitled').slice(0, 400),
          variant_title: first.variant_title && first.variant_title !== 'Default Title' ? first.variant_title : null,
          image_url: pick((x) => x.product.image_url),
          item_code: pick((x) => x.item_code),
          alias: pick((x) => x.alias),
          category: pick((x) => x.category),
          shelf_location: pick((x) => x.shelf_location),
          reorder_level: Math.max(0, ...ls.map((x) => x.reorder_level ?? 0)),
          avg_cost: pick((x) => x.cost_price) ?? pick((x) => x.shopify_unit_cost),
          notes: pick((x) => x.notes),
          is_bundle: ls.some((x) => x.is_bundle),
        },
        select: { id: true },
      });
      await this.prisma.inventoryVariant.updateMany({
        where: { id: { in: g.listingIds } },
        data: { item_id: item.id, link_source: g.listingIds.length > 1 ? g.source : 'created' },
      });
    }
    await this.resolveBundleItems(companyId);
    return unlinked.length;
  }

  /** Map bundle listings' component variant gids → master item ids. */
  private async resolveBundleItems(companyId: number): Promise<void> {
    const bundles = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, is_bundle: true, item_id: { not: null } },
      select: { item_id: true, shopify_store_id: true, bundle_components: true },
    });
    for (const b of bundles) {
      const comps = Array.isArray(b.bundle_components) ? (b.bundle_components as Array<{ gid?: string; quantity?: number }>) : [];
      if (!comps.length) continue;
      const rows = await this.prisma.inventoryVariant.findMany({
        where: { company_id: companyId, shopify_store_id: b.shopify_store_id, shopify_variant_gid: { in: comps.map((c) => c.gid!).filter(Boolean) } },
        select: { shopify_variant_gid: true, item_id: true },
      });
      const map = new Map(rows.map((r) => [r.shopify_variant_gid, r.item_id]));
      const resolved = comps
        .map((c) => ({ itemId: map.get(c.gid ?? '') ?? null, quantity: Math.max(1, Number(c.quantity) || 1) }))
        .filter((c) => c.itemId);
      if (resolved.length === comps.length) {
        await this.prisma.inventoryItem.update({
          where: { id: b.item_id! },
          data: { is_bundle: true, bundle_components: resolved as Prisma.InputJsonValue },
        });
      }
    }
  }

  // ── Push the pool to every linked store ──────────────────────────────────

  /**
   * Make every listing of an item match the pool, at every linked store
   * location. Shopify: one inventorySetQuantities per store with
   * changeFromQuantity = what we last saw → a sale we haven't heard of yet is
   * detected, applied to the pool, and the push re-planned (never overwritten).
   */
  async pushItem(companyId: number, itemId: number, round = 0): Promise<void> {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id: itemId, company_id: companyId },
      include: {
        levels: true,
        listings: { include: { pushState: true, product: { select: { shopify_product_gid: true } } } },
      },
    });
    if (!item) return;
    // A bundle item: Shopify derives bundle stock itself — but components may
    // also be linked into OTHER stores, so push each component instead.
    if (item.is_bundle) {
      const comps = Array.isArray(item.bundle_components) ? (item.bundle_components as Array<{ itemId: number }>) : [];
      for (const c of comps) if (c.itemId) await this.ledger.queuePush(companyId, c.itemId);
      return;
    }
    const levels = new Map(item.levels.map((l) => [l.location_id, l.available]));
    const storeIds = [...new Set(item.listings.map((l) => l.shopify_store_id))];
    const links = await this.prisma.inventoryLocationLink.findMany({
      where: { company_id: companyId, store_id: { in: storeIds }, sync_enabled: true },
    });
    let changedExternally = false;
    for (const storeId of storeIds) {
      const storeLinks = links.filter((l) => l.store_id === storeId);
      const listings = item.listings.filter((l) => l.shopify_store_id === storeId && !l.is_bundle);
      const writes: Array<{ listing: (typeof listings)[number]; linkId: number; gid: string; target: number; expected: number | null }> = [];
      for (const lst of listings) {
        const stocked = new Set(lst.pushState.map((s) => s.location_link_id));
        const plan = planPush({
          levels,
          // only locations where the store actually stocks this item
          links: storeLinks.filter((k) => stocked.has(k.id)).map((k) => ({ linkId: k.id, locationId: k.location_id })),
          state: new Map(lst.pushState.map((s) => [s.location_link_id, { lastSeen: s.last_seen }])),
          track: item.track,
          isBundle: false,
        });
        for (const t of plan) {
          writes.push({ listing: lst, linkId: t.linkId, gid: storeLinks.find((k) => k.id === t.linkId)!.external_location_gid, target: t.target, expected: t.expected });
        }
      }
      if (!writes.length) continue;
      const provider = listings[0]?.provider ?? 'shopify';
      try {
        if (provider === 'woocommerce') {
          for (const w of writes) {
            const m = /^woo:\/\/\d+\/item\/(\d+)$/.exec(w.listing.shopify_variant_gid);
            const pm = /^woo:\/\/\d+\/product\/(\d+)$/.exec(w.listing.product?.shopify_product_gid ?? '');
            if (!m || !pm) continue;
            const variationId = Number(m[1]) === Number(pm[1]) ? null : Number(m[1]);
            await this.woo.setStock(companyId, storeId, Number(pm[1]), variationId, w.target);
            await this.markPushed(w.listing.id, w.linkId, w.target);
          }
        } else {
          const stale = await this.pushShopifyBatch(companyId, storeId, writes);
          if (stale) changedExternally = true;
        }
      } catch (err) {
        const msg = this.shopify.pushErrText(err);
        for (const w of writes) await this.markPushError(w.listing.id, w.linkId, msg);
        this.logger.warn(`pushItem ${itemId} store ${storeId}: ${msg}`);
      }
    }
    await this.refreshLegacyMirrorForItem(companyId, itemId);
    // A store had sold units we hadn't heard of: the pool moved → re-plan.
    if (changedExternally && round < 3) return this.pushItem(companyId, itemId, round + 1);
    // An edit made while this job ran (dedup swallowed its enqueue) → re-plan.
    if (round < 3) {
      const fresh = await this.prisma.inventoryLevel.findMany({ where: { item_id: itemId }, select: { location_id: true, available: true } });
      if (fresh.some((f) => levels.get(f.location_id) !== f.available)) return this.pushItem(companyId, itemId, round + 1);
    }
  }

  /** Returns true when a store value had moved (stale compare) and was absorbed. */
  private async pushShopifyBatch(
    companyId: number,
    storeId: number,
    writes: Array<{ listing: { id: number; item_id: number | null; shopify_inventory_item_gid: string | null }; linkId: number; gid: string; target: number; expected: number | null }>,
  ): Promise<boolean> {
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const valid = writes.filter((w) => w.listing.shopify_inventory_item_gid);
    // Unknown "expected" → read the live value first (Shopify requires changeFromQuantity).
    const live = await this.readLive(api, storeId, valid.map((w) => ({ item: w.listing.shopify_inventory_item_gid!, loc: w.gid })));
    let absorbed = false;
    for (const w of valid) {
      const cur = live.get(`${w.listing.shopify_inventory_item_gid}|${w.gid}`);
      if (cur == null) continue;
      if (w.expected != null && cur !== w.expected && w.listing.item_id) {
        // The store moved since we last looked (a sale in flight) → absorb it
        // into the pool first; the caller re-plans.
        const locId = (await this.prisma.inventoryLocationLink.findUnique({ where: { id: w.linkId }, select: { location_id: true } }))?.location_id;
        await this.prisma.listingPushState.update({
          where: { variant_id_location_link_id: { variant_id: w.listing.id, location_link_id: w.linkId } },
          data: { last_seen: cur },
        });
        if (locId) {
          await this.ledger.apply(
            companyId,
            [{ itemId: w.listing.item_id, locationId: locId, delta: cur - w.expected, variantId: w.listing.id }],
            { reason: reasonForStoreDelta(cur - w.expected), refType: 'webhook', note: 'Detected while pushing' },
            { push: false },
          );
        }
        absorbed = true;
      }
      w.expected = cur;
    }
    if (absorbed) return true;
    const quantities = valid
      .filter((w) => w.expected != null && w.expected !== w.target)
      .map((w) => ({ inventoryItemId: w.listing.shopify_inventory_item_gid!, locationId: w.gid, quantity: w.target, changeFromQuantity: w.expected }));
    for (const w of valid) if (w.expected === w.target) await this.markPushed(w.listing.id, w.linkId, w.target);
    if (!quantities.length) return false;
    for (let i = 0; i < quantities.length; i += 200) {
      const chunk = quantities.slice(i, i + 200);
      const res = await this.gql<{
        data?: { inventorySetQuantities?: { userErrors: Array<{ message: string; code?: string | null }> } };
        errors?: Array<{ message: string }>;
      }>(api, storeId, `mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") { userErrors { field message code } }
      }`, { input: { name: 'available', reason: 'correction', quantities: chunk } });
      const ue = res.data?.inventorySetQuantities?.userErrors ?? [];
      if (ue.length || res.errors?.length) {
        const msg = ue.map((e) => e.message).join('; ') || (res.errors ?? []).map((e) => e.message).join('; ');
        if (ue.some((e) => /CHANGE_FROM|stale|compare/i.test(`${e.code ?? ''} ${e.message}`))) return true; // re-plan
        throw new Error(`Shopify rejected the stock update: ${msg}.${this.shopify.scopeHint(msg, 'write_inventory')}`);
      }
    }
    for (const w of valid) if (w.expected !== w.target) await this.markPushed(w.listing.id, w.linkId, w.target);
    return false;
  }

  private async readLive(api: Api, storeId: number, pairs: Array<{ item: string; loc: string }>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const p of pairs) {
      try {
        const r = await this.gql<{
          data?: { inventoryItem?: { inventoryLevel?: { quantities?: Array<{ name: string; quantity: number }> } | null } | null };
        }>(api, storeId, `query($id: ID!, $loc: ID!) {
          inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } }
        }`, { id: p.item, loc: p.loc });
        const q = r.data?.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === 'available');
        if (q) out.set(`${p.item}|${p.loc}`, q.quantity);
      } catch {
        /* leave unknown → skipped this round */
      }
    }
    return out;
  }

  private async markPushed(variantId: number, linkId: number, value: number): Promise<void> {
    await this.prisma.listingPushState.update({
      where: { variant_id_location_link_id: { variant_id: variantId, location_link_id: linkId } },
      data: { last_seen: value, last_pushed: value, pushed_at: new Date(), status: 'ok', error: null },
    });
    await this.prisma.inventoryVariant.update({
      where: { id: variantId },
      data: { qty_push_status: 'ok', qty_push_error: null, last_pushed_at: new Date() },
    });
  }

  private async markPushError(variantId: number, linkId: number, msg: string): Promise<void> {
    await this.prisma.listingPushState
      .update({
        where: { variant_id_location_link_id: { variant_id: variantId, location_link_id: linkId } },
        data: { status: 'error', error: msg.slice(0, 500) },
      })
      .catch(() => undefined);
    await this.prisma.inventoryVariant
      .update({ where: { id: variantId }, data: { qty_push_status: 'error', qty_push_error: msg.slice(0, 500) } })
      .catch(() => undefined);
  }

  private async refreshLegacyMirrorForItem(companyId: number, itemId: number): Promise<void> {
    const stores = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, item_id: itemId },
      select: { shopify_store_id: true },
      distinct: ['shopify_store_id'],
    });
    for (const s of stores) await this.refreshLegacyMirror(companyId, s.shopify_store_id);
  }

  // ── Store webhooks ───────────────────────────────────────────────────────

  async onLevelWebhook(job: Extract<InventoryJob, { kind: 'levelWebhook' }>): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: job.companyId }, select: { inventory_v2_at: true } });
    if (!company?.inventory_v2_at) {
      await this.enqueue({ kind: 'bootstrap', companyId: job.companyId }, `inv2-boot:${job.companyId}`);
      return;
    }
    const listing = await this.prisma.inventoryVariant.findFirst({
      where: { company_id: job.companyId, shopify_store_id: job.storeId, shopify_inventory_item_id: BigInt(job.inventoryItemId) },
      select: { id: true, item_id: true, is_bundle: true, item: { select: { track: true } } },
    });
    if (!listing || listing.is_bundle) return;
    let link = await this.prisma.inventoryLocationLink.findFirst({
      where: { company_id: job.companyId, store_id: job.storeId, external_location_gid: job.locationGid },
    });
    if (!link) {
      await this.ensureLocations(job.companyId, job.storeId).catch(() => undefined);
      link = await this.prisma.inventoryLocationLink.findFirst({
        where: { company_id: job.companyId, store_id: job.storeId, external_location_gid: job.locationGid },
      });
    }
    if (!link || !link.sync_enabled) return;
    const st = await this.prisma.listingPushState.findUnique({
      where: { variant_id_location_link_id: { variant_id: listing.id, location_link_id: link.id } },
    });
    const verdict = interpretWebhook(st?.last_seen ?? null, job.available);
    await this.prisma.listingPushState.upsert({
      where: { variant_id_location_link_id: { variant_id: listing.id, location_link_id: link.id } },
      create: { company_id: job.companyId, variant_id: listing.id, location_link_id: link.id, last_seen: job.available, status: 'ok' },
      update: { last_seen: job.available },
    });
    await this.prisma.inventoryVariant.update({ where: { id: listing.id }, data: { qty_synced_at: new Date() } });
    if (!listing.item_id || listing.item?.track === false) return;
    if (verdict.kind === 'echo') return;
    if (verdict.kind === 'first') {
      const lvl = await this.prisma.inventoryLevel.findUnique({
        where: { item_id_location_id: { item_id: listing.item_id, location_id: link.location_id } },
      });
      if (!lvl) {
        await this.ledger.apply(
          job.companyId,
          [{ itemId: listing.item_id, locationId: link.location_id, delta: job.available, variantId: listing.id }],
          { reason: 'bootstrap', refType: 'webhook', note: 'First stock seen for this location' },
          { push: false },
        );
      } else {
        // first time this store location is tracked: make it match the pool
        await this.ledger.queuePush(job.companyId, listing.item_id);
      }
      return;
    }
    await this.ledger.apply(
      job.companyId,
      [{ itemId: listing.item_id, locationId: link.location_id, delta: verdict.delta, variantId: listing.id }],
      {
        reason: reasonForStoreDelta(verdict.delta),
        refType: 'webhook',
        idemKey: `wh:${job.storeId}:${job.inventoryItemId}:${link.id}:${job.at ?? job.available}`,
      },
    );
  }

  async onProductWebhook(
    companyId: number,
    storeId: number,
    productGid: string,
    deleted: boolean,
    /** variant gid (or sku) → master item id, for products CodesApp just created */
    preLink?: Map<string, number>,
  ): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_v2_at: true } });
    if (!company?.inventory_v2_at && !preLink) return;
    if (deleted) {
      const p = await this.prisma.inventoryProduct.findUnique({
        where: { company_id_shopify_store_id_shopify_product_gid: { company_id: companyId, shopify_store_id: storeId, shopify_product_gid: productGid } },
        select: { id: true },
      });
      if (p) {
        await this.prisma.inventoryVariant.deleteMany({ where: { company_id: companyId, product_id: p.id } });
        await this.prisma.inventoryProduct.delete({ where: { id: p.id } }).catch(() => undefined);
      }
      this.ledger.emit(companyId, 'inventory.changed', { storeId, productDeleted: true });
      return;
    }
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const r = await this.gql<{ data?: { product?: ProductNode | null } }>(api, storeId, `query($id: ID!) {
      product(id: $id) { ${PRODUCT_FIELDS}
        variants(first: 100) { pageInfo { hasNextPage endCursor } edges { node { ${VARIANT_FIELDS} } } }
      }
    }`, { id: productGid });
    const node = r.data?.product;
    if (!node) return;
    if (node.variants.pageInfo?.hasNextPage) await this.loadMoreVariants(api, storeId, node);
    const ids = await this.upsertProductNode(companyId, storeId, new Date(), node);
    // drop variants removed from the product
    await this.prisma.inventoryVariant.deleteMany({
      where: { company_id: companyId, product_id: ids.productId, id: { notIn: ids.variantIds } },
    });
    if (preLink?.size) {
      const rows = await this.prisma.inventoryVariant.findMany({
        where: { id: { in: ids.variantIds }, item_id: null },
        select: { id: true, shopify_variant_gid: true, sku: true },
      });
      for (const r of rows) {
        const itemId = preLink.get(r.shopify_variant_gid) ?? (r.sku ? preLink.get(`sku:${r.sku.trim().toLowerCase()}`) : undefined);
        if (itemId) await this.prisma.inventoryVariant.update({ where: { id: r.id }, data: { item_id: itemId, link_source: 'created' } });
      }
    }
    await this.linkUnlinked(companyId);
    // stock for any listing we don't track yet at its locations
    const links = await this.prisma.inventoryLocationLink.findMany({ where: { company_id: companyId, store_id: storeId, sync_enabled: true } });
    const fresh = await this.prisma.inventoryVariant.findMany({
      where: { id: { in: ids.variantIds } },
      select: { id: true, shopify_inventory_item_gid: true, pushState: { select: { id: true } } },
    });
    const missing = fresh.filter((f) => !f.pushState.length && f.shopify_inventory_item_gid);
    if (missing.length) {
      for (const link of links) {
        const live = await this.readLive(api, storeId, missing.map((m) => ({ item: m.shopify_inventory_item_gid!, loc: link.external_location_gid })));
        const lv = new Map<string, LevelQty>();
        for (const m of missing) {
          const v = live.get(`${m.shopify_inventory_item_gid}|${link.external_location_gid}`);
          if (v != null) lv.set(m.shopify_inventory_item_gid!, { available: v, committed: 0, incoming: 0 });
        }
        if (lv.size) await this.applyStoreLevels(companyId, storeId, link.id, link.location_id, lv, false);
      }
    }
    this.ledger.emit(companyId, 'inventory.changed', { storeId, productGid });
  }

  // ── Returns ──────────────────────────────────────────────────────────────

  /**
   * Physically received RTO parcel → its units go back on the shelf, once.
   * The parcel's order lines map to listings → master items → the store's
   * default location (bundles expand to components inside the ledger).
   */
  async restockReturn(companyId: number, shipmentId: number): Promise<void> {
    if (!(await this.shopify.ownsReturnRestock(companyId))) return;
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { inventory_v2_at: true } });
    if (!company?.inventory_v2_at) {
      // not bootstrapped yet → legacy listing-level restock
      await this.shopify.restockFromShipment(companyId, shipmentId);
      return;
    }
    const ref = `return:${shipmentId}`;
    const legacy = await this.prisma.inventoryMovement.findFirst({
      where: { company_id: companyId, reason: 'return_restock', ref },
      select: { id: true },
    });
    if (legacy) return;
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
      select: { shopify_order_gid: true, shopify_store_id: true },
    });
    if (!shipment) return;
    const orderGid = shipment.shopify_order_gid.replace(/#R\d+$/, '');
    const order = await this.prisma.shopifyOrder.findFirst({
      where: { company_id: companyId, shopify_order_gid: orderGid },
      select: { line_items: true, shopify_store_id: true },
    });
    const storeId = order?.shopify_store_id ?? shipment.shopify_store_id ?? null;
    const lines = Array.isArray(order?.line_items)
      ? (order!.line_items as Array<{ variantId?: string | null; quantity?: number; currentQuantity?: number }>)
      : [];
    const locationId = await this.defaultLocationForStore(companyId, storeId);
    if (!locationId) return;
    const ledgerLines: Array<{ itemId: number; locationId: number; delta: number; variantId: number }> = [];
    for (const li of lines) {
      if (!li.variantId) continue;
      const qty = Number(li.currentQuantity ?? li.quantity ?? 1);
      if (!(qty > 0)) continue;
      const gid = /^\d+$/.test(String(li.variantId)) && storeId ? wooListingGid(storeId, li.variantId) : li.variantId;
      const v = await this.prisma.inventoryVariant.findFirst({
        where: { company_id: companyId, shopify_variant_gid: gid, ...(storeId ? { shopify_store_id: storeId } : {}) },
        select: { id: true, item_id: true },
      });
      if (!v?.item_id) continue;
      ledgerLines.push({ itemId: v.item_id, locationId, delta: qty, variantId: v.id });
    }
    if (!ledgerLines.length) return;
    await this.ledger.apply(companyId, ledgerLines, { reason: 'return', ref, refType: 'return', idemKey: ref });
  }

  // ── Product status (Active / Unlisted / Draft / Archived) ─────────────────

  async pushProductStatus(companyId: number, productId: number): Promise<void> {
    const p = await this.prisma.inventoryProduct.findFirst({ where: { id: productId, company_id: companyId } });
    if (!p?.status) return;
    const status = p.status as 'active' | 'draft' | 'archived' | 'unlisted';
    const store = await this.prisma.shopifyStore.findFirst({ where: { id: p.shopify_store_id, company_id: companyId } });
    if (!store) return;
    try {
      if (store.provider === 'woocommerce') {
        const m = /^woo:\/\/\d+\/product\/(\d+)$/.exec(p.shopify_product_gid);
        if (m) await this.woo.setProductStatus(companyId, store.id, Number(m[1]), status);
      } else {
        await this.setShopifyStatus(companyId, store.id, p.shopify_product_gid, status);
      }
      await this.prisma.inventoryProduct.update({ where: { id: p.id }, data: { status_push_status: 'ok', status_push_error: null } });
    } catch (err) {
      await this.prisma.inventoryProduct.update({
        where: { id: p.id },
        data: { status_push_status: 'error', status_push_error: this.shopify.pushErrText(err) },
      });
      throw err;
    }
    this.ledger.emit(companyId, 'inventory.changed', { productId: p.id, status });
  }

  private async setShopifyStatus(
    companyId: number,
    storeId: number,
    productGid: string,
    status: 'active' | 'draft' | 'archived' | 'unlisted',
  ): Promise<void> {
    const api = await this.shopify.requireAdminApi(companyId, storeId);
    const update = async (s: string) =>
      this.gql<{ data?: { productUpdate?: { userErrors: Array<{ message: string }> } }; errors?: Array<{ message: string }> }>(
        api,
        storeId,
        `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
        { product: { id: productGid, status: s } },
      );
    const errOf = (r: { data?: { productUpdate?: { userErrors: Array<{ message: string }> } }; errors?: Array<{ message: string }> }) =>
      [...(r.errors ?? []).map((e) => e.message), ...(r.data?.productUpdate?.userErrors ?? []).map((e) => e.message)].join('; ');
    if (status !== 'unlisted') {
      const r = await update(status.toUpperCase());
      const e = errOf(r);
      if (e) throw new Error(`Shopify rejected the status change: ${e}.${this.shopify.scopeHint(e, 'write_products')}`);
      if (status === 'active') await this.setOnlineStorePublished(api, storeId, productGid, true).catch(() => undefined);
      return;
    }
    // Unlisted: newer API versions have the UNLISTED status; older ones need
    // Active + removed from the Online Store sales channel (still buyable by link).
    const r = await update('UNLISTED');
    if (!errOf(r)) return;
    const r2 = await update('ACTIVE');
    const e2 = errOf(r2);
    if (e2) throw new Error(`Shopify rejected the status change: ${e2}.`);
    await this.setOnlineStorePublished(api, storeId, productGid, false);
  }

  private async setOnlineStorePublished(api: Api, storeId: number, productGid: string, publish: boolean): Promise<void> {
    const pubs = await this.gql<{ data?: { publications?: { edges: Array<{ node: { id: string; name: string } }> } }; errors?: Array<{ message: string }> }>(
      api,
      storeId,
      `query { publications(first: 25) { edges { node { id name } } } }`,
      {},
    );
    if (pubs.errors?.length) throw new Error(`Sales channels unavailable: ${pubs.errors.map((e) => e.message).join('; ')}. The token needs read_publications + write_publications.`);
    const online = pubs.data?.publications?.edges.find((e) => /online store/i.test(e.node.name))?.node.id;
    if (!online) return;
    const m = publish ? 'publishablePublish' : 'publishableUnpublish';
    const r = await this.gql<{ data?: Record<string, { userErrors: Array<{ message: string }> }> }>(
      api,
      storeId,
      `mutation($id: ID!, $input: [PublicationInput!]!) { ${m}(id: $id, input: $input) { userErrors { field message } } }`,
      { id: productGid, input: [{ publicationId: online }] },
    );
    const ue = r.data?.[m]?.userErrors ?? [];
    if (ue.length) throw new Error(`Could not change the Online Store listing: ${ue.map((e) => e.message).join('; ')}.`);
  }

  // ── Cost (item avg cost → every listing's cost-per-item) ─────────────────

  private async pushItemCost(companyId: number, itemId: number): Promise<void> {
    const item = await this.prisma.inventoryItem.findFirst({ where: { id: itemId, company_id: companyId }, select: { avg_cost: true } });
    if (item?.avg_cost == null) return;
    const listings = await this.prisma.inventoryVariant.findMany({
      where: { company_id: companyId, item_id: itemId, provider: 'shopify' },
      select: { id: true },
    });
    for (const l of listings) {
      await this.prisma.inventoryVariant.update({ where: { id: l.id }, data: { cost_price: item.avg_cost } });
      await this.shopify.pushVariantCost(companyId, l.id).catch((e) =>
        this.logger.warn(`cost push listing ${l.id}: ${(e as Error).message}`),
      );
    }
  }
}
