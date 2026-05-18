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
exports.ShopifyService = exports.SHOPIFY_ORDER_FIELDS = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const encryption_service_1 = require("../../../common/services/encryption.service");
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
    constructor(prisma, config, encryption) {
        this.prisma = prisma;
        this.config = config;
        this.encryption = encryption;
        this.logger = new common_1.Logger(ShopifyService_1.name);
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
    async handleTenantOrderWebhook(key, topic, hmacHeader, rawBody) {
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
        this.logger.log(`Shopify orders/create company=${company.id} order=${order.name ?? order.id} total=${order.total_price ?? '?'} ${order.currency ?? ''} ` +
            `phone=${order.customer?.phone ?? order.phone ?? 'n/a'} ` +
            `[Phase 2: validated+parsed only — send+tag is Phase 4]`);
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
            }
            : {
                enabled: false,
                templateId: null,
                languageCode: null,
                variableMap: {},
                confirmTag: 'confirmed',
                cancelTag: 'cancelled',
            };
        return { config, fields: exports.SHOPIFY_ORDER_FIELDS };
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
        const data = {
            template_id: dto.templateId ?? null,
            language_code: languageCode,
            variable_map: dto.variableMap,
            confirm_tag: dto.confirmTag.trim(),
            cancel_tag: dto.cancelTag.trim(),
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
            select: { shopify_webhook_secret_encrypted: true },
        });
        return {
            webhookKey,
            webhookSecretSet: !!c?.shopify_webhook_secret_encrypted,
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
        encryption_service_1.EncryptionService])
], ShopifyService);
//# sourceMappingURL=shopify.service.js.map