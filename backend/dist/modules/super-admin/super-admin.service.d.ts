import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { PlatformSettingService, UsageLimitAction } from '../../common/services/platform-setting.service';
import { LimitNotifierService } from '../billing/limit-notifier.service';
export declare class SuperAdminService {
    private readonly prisma;
    private readonly jwt;
    private readonly config;
    private readonly platformSetting;
    private readonly limitNotifier;
    private readonly cache;
    private readonly logger;
    constructor(prisma: PrismaService, jwt: JwtService, config: ConfigService, platformSetting: PlatformSettingService, limitNotifier: LimitNotifierService, cache: CacheService);
    getSettings(): Promise<{
        usageLimitAction: UsageLimitAction;
    }>;
    updateSettings(usageLimitAction: UsageLimitAction): Promise<{
        usageLimitAction: UsageLimitAction;
    }>;
    login(email: string, password: string, res: any): Promise<{
        accessToken: string;
    }>;
    refresh(refreshToken: string | undefined, res: any): Promise<{
        accessToken: string;
    }>;
    logout(res: any): {
        message: string;
    };
    getDashboard(): Promise<{
        kpis: {
            totalClients: number;
            activeClients: number;
            pendingClients: number;
            suspendedClients: number;
            totalUsers: number;
            mrrUsd: number;
            invoicedThisMonthUsd: number;
            paidThisMonthUsd: number;
            outstandingUsd: number;
            newSignupsThisMonth: number;
            activeConversationsToday: number;
        };
        signups90d: {
            date: string;
            count: number;
        }[];
        pendingApprovals: {
            id: number;
            name: string;
            createdAt: string;
            ownerName: string;
            ownerEmail: string;
        }[];
        overdueInvoices: {
            id: number;
            invoiceNumber: string | null;
            companyId: number;
            companyName: string;
            amount: number;
            dueDate: string;
            daysOverdue: number;
        }[];
        recentActivity: {
            id: number;
            action: string;
            entity: string;
            entityId: number | null;
            createdAt: string;
            userName: string | null;
            userEmail: string | null;
        }[];
    }>;
    getClients(page?: number, limit?: number): Promise<{
        items: ({
            subscription: {
                id: number;
                plan_name: string;
                contact_limit: number;
                template_limit: number;
                user_limit: number;
                monthly_price: import("@prisma/client/runtime/library").Decimal;
                setup_fee: import("@prisma/client/runtime/library").Decimal;
                webhook_enabled: boolean;
            };
        } & {
            created_at: Date;
            id: number;
            usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
            address: string | null;
            company_name: string;
            activation_status: import(".prisma/client").$Enums.ActivationStatus;
            waba_id: string | null;
            phone_number_id: string | null;
            onboarding_status: import("@prisma/client/runtime/library").JsonValue;
            webhook_key: string | null;
            webhook_app_secret_encrypted: string | null;
            webhook_verify_token: string | null;
            shopify_webhook_key: string | null;
            shopify_webhook_secret_encrypted: string | null;
            shopify_admin_token_encrypted: string | null;
            default_country_code: string | null;
            logo_url: string | null;
            activated_at: Date | null;
            suspended_at: Date | null;
            grace_until: Date | null;
            contact_limit_override: number | null;
            template_limit_override: number | null;
            user_limit_override: number | null;
            subscription_id: number;
        })[];
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getClient(id: number): Promise<{
        subscription: {
            id: number;
            plan_name: string;
            contact_limit: number;
            template_limit: number;
            user_limit: number;
            monthly_price: import("@prisma/client/runtime/library").Decimal;
            setup_fee: import("@prisma/client/runtime/library").Decimal;
            webhook_enabled: boolean;
        };
        users: {
            status: import(".prisma/client").$Enums.UserStatus;
            id: number;
            name: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
        }[];
    } & {
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    getClientDetail(id: number): Promise<{
        company: {
            id: number;
            name: string;
            address: string | null;
            activation_status: import(".prisma/client").$Enums.ActivationStatus;
            activated_at: Date | null;
            suspended_at: Date | null;
            grace_until: Date | null;
            usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
            effective_usage_limit_action: "block" | "warn_only";
            contact_limit_override: number | null;
            template_limit_override: number | null;
            user_limit_override: number | null;
            effective_limits: {
                contact_limit: number;
                template_limit: number;
                user_limit: number;
            } | null;
            logo_url: string | null;
            created_at: Date;
            waba_id: string | null;
            phone_number_id: string | null;
            webhook_key: string | null;
            has_webhook_app_secret: boolean;
            shopify_webhook_key: string | null;
            has_shopify_webhook_secret: boolean;
            has_shopify_admin_token: boolean;
            default_country_code: string | null;
            onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        };
        subscription: {
            id: number;
            plan_name: string;
            contact_limit: number;
            template_limit: number;
            user_limit: number;
            monthly_price: import("@prisma/client/runtime/library").Decimal;
            setup_fee: import("@prisma/client/runtime/library").Decimal;
            webhook_enabled: boolean;
        };
        users: {
            status: import(".prisma/client").$Enums.UserStatus;
            created_at: Date;
            id: number;
            name: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
        }[];
        snapshot: {
            period: string;
            mrrUsd: number;
            activeContacts: number;
            totalContacts: number;
            templates: number;
            activeUsers: number;
            openInvoices: number;
            outstandingUsd: number;
            windowOpenChats: number;
            messagesThisMonth: number;
            conversationsThisMonth: number;
        };
        usage: {
            id: number;
            updated_at: Date;
            company_id: number;
            contacts_stored: number;
            templates_used: number;
            period: string;
            messages_sent: number;
            webhook_calls: number;
            conversations_opened: number;
            thresholds_notified: import("@prisma/client/runtime/library").JsonValue | null;
        } | null;
        invoices: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            description: string | null;
            period: string | null;
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
        shopify: {
            status: import(".prisma/client").$Enums.ShopifyStatus;
            created_at: Date;
            id: number;
            shop_domain: string;
            active_events: import("@prisma/client/runtime/library").JsonValue;
        } | null;
        audit: {
            id: number;
            action: string;
            entity: string;
            entity_id: number | null;
            ip_address: string | null;
            metadata: import("@prisma/client/runtime/library").JsonValue;
            created_at: Date;
            user: {
                id: number;
                name: string;
                email: string;
            } | null;
        }[];
    }>;
    activateClient(id: number): Promise<{
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    suspendClient(id: number): Promise<{
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    setLimitOverrides(id: number, body: {
        contact_limit?: number | null;
        template_limit?: number | null;
        user_limit?: number | null;
    }): Promise<{
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    grantGrace(id: number, until: Date | null): Promise<{
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    setUsageLimitAction(id: number, action: 'block' | 'warn_only' | null): Promise<{
        created_at: Date;
        id: number;
        usage_limit_action: import(".prisma/client").$Enums.UsageLimitAction | null;
        address: string | null;
        company_name: string;
        activation_status: import(".prisma/client").$Enums.ActivationStatus;
        waba_id: string | null;
        phone_number_id: string | null;
        onboarding_status: import("@prisma/client/runtime/library").JsonValue;
        webhook_key: string | null;
        webhook_app_secret_encrypted: string | null;
        webhook_verify_token: string | null;
        shopify_webhook_key: string | null;
        shopify_webhook_secret_encrypted: string | null;
        shopify_admin_token_encrypted: string | null;
        default_country_code: string | null;
        logo_url: string | null;
        activated_at: Date | null;
        suspended_at: Date | null;
        grace_until: Date | null;
        contact_limit_override: number | null;
        template_limit_override: number | null;
        user_limit_override: number | null;
        subscription_id: number;
    }>;
    createOneOffInvoice(companyId: number, data: {
        amount: number;
        description?: string | null;
        dueDate?: string | null;
    }): Promise<{
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        description: string | null;
        period: string | null;
        amount: import("@prisma/client/runtime/library").Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
        plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    deleteClient(id: number): Promise<{
        message: string;
    }>;
    getPlans(): Promise<{
        id: number;
        plan_name: string;
        contact_limit: number;
        template_limit: number;
        user_limit: number;
        monthly_price: import("@prisma/client/runtime/library").Decimal;
        setup_fee: import("@prisma/client/runtime/library").Decimal;
        webhook_enabled: boolean;
    }[]>;
    createPlan(data: {
        plan_name: string;
        contact_limit: number;
        template_limit: number;
        user_limit: number;
        monthly_price: number;
        setup_fee: number;
        webhook_enabled?: boolean;
    }): Promise<{
        id: number;
        plan_name: string;
        contact_limit: number;
        template_limit: number;
        user_limit: number;
        monthly_price: import("@prisma/client/runtime/library").Decimal;
        setup_fee: import("@prisma/client/runtime/library").Decimal;
        webhook_enabled: boolean;
    }>;
    updatePlan(id: number, data: Partial<ReturnType<typeof this.createPlan>>): Promise<{
        id: number;
        plan_name: string;
        contact_limit: number;
        template_limit: number;
        user_limit: number;
        monthly_price: import("@prisma/client/runtime/library").Decimal;
        setup_fee: import("@prisma/client/runtime/library").Decimal;
        webhook_enabled: boolean;
    }>;
    getInvoices(page?: number, limit?: number): Promise<{
        items: ({
            company: {
                company_name: string;
            };
        } & {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            description: string | null;
            period: string | null;
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
        })[];
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getUsage(): Promise<({
        company: {
            subscription: {
                id: number;
                plan_name: string;
                contact_limit: number;
                template_limit: number;
                user_limit: number;
                monthly_price: import("@prisma/client/runtime/library").Decimal;
                setup_fee: import("@prisma/client/runtime/library").Decimal;
                webhook_enabled: boolean;
            };
            company_name: string;
        };
    } & {
        id: number;
        updated_at: Date;
        company_id: number;
        contacts_stored: number;
        templates_used: number;
        period: string;
        messages_sent: number;
        webhook_calls: number;
        conversations_opened: number;
        thresholds_notified: import("@prisma/client/runtime/library").JsonValue | null;
    })[]>;
    getAuditLogs(page?: number, limit?: number): Promise<{
        items: ({
            user: {
                name: string;
                email: string;
            } | null;
        } & {
            created_at: Date;
            id: number;
            company_id: number | null;
            user_id: number | null;
            action: string;
            entity: string;
            entity_id: number | null;
            metadata: import("@prisma/client/runtime/library").JsonValue | null;
            ip_address: string | null;
        })[];
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    impersonate(companyId: number, actingAdminId: number): Promise<{
        impersonationToken: string;
    }>;
}
