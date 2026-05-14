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
exports.ShopifyService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const encryption_service_1 = require("../../../common/services/encryption.service");
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
    async disconnect(companyId) {
        await this.prisma.shopifyIntegration.delete({
            where: { company_id: companyId },
        });
        return { message: 'Shopify disconnected' };
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