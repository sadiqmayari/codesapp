import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ShopifyService } from './shopify.service';
export declare class ShopifyController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    connect(user: {
        companyId: number;
    }): {
        url: string;
    };
    callback(req: Request): Promise<{
        message: string;
        shop: string;
    }>;
    webhook(req: RawBodyRequest<Request>): Promise<{
        received: boolean;
    }>;
    getIntegration(user: {
        companyId: number;
    }): Promise<{
        id: number;
        status: import(".prisma/client").$Enums.ShopifyStatus;
        created_at: Date;
        shop_domain: string;
        active_events: import("@prisma/client/runtime/library").JsonValue;
    }>;
    disconnect(user: {
        companyId: number;
    }): Promise<{
        message: string;
    }>;
}
