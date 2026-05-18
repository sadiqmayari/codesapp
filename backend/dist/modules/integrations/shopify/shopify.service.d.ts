import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
export declare class ShopifyService {
    private readonly prisma;
    private readonly config;
    private readonly encryption;
    private readonly logger;
    constructor(prisma: PrismaService, config: ConfigService, encryption: EncryptionService);
    getOAuthUrl(companyId: number): {
        url: string;
    };
    handleCallback(shop: string, code: string, state: string): Promise<{
        message: string;
        shop: string;
    }>;
    handleWebhook(topic: string, hmac: string, rawBody: Buffer): Promise<void>;
    getIntegration(companyId: number): Promise<{
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        id: number;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    }>;
    getIntegrationOrNull(companyId: number): Promise<{
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        id: number;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    } | null>;
    updateEvents(companyId: number, events: string[]): Promise<{
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        id: number;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    }>;
    disconnect(companyId: number): Promise<{
        message: string;
    }>;
    private ensureShopifyWebhookKey;
    getWebhookConfig(companyId: number): Promise<{
        webhookKey: string;
        webhookSecretSet: boolean;
    }>;
    setWebhookSecret(companyId: number, secret: string): Promise<{
        webhookSecretSet: boolean;
    }>;
}
