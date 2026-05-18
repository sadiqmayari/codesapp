import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ShopifyService } from './shopify.service';
export declare class ShopifyTenantWebhookController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    receive(key: string, req: RawBodyRequest<Request>): Promise<{
        received: true;
        ignored?: string;
    }>;
}
