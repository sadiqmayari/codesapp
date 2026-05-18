import { ShopifyService } from './shopify.service';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';
import { ShopifyOrderConfigDto } from './dto/order-config.dto';
export declare class SettingsShopifyController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    status(user: {
        companyId: number;
    }): Promise<{
        webhookKey: string;
        webhookSecretSet: boolean;
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
        };
        fields: {
            key: string;
            label: string;
        }[];
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
        };
        fields: {
            key: string;
            label: string;
        }[];
    }>;
    disconnect(user: {
        companyId: number;
    }): Promise<{
        message: string;
    }>;
}
