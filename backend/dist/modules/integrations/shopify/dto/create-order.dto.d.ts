export declare class OrderDiscountDto {
    type: 'percentage' | 'fixed';
    value: number;
}
export declare class CreateOrderLineItemDto {
    variantId?: string;
    title?: string;
    quantity: number;
    price?: number;
    discount?: OrderDiscountDto;
}
export declare class ShippingLineDto {
    title: string;
    price: number;
}
export declare class ShippingRatesDto {
    lineItems: CreateOrderLineItemDto[];
    customerName?: string;
    phone?: string;
    address1?: string;
    city?: string;
    countryCode?: string;
}
export declare class CreateShopifyOrderDto {
    lineItems: CreateOrderLineItemDto[];
    customerName?: string;
    phone?: string;
    email?: string;
    address1?: string;
    city?: string;
    countryCode?: string;
    note?: string;
    tags?: string[];
    prepaid?: boolean;
    shippingLine?: ShippingLineDto;
    orderDiscount?: OrderDiscountDto;
    customerId?: string;
}
export declare class CreateCustomerDto {
    customerName?: string;
    phone?: string;
    email?: string;
    address1?: string;
    city?: string;
    countryCode?: string;
}
