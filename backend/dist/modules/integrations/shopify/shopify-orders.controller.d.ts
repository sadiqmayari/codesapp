import { ShopifyService } from './shopify.service';
import { CreateShopifyOrderDto, CreateCustomerDto, ShippingRatesDto } from './dto/create-order.dto';
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
        compareAtPrice: string | null;
        discountPercent: number | null;
        sku: string | null;
        image: string | null;
        productUrl: string | null;
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
    searchCustomer(user: {
        companyId: number;
    }, phone?: string, email?: string): Promise<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
    }[]>;
    createCustomer(user: {
        companyId: number;
    }, dto: CreateCustomerDto): Promise<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
    }>;
    createOrder(user: {
        companyId: number;
    }, dto: CreateShopifyOrderDto): Promise<{
        orderId: string;
        orderName: string;
        adminUrl: string;
    }>;
    syncKnowledge(user: {
        companyId: number;
    }): Promise<{
        started: boolean;
    }>;
    knowledgeStatus(user: {
        companyId: number;
    }): Promise<{
        configured: boolean;
        products: number;
        policies: number;
        total: number;
        lastSyncedAt: string | null;
    }>;
}
