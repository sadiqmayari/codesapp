import { ShopifyService } from './shopify.service';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
export declare class SettingsShopifyController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    status(user: {
        companyId: number;
    }): Promise<{
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        id: number;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    } | null>;
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
