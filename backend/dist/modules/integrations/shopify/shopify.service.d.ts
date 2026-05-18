import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
export declare const SHOPIFY_ORDER_FIELDS: Array<{
    key: string;
    label: string;
}>;
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
    handleTenantOrderWebhook(key: string, topic: string, hmacHeader: string, rawBody: Buffer): Promise<{
        received: true;
        ignored?: string;
    }>;
    getOrderConfig(companyId: number): Promise<{
        config: {
            enabled: boolean;
            templateId: number | null;
            languageCode: string | null;
            variableMap: Record<string, string>;
            confirmTag: string;
            cancelTag: string;
        };
        fields: {
            key: string;
            label: string;
        }[];
    }>;
    upsertOrderConfig(companyId: number, dto: {
        enabled: boolean;
        templateId?: number | null;
        variableMap: Record<string, string>;
        confirmTag: string;
        cancelTag: string;
    }): Promise<{
        config: {
            enabled: boolean;
            templateId: number | null;
            languageCode: string | null;
            variableMap: Record<string, string>;
            confirmTag: string;
            cancelTag: string;
        };
        fields: {
            key: string;
            label: string;
        }[];
    }>;
    getWebhookConfig(companyId: number): Promise<{
        webhookKey: string;
        webhookSecretSet: boolean;
    }>;
    setWebhookSecret(companyId: number, secret: string): Promise<{
        webhookSecretSet: boolean;
    }>;
}
