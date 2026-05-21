import { ShopifyService } from './shopify.service';
import { CreateShopifyOrderDto } from './dto/create-order.dto';
export declare class ShopifyOrdersController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    createOrder(user: {
        companyId: number;
    }, dto: CreateShopifyOrderDto): Promise<{
        orderId: string;
        orderName: string;
        adminUrl: string;
    }>;
}
