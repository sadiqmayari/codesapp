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
        id: number;
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    }>;
    disconnect(companyId: number): Promise<{
        message: string;
    }>;
}
