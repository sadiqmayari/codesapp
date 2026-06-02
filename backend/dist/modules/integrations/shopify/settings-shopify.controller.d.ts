import { ShopifyService } from './shopify.service';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';
import { ShopifyCredentialsDto, ShopifyTemplateDto, ShopifyTagsDto } from './dto/order-config.dto';
import { SetShopifyAdminTokenDto } from './dto/set-admin-token.dto';
export declare class SettingsShopifyController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    ready(user: {
        companyId: number;
    }): Promise<{
        adminTokenSet: boolean;
    }>;
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
    }>;
    saveCredentials(user: {
        companyId: number;
    }, dto: ShopifyCredentialsDto): Promise<{
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
    }>;
    saveTemplate(user: {
        companyId: number;
    }, dto: ShopifyTemplateDto): Promise<{
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
    }>;
    saveTags(user: {
        companyId: number;
    }, dto: ShopifyTagsDto): Promise<{
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
    }>;
    disconnect(user: {
        companyId: number;
    }): Promise<{
        message: string;
    }>;
}
