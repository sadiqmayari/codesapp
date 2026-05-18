export declare class ShopifyCredentialsDto {
    webhookSecret?: string;
    adminToken?: string;
    shopDomain?: string;
    apiVersion?: string;
}
export declare class ShopifyTemplateDto {
    enabled: boolean;
    templateId?: number | null;
    variableMap: Record<string, string>;
}
export declare class ShopifyTagsDto {
    confirmTag: string;
    cancelTag: string;
    pendingTag?: string;
    decisionWindowMinutes?: number;
}
