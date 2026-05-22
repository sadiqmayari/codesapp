import { ShopifyService } from './shopify.service';
import { CreateShopifyOrderDto, ShippingRatesDto } from './dto/create-order.dto';
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
    shippingRates(user: {
        companyId: number;
    }, dto: ShippingRatesDto): Promise<{
        handle: string;
        title: string;
        amount: string;
        currencyCode: string;
    }[]>;
    createOrder(user: {
        companyId: number;
    }, dto: CreateShopifyOrderDto): Promise<{
        orderId: string;
        orderName: string;
        adminUrl: string;
    }>;
}
