"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ShopifyService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyService = exports.SHOPIFY_ORDER_FIELDS = exports.SHOPIFY_API_VERSIONS = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const https = require("https");
const prisma_service_1 = require("../../../prisma/prisma.service");
const encryption_service_1 = require("../../../common/services/encryption.service");
const job_queue_service_1 = require("../../../common/services/job-queue.service");
const usage_metering_service_1 = require("../../usage-metering/usage-metering.service");
const inbox_service_1 = require("../../inbox/inbox.service");
const send_message_dto_1 = require("../../inbox/dto/send-message.dto");
const ai_knowledge_service_1 = require("../../ai/ai-knowledge.service");
const ai_rag_service_1 = require("../../ai/ai-rag.service");
const NO_WHATSAPP_TAG = '⚠ NO WhatsApp';
exports.SHOPIFY_API_VERSIONS = [
    '2026-04',
    '2026-01',
    '2025-10',
    '2025-07',
    '2025-04',
    '2025-01',
    '2024-10',
];
const DEFAULT_SHOPIFY_API_VERSION = exports.SHOPIFY_API_VERSIONS[0];
const DEFAULT_COUNTRY_CODE = '92';
const SHOPIFY_TIMEOUT_MS = 10_000;
exports.SHOPIFY_ORDER_FIELDS = [
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
const SHOPIFY_ORDER_FIELD_KEYS = new Set(exports.SHOPIFY_ORDER_FIELDS.map((f) => f.key));
let ShopifyService = ShopifyService_1 = class ShopifyService {
    constructor(prisma, config, encryption, jobQueue, metering, inbox, aiKnowledge, rag) {
        this.prisma = prisma;
        this.config = config;
        this.encryption = encryption;
        this.jobQueue = jobQueue;
        this.metering = metering;
        this.inbox = inbox;
        this.aiKnowledge = aiKnowledge;
        this.rag = rag;
        this.logger = new common_1.Logger(ShopifyService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('shopify', (p) => this.processJob(p), 3);
        this.logger.log('Registered shopify worker (concurrency=3)');
    }
    async processJob(job) {
        if (job.kind === 'send') {
            await this.processOrderSend(job.companyId, job.shopDomain, job.order);
        }
        else if (job.kind === 'tag') {
            await this.processOrderTag(job.companyId, job.orderMessageId, job.decision);
        }
        else if (job.kind === 'pendingTag') {
            await this.processPendingTag(job.companyId, job.orderMessageId);
        }
        else if (job.kind === 'noWhatsapp') {
            await this.processNoWhatsappTag(job.companyId, job.orderMessageId);
        }
        else if (job.kind === 'syncKnowledge') {
            const res = await this.syncKnowledge(job.companyId);
            this.logger.log(`KB sync (company ${job.companyId}): ${res.products} products, ${res.policies} policies, mode=${res.mode}`);
        }
    }
    async setAdminToken(companyId, token) {
        if (this.encryption.isUsingPlaceholderKey()) {
            throw new common_1.ServiceUnavailableException('Server encryption key is not configured — refusing to store secrets.');
        }
        const trimmed = token.trim();
        if (trimmed.length < 8) {
            throw new common_1.BadRequestException('Admin API token looks too short');
        }
        await this.prisma.company.update({
            where: { id: companyId },
            data: {
                shopify_admin_token_encrypted: this.encryption.encrypt(trimmed),
            },
        });
        return { adminTokenSet: true };
    }
    extractOrderValue(order, key) {
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
    normalizePhone(raw) {
        let d = (raw || '').replace(/\D/g, '');
        const cc = DEFAULT_COUNTRY_CODE;
        if (!d)
            return '';
        if (d.startsWith('00'))
            d = d.slice(2);
        if (d.startsWith('0'))
            d = cc + d.slice(1);
        else if (!d.startsWith(cc) && d.length <= 11)
            d = cc + d;
        return d;
    }
    orderPhone(order) {
        const raw = order.customer?.phone ||
            order.phone ||
            order.shipping_address?.phone ||
            order.billing_address?.phone ||
            '';
        return this.normalizePhone(raw);
    }
    isPaidOrder(order) {
        if ((order.financial_status ?? '').toLowerCase() === 'paid')
            return true;
        if (order.total_outstanding != null &&
            order.total_outstanding !== '' &&
            Number(order.total_outstanding) === 0) {
            return true;
        }
        return false;
    }
    async processOrderSend(companyId, shopDomain, order) {
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        if (!cfg || !cfg.enabled || !cfg.template_id) {
            this.logger.log(`Shopify order send skipped for company ${companyId} (config disabled/incomplete)`);
            return;
        }
        if (this.isPaidOrder(order)) {
            this.logger.log(`Shopify order ${order.name ?? order.id} (company ${companyId}) already paid — no confirmation sent`);
            return;
        }
        const phone = this.orderPhone(order);
        if (!phone) {
            this.logger.warn(`Shopify order ${order.name ?? order.id} (company ${companyId}) has no customer phone — skipped`);
            return;
        }
        const map = cfg.variable_map ?? {};
        const variables = {};
        for (const [slot, fieldKey] of Object.entries(map)) {
            variables[slot] = this.extractOrderValue(order, fieldKey);
        }
        const name = [order.customer?.first_name, order.customer?.last_name]
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
        }
        else if (email && !contact.email) {
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
        const message = (await this.inbox.sendMessage(companyId, convo.id, {
            type: send_message_dto_1.SendMessageType.template,
            templateId: cfg.template_id,
            variables,
        }));
        await this.prisma.shopifyOrderMessage.create({
            data: {
                company_id: companyId,
                message_id: message.id,
                conversation_id: convo.id,
                shopify_order_gid: order.admin_graphql_api_id ??
                    (order.id != null ? `gid://shopify/Order/${order.id}` : ''),
                shop_domain: shopDomain,
                status: 'pending',
            },
        });
        const windowMin = cfg.decision_window_minutes && cfg.decision_window_minutes > 0
            ? cfg.decision_window_minutes
            : 2;
        const link = await this.prisma.shopifyOrderMessage.findFirst({
            where: { message_id: message.id, company_id: companyId },
            select: { id: true },
        });
        if (link) {
            await this.jobQueue.enqueue('shopify', { kind: 'pendingTag', companyId, orderMessageId: link.id }, { delayMs: windowMin * 60_000 });
        }
        this.logger.log(`Shopify order ${order.name ?? order.id}: confirmation template sent (company ${companyId}, msg ${message.id})`);
    }
    async resolveShopifyApi(companyId, rowShopDomain, cfg) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { shopify_admin_token_encrypted: true },
        });
        if (!company?.shopify_admin_token_encrypted) {
            this.logger.warn(`Cannot tag Shopify order (company ${companyId}): no Admin API token configured`);
            return null;
        }
        let token;
        try {
            token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
        }
        catch {
            this.logger.error(`Cannot decrypt Shopify Admin token for company ${companyId}`);
            return null;
        }
        const shopDomain = (rowShopDomain || cfg?.shop_domain || '')
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .trim();
        if (!shopDomain) {
            this.logger.warn(`Cannot tag Shopify order (company ${companyId}): no store domain (set it in Settings → Shopify)`);
            return null;
        }
        const apiVersion = cfg?.api_version && exports.SHOPIFY_API_VERSIONS.includes(cfg.api_version)
            ? cfg.api_version
            : DEFAULT_SHOPIFY_API_VERSION;
        return { token, shopDomain, apiVersion };
    }
    async shopifyTagMutate(api, orderGid, addTags, removeTags) {
        const add = addTags.filter(Boolean);
        const rem = removeTags.filter(Boolean);
        let removeOk = true;
        let addOk = true;
        if (rem.length) {
            removeOk = await this.runTagOp(api, 'tagsRemove', orderGid, rem);
            if (!removeOk) {
                this.logger.warn(`Shopify tagsRemove did not complete for ${orderGid} — tags ${JSON.stringify(rem)} may remain; proceeding with add`);
            }
        }
        if (add.length) {
            addOk = await this.runTagOp(api, 'tagsAdd', orderGid, add);
        }
        return { removeOk, addOk };
    }
    async runTagOp(api, op, orderGid, tags) {
        const query = `mutation($id: ID!, $tags: [String!]!) {
      ${op}(id: $id, tags: $tags) { userErrors { message } }
    }`;
        try {
            const res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, query, {
                id: orderGid,
                tags,
            });
            const ue = res?.data?.[op]?.userErrors ?? [];
            if (res?.errors?.length || ue.length) {
                this.logger.warn(`Shopify ${op} errors for ${orderGid} tags=${JSON.stringify(tags)}: ${JSON.stringify(res.errors ?? ue)}`);
                return false;
            }
            return true;
        }
        catch (err) {
            this.logger.warn(`Shopify ${op} failed for ${orderGid} tags=${JSON.stringify(tags)}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    ourTags(cfg) {
        return {
            confirm: cfg?.confirm_tag || 'confirmed',
            cancel: cfg?.cancel_tag || 'cancelled',
            pending: cfg?.pending_tag || 'confirmation pending',
        };
    }
    async processOrderTag(companyId, orderMessageId, decision) {
        const row = await this.prisma.shopifyOrderMessage.findFirst({
            where: { id: orderMessageId, company_id: companyId },
        });
        if (!row)
            return;
        const targetStatus = decision === 'confirm' ? 'confirmed' : 'cancelled';
        if (row.status === targetStatus)
            return;
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        const tags = this.ourTags(cfg);
        const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
        if (!api)
            return;
        const chosen = decision === 'confirm' ? tags.confirm : tags.cancel;
        const opposite = decision === 'confirm' ? tags.cancel : tags.confirm;
        const { removeOk, addOk } = await this.shopifyTagMutate(api, row.shopify_order_gid, [chosen], [tags.pending, opposite]);
        if (!addOk)
            return;
        if (!removeOk) {
            this.logger.warn(`Shopify order ${row.shopify_order_gid}: old tags [${tags.pending}, ${opposite}] may still be present (remove failed); decision "${chosen}" was applied`);
        }
        await this.prisma.shopifyOrderMessage.update({
            where: { id: row.id },
            data: { status: targetStatus },
        });
        this.logger.log(`Shopify order ${row.shopify_order_gid} → "${chosen}" (company ${companyId})`);
    }
    async processPendingTag(companyId, orderMessageId) {
        const row = await this.prisma.shopifyOrderMessage.findFirst({
            where: { id: orderMessageId, company_id: companyId },
        });
        if (!row || row.status !== 'pending')
            return;
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        const tags = this.ourTags(cfg);
        const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
        if (!api)
            return;
        const { addOk } = await this.shopifyTagMutate(api, row.shopify_order_gid, [tags.pending], []);
        if (addOk) {
            this.logger.log(`Shopify order ${row.shopify_order_gid} → "${tags.pending}" (no answer in window, company ${companyId})`);
        }
    }
    async processNoWhatsappTag(companyId, orderMessageId) {
        const row = await this.prisma.shopifyOrderMessage.findFirst({
            where: { id: orderMessageId, company_id: companyId },
        });
        if (!row)
            return;
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        const api = await this.resolveShopifyApi(companyId, row.shop_domain, cfg);
        if (!api)
            return;
        const { addOk } = await this.shopifyTagMutate(api, row.shopify_order_gid, [NO_WHATSAPP_TAG], []);
        if (addOk) {
            await this.prisma.shopifyOrderMessage.update({
                where: { id: row.id },
                data: { status: 'undeliverable' },
            });
            this.logger.log(`Shopify order ${row.shopify_order_gid} → "${NO_WHATSAPP_TAG}" (undeliverable, company ${companyId})`);
        }
    }
    async requireAdminApi(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { shopify_admin_token_encrypted: true },
        });
        if (!company?.shopify_admin_token_encrypted) {
            throw new common_1.BadRequestException('No Shopify Admin API token configured. Add it in Settings → Shopify.');
        }
        let token;
        try {
            token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
        }
        catch {
            throw new common_1.ServiceUnavailableException('Cannot decrypt the Shopify Admin token.');
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
            throw new common_1.BadRequestException('No Shopify store domain set. Add it in Settings → Shopify.');
        }
        const apiVersion = cfg?.api_version && exports.SHOPIFY_API_VERSIONS.includes(cfg.api_version)
            ? cfg.api_version
            : DEFAULT_SHOPIFY_API_VERSION;
        return { token, shopDomain, apiVersion };
    }
    async searchProducts(companyId, query) {
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
            edges { node { id title price sku availableForSale } }
          }
        } }
      }
    }`;
        let res;
        try {
            res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { q: q || undefined });
        }
        catch (err) {
            this.logger.warn(`Shopify product search failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('Could not reach Shopify to search products.');
        }
        if (res?.errors?.length) {
            throw new common_1.BadRequestException(`Shopify could not return products (${res.errors
                .map((e) => e.message)
                .join('; ')}). Make sure the Admin token has the read_products scope.`);
        }
        const out = [];
        for (const p of res?.data?.products?.edges ?? []) {
            const image = p.node.featuredImage?.url ?? null;
            const productUrl = p.node.onlineStoreUrl ??
                (p.node.handle
                    ? `https://${api.shopDomain}/products/${p.node.handle}`
                    : null);
            for (const v of p.node.variants.edges) {
                out.push({
                    variantId: v.node.id,
                    productTitle: p.node.title,
                    variantTitle: v.node.title === 'Default Title' ? '' : v.node.title,
                    price: v.node.price,
                    sku: v.node.sku || null,
                    image,
                    productUrl,
                    available: v.node.availableForSale,
                });
            }
        }
        return out;
    }
    async getOrderStatus(companyId, orderNumber) {
        const digits = (orderNumber || '').replace(/[^0-9]/g, '');
        if (!digits)
            return { found: false };
        let api;
        try {
            api = await this.requireAdminApi(companyId);
        }
        catch {
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
            const res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, {
                q: `name:#${digits}`,
            });
            if (res?.errors?.length) {
                this.logger.warn(`Shopify order status errors (company ${companyId}): ${res.errors
                    .map((e) => e.message)
                    .join('; ')}`);
                return { found: false, error: true };
            }
            const node = res?.data?.orders?.edges?.[0]?.node;
            if (!node)
                return { found: false };
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
        }
        catch (err) {
            this.logger.warn(`Shopify order status lookup failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            return { found: false, error: true };
        }
    }
    async requestKnowledgeSync(companyId) {
        await this.requireAdminApi(companyId);
        await this.jobQueue.enqueue('shopify', { kind: 'syncKnowledge', companyId });
        return { started: true };
    }
    knowledgeStatus(companyId) {
        return this.rag.status(companyId);
    }
    async syncKnowledge(companyId) {
        const api = await this.requireAdminApi(companyId);
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
        let shopName = '';
        let currency = '';
        const nodes = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            let res;
            try {
                res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { cursor });
            }
            catch (err) {
                this.logger.warn(`Shopify KB sync failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
                throw new common_1.ServiceUnavailableException('Could not reach Shopify to sync products.');
            }
            if (res?.errors?.length) {
                throw new common_1.BadRequestException(`Shopify could not return products (${res.errors
                    .map((e) => e.message)
                    .join('; ')}). Make sure the Admin token has the read_products scope.`);
            }
            if (res.data?.shop) {
                shopName = res.data.shop.name;
                currency = res.data.shop.currencyCode;
            }
            const conn = res.data?.products;
            for (const e of conn?.edges ?? [])
                nodes.push(e.node);
            if (!conn?.pageInfo.hasNextPage)
                break;
            cursor = conn.pageInfo.endCursor;
        }
        const stripHtml = (s) => (s || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        const richTextToPlain = (raw) => {
            try {
                const doc = JSON.parse(raw);
                const out = [];
                const walk = (n) => {
                    if (!n)
                        return;
                    if (Array.isArray(n)) {
                        n.forEach(walk);
                        return;
                    }
                    if (typeof n === 'object') {
                        const o = n;
                        if (typeof o.value === 'string')
                            out.push(o.value);
                        if (Array.isArray(o.children))
                            o.children.forEach(walk);
                    }
                };
                walk(doc);
                return out.join(' ').replace(/\s+/g, ' ').trim();
            }
            catch {
                return '';
            }
        };
        const formatMetafields = (mfs) => {
            if (!mfs?.length)
                return '';
            const parts = [];
            for (const m of mfs) {
                const type = (m.type || '').toLowerCase();
                let val = (m.value ?? '').toString().trim();
                if (!val)
                    continue;
                if (type === 'rich_text_field') {
                    val = richTextToPlain(val);
                }
                else if (type.startsWith('list.') && type.includes('text')) {
                    try {
                        const arr = JSON.parse(val);
                        if (Array.isArray(arr)) {
                            val = arr.filter((x) => typeof x === 'string').join(', ');
                        }
                    }
                    catch {
                    }
                }
                else if (!(type.includes('text') ||
                    type.startsWith('number') ||
                    type === 'boolean' ||
                    type === 'rating' ||
                    type === 'dimension' ||
                    type === 'weight' ||
                    type === 'volume' ||
                    type === 'date' ||
                    type === 'date_time' ||
                    type === 'url' ||
                    type === '')) {
                    continue;
                }
                if (val.startsWith('{')) {
                    try {
                        const o = JSON.parse(val);
                        if (o && typeof o === 'object') {
                            val = [o.value, o.unit].filter((x) => x != null).join(' ').trim();
                        }
                    }
                    catch {
                    }
                }
                if (!val)
                    continue;
                if (val.length > 600)
                    val = val.slice(0, 600);
                const key = (m.key || '').replace(/[_-]+/g, ' ').trim();
                if (key)
                    parts.push(`${key}: ${val}`);
            }
            return parts.join('; ');
        };
        if (this.rag.isConfigured()) {
            const productItems = nodes.map((p) => {
                const variants = p.variants.edges.map((v) => v.node);
                const prices = variants.map((v) => parseFloat(v.price) || 0);
                const min = prices.length ? Math.min(...prices) : 0;
                const max = prices.length ? Math.max(...prices) : 0;
                const priceStr = prices.length === 0
                    ? 'n/a'
                    : min === max
                        ? `${min}`
                        : `${min}–${max}`;
                const inStock = variants.some((v) => v.availableForSale);
                const desc = stripHtml(p.description).slice(0, 1500);
                const url = p.onlineStoreUrl ??
                    (p.handle ? `https://${api.shopDomain}/products/${p.handle}` : '');
                const tags = (p.tags ?? []).filter(Boolean).join(', ');
                const metafields = formatMetafields(p.metafields?.edges.map((e) => e.node));
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
                            const cmp = parseFloat(v.compareAtPrice ?? '') || 0;
                            const cur = parseFloat(v.price) || 0;
                            const discount = cmp > cur
                                ? ` (was ${v.compareAtPrice}, save ${(cmp - cur).toFixed(0)})`
                                : '';
                            return (`${v.title === 'Default Title' ? 'Standard' : v.title}` +
                                `${v.sku ? ` [${v.sku}]` : ''} = ${v.price}${currency ? ` ${currency}` : ''}${discount}${v.availableForSale ? '' : ' (out of stock)'}`);
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
            const policyItems = [];
            try {
                const polRaw = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, `query { shop { shopPolicies { type title body } } }`, {});
                for (const pol of polRaw?.data?.shop?.shopPolicies ?? []) {
                    const text = stripHtml(pol.body).slice(0, 4000);
                    if (text.length <= 20)
                        continue;
                    const title = pol.title ||
                        (pol.type
                            ? pol.type.replace(/_/g, ' ').toLowerCase()
                            : 'Store policy');
                    policyItems.push({
                        sourceId: (pol.type || title).toLowerCase().slice(0, 191),
                        title: `${title} — ${shopName || 'store'}`,
                        content: `${title}\n${text}`,
                    });
                }
            }
            catch (err) {
                this.logger.warn(`Shopify policy fetch skipped (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            }
            const prodRes = await this.rag.indexSource(companyId, 'product', productItems);
            const polRes = await this.rag.indexSource(companyId, 'policy', policyItems);
            if (prodRes.embedded) {
                await this.aiKnowledge.deleteByTitle(companyId, 'Shopify Product Catalogue (auto-synced)');
                return {
                    products: prodRes.indexed,
                    policies: polRes.indexed,
                    mode: 'rag',
                };
            }
        }
        const lines = [];
        lines.push(`Product catalogue for ${shopName || 'the store'}${currency ? ` (prices in ${currency})` : ''}. Auto-synced from Shopify — do not edit by hand; re-sync to update.`);
        lines.push('');
        for (const p of nodes) {
            const variants = p.variants.edges.map((v) => v.node);
            const prices = variants.map((v) => parseFloat(v.price) || 0);
            const min = prices.length ? Math.min(...prices) : 0;
            const max = prices.length ? Math.max(...prices) : 0;
            const priceStr = prices.length === 0
                ? 'n/a'
                : min === max
                    ? `${min}`
                    : `${min}–${max}`;
            const inStock = variants.some((v) => v.availableForSale);
            const desc = stripHtml(p.description).slice(0, 140);
            lines.push(`• ${p.title} — price ${priceStr}${currency ? ` ${currency}` : ''}; ${inStock ? 'in stock' : 'out of stock'}${p.vendor ? `; brand ${p.vendor}` : ''}${p.productType ? `; type ${p.productType}` : ''}.`);
            if (variants.length > 1) {
                lines.push(`   Variants: ${variants
                    .map((v) => `${v.title}${v.sku ? ` [${v.sku}]` : ''} = ${v.price}${v.availableForSale ? '' : ' (out of stock)'}`)
                    .join('; ')}`);
            }
            if (desc)
                lines.push(`   ${desc}`);
        }
        await this.aiKnowledge.upsertByTitle(companyId, 'Shopify Product Catalogue (auto-synced)', lines.join('\n'));
        return { products: nodes.length, policies: 0, mode: 'keyword' };
    }
    async lookupCustomerByIdentifier(api, identifier) {
        const gql = `query($id: CustomerIdentifierInput!) {
      customerByIdentifier(identifier: $id) {
        id firstName lastName email phone
      }
    }`;
        let res;
        try {
            res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { id: identifier });
        }
        catch (err) {
            this.logger.warn(`customerByIdentifier lookup failed (${JSON.stringify(identifier)}): ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
        const node = res?.data?.customerByIdentifier;
        if (!node?.id)
            return null;
        return {
            id: node.id,
            firstName: node.firstName ?? null,
            lastName: node.lastName ?? null,
            email: node.email ?? null,
            phone: node.phone ?? null,
        };
    }
    async searchCustomer(companyId, params) {
        const api = await this.requireAdminApi(companyId);
        const email = (params.email || '').trim();
        const phoneDigits = (params.phone || '').replace(/\D/g, '');
        if (phoneDigits) {
            const byPhone = await this.lookupCustomerByIdentifier(api, {
                phoneNumber: `+${phoneDigits}`,
            });
            if (byPhone)
                return [byPhone];
        }
        if (email) {
            const byEmail = await this.lookupCustomerByIdentifier(api, {
                emailAddress: email,
            });
            if (byEmail)
                return [byEmail];
        }
        const terms = [];
        if (email)
            terms.push(`email:${email}`);
        if (phoneDigits) {
            terms.push(`phone:+${phoneDigits}`);
            terms.push(`phone:${phoneDigits}`);
        }
        if (!terms.length)
            return [];
        const gql = `query($q: String) {
      customers(first: 5, query: $q) {
        edges { node { id firstName lastName email phone } }
      }
    }`;
        let res;
        try {
            res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { q: terms.join(' OR ') });
        }
        catch (err) {
            this.logger.warn(`Shopify customer search failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('Could not reach Shopify to look up the customer.');
        }
        if (res?.errors?.length) {
            throw new common_1.BadRequestException(`Shopify could not search customers (${res.errors
                .map((e) => e.message)
                .join('; ')}). Make sure the Admin token has the read_customers scope.`);
        }
        return (res?.data?.customers?.edges ?? []).map((e) => ({
            id: e.node.id,
            firstName: e.node.firstName ?? null,
            lastName: e.node.lastName ?? null,
            email: e.node.email ?? null,
            phone: e.node.phone ?? null,
        }));
    }
    async createCustomer(companyId, dto) {
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
            throw new common_1.BadRequestException('A phone or email is required to create a customer.');
        }
        const input = {};
        if (firstName)
            input.firstName = firstName;
        if (lastName)
            input.lastName = lastName;
        if (email)
            input.email = email;
        if (phoneDigits)
            input.phone = `+${phoneDigits}`;
        if (dto.address1 || dto.city) {
            const addr = {};
            if (firstName)
                addr.firstName = firstName;
            if (lastName)
                addr.lastName = lastName;
            if (dto.address1)
                addr.address1 = dto.address1;
            if (dto.city)
                addr.city = dto.city;
            if (phoneDigits)
                addr.phone = `+${phoneDigits}`;
            if (dto.countryCode)
                addr.countryCode = dto.countryCode.toUpperCase();
            input.addresses = [addr];
        }
        const gql = `mutation($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id firstName lastName email phone }
        userErrors { field message }
      }
    }`;
        let res;
        try {
            res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { input });
        }
        catch (err) {
            this.logger.warn(`Shopify customer create failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('Could not reach Shopify to create the customer.');
        }
        const cust = res?.data?.customerCreate?.customer ?? null;
        if (!cust?.id) {
            const msgs = res?.data?.customerCreate?.userErrors ?? res?.errors ?? [];
            throw new common_1.BadRequestException(`Shopify could not create the customer: ${msgs.map((e) => e.message).join('; ') || 'unknown error'}. Make sure the Admin token has the write_customers scope.`);
        }
        return {
            id: cust.id,
            firstName: cust.firstName ?? null,
            lastName: cust.lastName ?? null,
            email: cust.email ?? null,
            phone: cust.phone ?? null,
        };
    }
    async findOrCreateCustomer(companyId, dto) {
        const phone = (dto.phone || '').trim();
        const email = (dto.email || '').trim();
        if (!phone && !email)
            return null;
        try {
            const matches = await this.searchCustomer(companyId, { phone, email });
            if (matches[0]?.id)
                return matches[0].id;
            try {
                const created = await this.createCustomer(companyId, dto);
                return created.id ?? null;
            }
            catch (createErr) {
                const msg = createErr instanceof Error ? createErr.message : String(createErr);
                if (/taken|already exist|in use/i.test(msg)) {
                    const api = await this.requireAdminApi(companyId);
                    const phoneDigits = phone.replace(/\D/g, '');
                    const recovered = (phoneDigits &&
                        (await this.lookupCustomerByIdentifier(api, {
                            phoneNumber: `+${phoneDigits}`,
                        }))) ||
                        (email &&
                            (await this.lookupCustomerByIdentifier(api, {
                                emailAddress: email,
                            }))) ||
                        null;
                    if (recovered?.id) {
                        this.logger.log(`findOrCreateCustomer recovered existing customer ${recovered.id} after a unique-constraint create error (company ${companyId})`);
                        return recovered.id;
                    }
                }
                throw createErr;
            }
        }
        catch (err) {
            this.logger.warn(`findOrCreateCustomer failed (company ${companyId}, order continues without a linked customer): ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    mapDiscount(d) {
        if (!d || !(Number(d.value) > 0))
            return undefined;
        return {
            value: Number(d.value),
            valueType: d.type === 'percentage' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
            title: 'Discount',
        };
    }
    buildDraftBase(dto) {
        const lineItems = dto.lineItems.map((li) => {
            const item = li.variantId
                ? { variantId: li.variantId, quantity: li.quantity }
                : {
                    title: li.title || 'Item',
                    quantity: li.quantity,
                    originalUnitPrice: Number(li.price ?? 0).toFixed(2),
                };
            const disc = this.mapDiscount(li.discount);
            if (disc)
                item.appliedDiscount = disc;
            return item;
        });
        const nameParts = (dto.customerName || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        const firstName = nameParts.shift();
        const lastName = nameParts.length ? nameParts.join(' ') : undefined;
        const addr = {};
        if (firstName)
            addr.firstName = firstName;
        if (lastName)
            addr.lastName = lastName;
        if (dto.address1)
            addr.address1 = dto.address1;
        if (dto.city)
            addr.city = dto.city;
        if (dto.phone)
            addr.phone = dto.phone;
        if (dto.countryCode)
            addr.countryCode = dto.countryCode.toUpperCase();
        return {
            lineItems,
            shippingAddress: Object.keys(addr).length ? addr : undefined,
        };
    }
    async getShippingRates(companyId, dto) {
        const api = await this.requireAdminApi(companyId);
        const base = this.buildDraftBase(dto);
        const input = { lineItems: base.lineItems };
        if (base.shippingAddress)
            input.shippingAddress = base.shippingAddress;
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
        let res;
        try {
            res = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, gql, { input });
        }
        catch (err) {
            this.logger.warn(`Shopify shipping calc failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('Could not reach Shopify to calculate shipping.');
        }
        if (res?.errors?.length) {
            throw new common_1.BadRequestException(`Shopify could not calculate shipping (${res.errors
                .map((e) => e.message)
                .join('; ')}).`);
        }
        const ue = res?.data?.draftOrderCalculate?.userErrors ?? [];
        if (ue.length) {
            throw new common_1.BadRequestException(`Shopify shipping error: ${ue.map((e) => e.message).join('; ')}`);
        }
        const rates = res?.data?.draftOrderCalculate?.calculatedDraftOrder
            ?.availableShippingRates ?? [];
        return rates.map((r) => ({
            handle: r.handle,
            title: r.title,
            amount: r.price.amount,
            currencyCode: r.price.currencyCode,
        }));
    }
    async createOrder(companyId, dto) {
        const api = await this.requireAdminApi(companyId);
        const { shopDomain } = api;
        const base = this.buildDraftBase(dto);
        const input = { lineItems: base.lineItems };
        if (base.shippingAddress) {
            input.shippingAddress = base.shippingAddress;
            input.billingAddress = base.shippingAddress;
        }
        let customerId = dto.customerId;
        if (!customerId) {
            customerId =
                (await this.findOrCreateCustomer(companyId, dto)) ?? undefined;
        }
        if (customerId)
            input.purchasingEntity = { customerId };
        if (dto.email)
            input.email = dto.email;
        if (dto.note)
            input.note = dto.note;
        const tags = (dto.tags ?? [])
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 20);
        if (tags.length)
            input.tags = tags;
        const orderDisc = this.mapDiscount(dto.orderDiscount);
        if (orderDisc)
            input.appliedDiscount = orderDisc;
        if (dto.shippingLine && dto.shippingLine.title) {
            input.shippingLine = {
                title: dto.shippingLine.title,
                price: Number(dto.shippingLine.price ?? 0).toFixed(2),
            };
        }
        const errMsg = (ue, gql) => (ue && ue.length ? ue : gql ?? [])
            .map((e) => e.message)
            .filter(Boolean)
            .join('; ') || 'unknown error';
        let createRes;
        try {
            createRes = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, `mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id }
            userErrors { field message }
          }
        }`, { input });
        }
        catch (err) {
            this.logger.warn(`Shopify draftOrderCreate failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('Could not reach Shopify to create the order. Check the Admin token and store domain.');
        }
        const draftId = createRes?.data?.draftOrderCreate?.draftOrder?.id;
        if (!draftId) {
            throw new common_1.BadRequestException(`Shopify rejected the order: ${errMsg(createRes?.data?.draftOrderCreate?.userErrors, createRes?.errors)}`);
        }
        const createUe = createRes?.data?.draftOrderCreate?.userErrors ?? [];
        if (createUe.length) {
            this.logger.warn(`draftOrderCreate userErrors (company ${companyId}, draft created anyway): ${createUe
                .map((e) => e.message)
                .join('; ')}`);
        }
        let completeRes;
        try {
            completeRes = await this.shopifyGraphql(api.shopDomain, api.apiVersion, api.token, `mutation($id: ID!, $paymentPending: Boolean) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder { order { id name } }
            userErrors { field message }
          }
        }`, { id: draftId, paymentPending: !dto.prepaid });
        }
        catch (err) {
            this.logger.warn(`Shopify draftOrderComplete failed (company ${companyId}): ${err instanceof Error ? err.message : String(err)}`);
            throw new common_1.ServiceUnavailableException('The order draft was created but Shopify could not complete it.');
        }
        const order = completeRes?.data?.draftOrderComplete?.draftOrder?.order ?? null;
        if (!order?.id) {
            throw new common_1.BadRequestException(`Order draft created but completion failed: ${errMsg(completeRes?.data?.draftOrderComplete?.userErrors, completeRes?.errors)}`);
        }
        const numericId = order.id.split('/').pop();
        this.logger.log(`Shopify order ${order.name} created from chat (company ${companyId})`);
        return {
            orderId: order.id,
            orderName: order.name,
            adminUrl: `https://${shopDomain}/admin/orders/${numericId}`,
        };
    }
    shopifyGraphql(shopDomain, apiVersion, token, query, variables) {
        const body = JSON.stringify({ query, variables });
        return new Promise((resolve, reject) => {
            const req = https.request({
                host: shopDomain,
                method: 'POST',
                path: `/admin/api/${apiVersion}/graphql.json`,
                headers: {
                    'x-shopify-access-token': token,
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
                timeout: SHOPIFY_TIMEOUT_MS,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(raw));
                        }
                        catch {
                            reject(new Error('Shopify API parse error'));
                        }
                    }
                    else {
                        reject(new Error(`Shopify API ${res.statusCode}: ${raw.slice(0, 300)}`));
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error('Shopify API timed out')));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    getOAuthUrl(companyId) {
        const clientId = this.config.get('SHOPIFY_CLIENT_ID');
        const appUrl = this.config.get('APP_URL');
        const state = Buffer.from(JSON.stringify({ companyId })).toString('base64');
        const redirectUri = `${appUrl}/integrations/shopify/callback`;
        const scopes = 'read_orders,read_customers';
        const url = `https://{shop}.myshopify.com/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        return { url };
    }
    async handleCallback(shop, code, state) {
        let companyId;
        try {
            const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
            companyId = decoded.companyId;
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid OAuth state');
        }
        const clientId = this.config.get('SHOPIFY_CLIENT_ID');
        const clientSecret = this.config.get('SHOPIFY_CLIENT_SECRET');
        const appUrl = this.config.get('APP_URL');
        const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        });
        if (!res.ok)
            throw new common_1.UnauthorizedException('Shopify token exchange failed');
        const { access_token } = (await res.json());
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
    async handleWebhook(topic, hmac, rawBody) {
        const secret = this.config.get('SHOPIFY_WEBHOOK_SECRET');
        if (!secret)
            return;
        const expected = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('base64');
        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
            throw new common_1.UnauthorizedException('Invalid Shopify HMAC');
        }
        this.logger.log(`Shopify webhook received: ${topic}`);
    }
    async getIntegration(companyId) {
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
        if (!integration)
            throw new common_1.NotFoundException('No Shopify integration found');
        return integration;
    }
    async getIntegrationOrNull(companyId) {
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
    async updateEvents(companyId, events) {
        const allowed = [
            'orders/create',
            'orders/paid',
            'orders/fulfilled',
            'orders/cancelled',
        ];
        const clean = Array.from(new Set(events.filter((e) => allowed.includes(e))));
        const integration = await this.prisma.shopifyIntegration.findUnique({
            where: { company_id: companyId },
            select: { id: true },
        });
        if (!integration)
            throw new common_1.NotFoundException('No Shopify integration found');
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
    async disconnect(companyId) {
        await this.prisma.shopifyIntegration.delete({
            where: { company_id: companyId },
        });
        return { message: 'Shopify disconnected' };
    }
    async ensureShopifyWebhookKey(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { company_name: true, shopify_webhook_key: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        if (company.shopify_webhook_key)
            return company.shopify_webhook_key;
        const slug = company.company_name
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
    async handleTenantOrderWebhook(key, topic, hmacHeader, rawBody, shopDomain) {
        const company = await this.prisma.company.findFirst({
            where: { shopify_webhook_key: key },
            select: { id: true, shopify_webhook_secret_encrypted: true },
        });
        if (!company) {
            throw new common_1.UnauthorizedException('Unknown Shopify webhook key');
        }
        if (!company.shopify_webhook_secret_encrypted) {
            throw new common_1.UnauthorizedException('Shopify webhook secret not configured for this company');
        }
        let secret;
        try {
            secret = this.encryption.decrypt(company.shopify_webhook_secret_encrypted);
        }
        catch {
            throw new common_1.UnauthorizedException('Cannot decrypt Shopify webhook secret');
        }
        const expected = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('base64');
        const a = Buffer.from(hmacHeader || '', 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new common_1.UnauthorizedException('Invalid Shopify HMAC');
        }
        if (topic !== 'orders/create') {
            this.logger.log(`Shopify webhook for company ${company.id} ignored (topic=${topic})`);
            return { received: true, ignored: topic };
        }
        let order;
        try {
            order = JSON.parse(rawBody.toString('utf8'));
        }
        catch {
            this.logger.warn(`Shopify orders/create for company ${company.id}: unparseable body`);
            return { received: true, ignored: 'bad-json' };
        }
        await this.jobQueue.enqueue('shopify', {
            kind: 'send',
            companyId: company.id,
            shopDomain: shopDomain || '',
            order,
        });
        this.logger.log(`Shopify orders/create company=${company.id} order=${order.name ?? order.id} enqueued for confirmation send`);
        return { received: true };
    }
    async getOrderConfig(companyId) {
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
                variableMap: row.variable_map ?? {},
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
            fields: exports.SHOPIFY_ORDER_FIELDS,
            apiVersions: exports.SHOPIFY_API_VERSIONS,
            webhookKey,
            webhookSecretSet: !!company?.shopify_webhook_secret_encrypted,
            adminTokenSet: !!company?.shopify_admin_token_encrypted,
        };
    }
    async ensureConfigRow(companyId) {
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
    async updateCredentials(companyId, dto) {
        await this.ensureConfigRow(companyId);
        const shopDomain = (dto.shopDomain ?? '')
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .trim();
        const apiVersion = dto.apiVersion && exports.SHOPIFY_API_VERSIONS.includes(dto.apiVersion)
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
    async updateTemplate(companyId, dto) {
        for (const [slot, src] of Object.entries(dto.variableMap ?? {})) {
            if (!SHOPIFY_ORDER_FIELD_KEYS.has(src)) {
                throw new common_1.BadRequestException(`Variable {{${slot}}} is mapped to an unknown field "${src}"`);
            }
        }
        let languageCode = null;
        if (dto.enabled) {
            if (!dto.templateId) {
                throw new common_1.BadRequestException('Select an approved template to enable order confirmations');
            }
            const tpl = await this.prisma.template.findFirst({
                where: { id: dto.templateId, company_id: companyId, deleted_at: null },
                select: { status: true, content: true },
            });
            if (!tpl)
                throw new common_1.NotFoundException('Template not found');
            if (tpl.status !== 'approved') {
                throw new common_1.BadRequestException('The selected template is not approved by Meta');
            }
            languageCode =
                tpl.content?.language ?? 'en_US';
        }
        await this.ensureConfigRow(companyId);
        await this.prisma.shopifyOrderConfig.update({
            where: { company_id: companyId },
            data: {
                enabled: dto.enabled,
                template_id: dto.templateId ?? null,
                language_code: languageCode,
                variable_map: (dto.variableMap ?? {}),
            },
        });
        return this.getOrderConfig(companyId);
    }
    async updateTags(companyId, dto) {
        if (!dto.confirmTag.trim() || !dto.cancelTag.trim()) {
            throw new common_1.BadRequestException('Confirm and Cancel tag names are required');
        }
        const win = dto.decisionWindowMinutes && dto.decisionWindowMinutes > 0
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
    async getWebhookConfig(companyId) {
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
    async setWebhookSecret(companyId, secret) {
        if (this.encryption.isUsingPlaceholderKey()) {
            throw new common_1.ServiceUnavailableException('Server encryption key is not configured — refusing to store secrets.');
        }
        const trimmed = secret.trim();
        if (trimmed.length < 8) {
            throw new common_1.BadRequestException('Shopify webhook signing secret looks too short');
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
};
exports.ShopifyService = ShopifyService;
exports.ShopifyService = ShopifyService = ShopifyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService,
        encryption_service_1.EncryptionService,
        job_queue_service_1.JobQueueService,
        usage_metering_service_1.UsageMeteringService,
        inbox_service_1.InboxService,
        ai_knowledge_service_1.AiKnowledgeService,
        ai_rag_service_1.AiRagService])
], ShopifyService);
//# sourceMappingURL=shopify.service.js.map