import { ShopifyService } from './shopify.service';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';
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
    disconnect(user: {
        companyId: number;
    }): Promise<{
        message: string;
    }>;
}
