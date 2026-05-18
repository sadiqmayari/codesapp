import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
export declare class SuperAdminService {
    private readonly prisma;
    private readonly jwt;
    private readonly config;
    constructor(prisma: PrismaService, jwt: JwtService, config: ConfigService);
    login(email: string, password: string, res: any): Promise<{
        accessToken: string;
    }>;
    refresh(refreshToken: string | undefined, res: any): Promise<{
        accessToken: string;
    }>;
    getDashboard(): Promise<{
        totalCompanies: number;
        totalUsers: number;
        pendingCompanies: number;
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
        subscription_id: number;
    }>;
    activateClient(id: number): Promise<{
        created_at: Date;
        id: number;
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
        subscription_id: number;
    }>;
    suspendClient(id: number): Promise<{
        created_at: Date;
        id: number;
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
        subscription_id: number;
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
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            period: string | null;
            description: string | null;
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
        company_id: number;
        updated_at: Date;
        period: string;
        messages_sent: number;
        contacts_stored: number;
        templates_used: number;
        webhook_calls: number;
        conversations_opened: number;
    })[]>;
    getAuditLogs(page?: number, limit?: number): Promise<{
        items: ({
            user: {
                name: string;
                email: string;
            };
        } & {
            created_at: Date;
            id: number;
            company_id: number | null;
            user_id: number;
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
