export declare class CreateOrderLineItemDto {
    title: string;
    quantity: number;
    price: number;
}
export declare class CreateShopifyOrderDto {
    lineItems: CreateOrderLineItemDto[];
    customerName?: string;
    phone?: string;
    email?: string;
    address1?: string;
    city?: string;
    note?: string;
}
