export declare class ShopifyOrderConfigDto {
    enabled: boolean;
    templateId?: number | null;
    variableMap: Record<string, string>;
    confirmTag: string;
    cancelTag: string;
    shopDomain?: string;
    apiVersion?: string;
    pendingTag?: string;
    decisionWindowMinutes?: number;
    defaultCountryCode?: string;
    webhookSecret?: string;
    adminToken?: string;
}
