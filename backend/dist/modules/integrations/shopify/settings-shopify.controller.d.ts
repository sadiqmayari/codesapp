import { ShopifyService } from './shopify.service';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';
import { ShopifyOrderConfigDto } from './dto/order-config.dto';
import { SetShopifyAdminTokenDto } from './dto/set-admin-token.dto';
export declare class SettingsShopifyController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    status(user: {
        companyId: number;
    }): Promise<{
        webhookKey: string;
        webhookSecretSet: boolean;
        adminTokenSet: boolean;
        integration: {
            status: import(".prisma/client").$Enums.ShopifyStatus;
            created_at: Date;
            id: number;
            shop_domain: string;
            active_events: import("@prisma/client/runtime/library").JsonValue;
        } | null;
    }>;
    setWebhookSecret(user: {
        companyId: number;
    }, dto: SetShopifyWebhookSecretDto): Promise<{
        webhookSecretSet: boolean;
    }>;
    connect(user: {
        companyId: number;
    }): {
        url: string;
    };
    updateEvents(user: {
        companyId: number;
    }, dto: UpdateShopifyEventsDto): Promise<{
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        id: number;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    }>;
    setAdminToken(user: {
        companyId: number;
    }, dto: SetShopifyAdminTokenDto): Promise<{
        adminTokenSet: boolean;
    }>;
    getOrderConfig(user: {
        companyId: number;
    }): Promise<{
        config: {
            enabled: boolean;
            templateId: number | null;
            languageCode: string | null;
            variableMap: Record<string, string>;
            confirmTag: string;
            cancelTag: string;
            pendingTag: string;
            decisionWindowMinutes: number;
            shopDomain: string;
            apiVersion: string;
        };
        fields: {
            key: string;
            label: string;
        }[];
        apiVersions: string[];
        webhookKey: string;
        webhookSecretSet: boolean;
        adminTokenSet: boolean;
        defaultCountryCode: string;
    }>;
    putOrderConfig(user: {
        companyId: number;
    }, dto: ShopifyOrderConfigDto): Promise<{
        config: {
            enabled: boolean;
            templateId: number | null;
            languageCode: string | null;
            variableMap: Record<string, string>;
            confirmTag: string;
            cancelTag: string;
            pendingTag: string;
            decisionWindowMinutes: number;
            shopDomain: string;
            apiVersion: string;
        };
        fields: {
            key: string;
            label: string;
        }[];
        apiVersions: string[];
        webhookKey: string;
        webhookSecretSet: boolean;
        adminTokenSet: boolean;
        defaultCountryCode: string;
    }>;
    disconnect(user: {
        companyId: number;
    }): Promise<{
        message: string;
    }>;
}
