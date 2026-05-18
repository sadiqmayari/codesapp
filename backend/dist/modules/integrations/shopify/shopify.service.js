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
exports.SHOPIFY_API_VERSIONS = [
    '2025-04',
    '2025-01',
    '2024-10',
    '2024-07',
    '2024-04',
    '2024-01',
];
const DEFAULT_SHOPIFY_API_VERSION = exports.SHOPIFY_API_VERSIONS[0];
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
];
const SHOPIFY_ORDER_FIELD_KEYS = new Set(exports.SHOPIFY_ORDER_FIELDS.map((f) => f.key));
let ShopifyService = ShopifyService_1 = class ShopifyService {
    constructor(prisma, config, encryption, jobQueue, metering, inbox) {
        this.prisma = prisma;
        this.config = config;
        this.encryption = encryption;
        this.jobQueue = jobQueue;
        this.metering = metering;
        this.inbox = inbox;
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
                default:
                    return '';
            }
        })();
        return (val ?? '').toString();
    }
    orderPhone(order) {
        const raw = order.customer?.phone ||
            order.phone ||
            order.shipping_address?.phone ||
            order.billing_address?.phone ||
            '';
        return raw.replace(/[^\d+]/g, '');
    }
    async processOrderSend(companyId, shopDomain, order) {
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        if (!cfg || !cfg.enabled || !cfg.template_id) {
            this.logger.log(`Shopify order send skipped for company ${companyId} (config disabled/incomplete)`);
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
        let contact = await this.prisma.contact.findFirst({
            where: { company_id: companyId, phone, deleted_at: null },
        });
        if (!contact) {
            contact = await this.prisma.contact.create({
                data: { company_id: companyId, name, phone, last_message_at: new Date() },
            });
            await this.metering.incrementContacts(companyId);
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
        this.logger.log(`Shopify order ${order.name ?? order.id}: confirmation template sent (company ${companyId}, msg ${message.id})`);
    }
    async processOrderTag(companyId, orderMessageId, decision) {
        const row = await this.prisma.shopifyOrderMessage.findFirst({
            where: { id: orderMessageId, company_id: companyId },
        });
        if (!row || row.status !== 'pending')
            return;
        const cfg = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        const tag = decision === 'confirm'
            ? cfg?.confirm_tag ?? 'confirmed'
            : cfg?.cancel_tag ?? 'cancelled';
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { shopify_admin_token_encrypted: true },
        });
        if (!company?.shopify_admin_token_encrypted) {
            this.logger.warn(`Cannot tag Shopify order (company ${companyId}): no Admin API token configured`);
            return;
        }
        let token;
        try {
            token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
        }
        catch {
            this.logger.error(`Cannot decrypt Shopify Admin token for company ${companyId}`);
            return;
        }
        const shopDomain = (row.shop_domain || cfg?.shop_domain || '')
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .trim();
        if (!shopDomain) {
            this.logger.warn(`Cannot tag Shopify order (company ${companyId}): no store domain (set it in Settings → Shopify)`);
            return;
        }
        const apiVersion = cfg?.api_version && exports.SHOPIFY_API_VERSIONS.includes(cfg.api_version)
            ? cfg.api_version
            : DEFAULT_SHOPIFY_API_VERSION;
        const query = 'mutation tagsAdd($id: ID!, $tags: [String!]!) {' +
            ' tagsAdd(id: $id, tags: $tags) { userErrors { message } } }';
        try {
            const res = await this.shopifyGraphql(shopDomain, apiVersion, token, query, {
                id: row.shopify_order_gid,
                tags: [tag],
            });
            const userErrors = res?.data?.tagsAdd?.userErrors ?? [];
            if (res?.errors?.length || userErrors.length) {
                this.logger.warn(`Shopify tagsAdd errors for order ${row.shopify_order_gid}: ${JSON.stringify(res.errors ?? userErrors)}`);
                return;
            }
            await this.prisma.shopifyOrderMessage.update({
                where: { id: row.id },
                data: { status: decision === 'confirm' ? 'confirmed' : 'cancelled' },
            });
            this.logger.log(`Shopify order ${row.shopify_order_gid} tagged "${tag}" (company ${companyId})`);
        }
        catch (err) {
            this.logger.warn(`Shopify tagsAdd failed for order ${row.shopify_order_gid}: ${err instanceof Error ? err.message : String(err)}`);
        }
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
        const row = await this.prisma.shopifyOrderConfig.findUnique({
            where: { company_id: companyId },
        });
        const config = row
            ? {
                enabled: row.enabled,
                templateId: row.template_id,
                languageCode: row.language_code,
                variableMap: row.variable_map ?? {},
                confirmTag: row.confirm_tag,
                cancelTag: row.cancel_tag,
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
                shopDomain: '',
                apiVersion: DEFAULT_SHOPIFY_API_VERSION,
            };
        return {
            config,
            fields: exports.SHOPIFY_ORDER_FIELDS,
            apiVersions: exports.SHOPIFY_API_VERSIONS,
        };
    }
    async upsertOrderConfig(companyId, dto) {
        for (const [slot, src] of Object.entries(dto.variableMap)) {
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
                where: {
                    id: dto.templateId,
                    company_id: companyId,
                    deleted_at: null,
                },
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
        const shopDomain = (dto.shopDomain ?? '')
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .trim();
        const apiVersion = dto.apiVersion && exports.SHOPIFY_API_VERSIONS.includes(dto.apiVersion)
            ? dto.apiVersion
            : DEFAULT_SHOPIFY_API_VERSION;
        const data = {
            template_id: dto.templateId ?? null,
            language_code: languageCode,
            variable_map: dto.variableMap,
            confirm_tag: dto.confirmTag.trim(),
            cancel_tag: dto.cancelTag.trim(),
            shop_domain: shopDomain || null,
            api_version: apiVersion,
            enabled: dto.enabled,
        };
        await this.prisma.shopifyOrderConfig.upsert({
            where: { company_id: companyId },
            create: { company_id: companyId, ...data },
            update: data,
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
        inbox_service_1.InboxService])
], ShopifyService);
//# sourceMappingURL=shopify.service.js.map