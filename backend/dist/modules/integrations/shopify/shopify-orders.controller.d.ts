import { ShopifyService } from './shopify.service';
import { CreateShopifyOrderDto } from './dto/create-order.dto';
export declare class ShopifyOrdersController {
    private readonly shopifyService;
    constructor(shopifyService: ShopifyService);
    searchProducts(user: {
        companyId: number;
    }, query?: string): Promise<{
        variantId: string;
        productTitle: string;
        variantTitle: string;
        price: string;
        sku: string | null;
        image: string | null;
        available: boolean;
    }[]>;
    createOrder(user: {
        companyId: number;
    }, dto: CreateShopifyOrderDto): Promise<{
        orderId: string;
        orderName: string;
        adminUrl: string;
    }>;
}
