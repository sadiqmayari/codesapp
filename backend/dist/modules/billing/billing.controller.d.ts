import { BillingService } from './billing.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { RequestPlanChangeDto } from './dtos/request-plan-change.dto';
export declare class BillingController {
    private readonly billing;
    constructor(billing: BillingService);
    getPlanRequest(user: {
        companyId: number;
    }): Promise<{
        request: null;
    } | {
        request: {
            requestedPlanName: string | null;
            status: string;
            created_at: Date;
            id: number;
            updated_at: Date;
            company_id: number;
            note: string | null;
            requested_subscription_id: number | null;
            current_subscription_id: number | null;
            created_by_user_id: number | null;
            resolved_at: Date | null;
            resolution_note: string | null;
        };
    }>;
    requestPlanChange(user: {
        companyId: number;
        userId: number;
    }, dto: RequestPlanChangeDto): Promise<{
        request: {
            requestedPlanName: string | null;
            status: string;
            created_at: Date;
            id: number;
            updated_at: Date;
            company_id: number;
            note: string | null;
            requested_subscription_id: number | null;
            current_subscription_id: number | null;
            created_by_user_id: number | null;
            resolved_at: Date | null;
            resolution_note: string | null;
        };
    }>;
    listInvoices(user: {
        companyId: number;
    }, dto: ListInvoicesDto): Promise<{
        success: boolean;
        data: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            period: string | null;
            invoice_number: string | null;
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            description: string | null;
            plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    subscription(user: {
        companyId: number;
    }): Promise<{
        plan: string;
        monthlyPrice: import("@prisma/client/runtime/library").Decimal;
        limits: {
            contactLimit: number;
            templateLimit: number;
            userLimit: number;
        };
        aiUsage: {
            billedCents: number;
            cycleStart: string;
            nextInvoiceDate: string;
        } | null;
        features: {
            webhookEnabled: boolean;
            aiEnabled: boolean;
        };
        period: string;
        usage: {
            messagesSent: number;
            contactsStored: number;
            templatesUsed: number;
            webhookCalls: number;
            conversationsOpened: number;
        };
    }>;
    getInvoice(user: {
        companyId: number;
    }, id: number): Promise<{
        company: {
            id: number;
            name: string;
            address: string | null;
            logo_url: string | null;
            timezone: string | null;
            activated_at: Date | null;
            owner: {
                name: string;
                email: string;
            };
            plan: {
                plan_name: string;
                monthly_price: import("@prisma/client/runtime/library").Decimal;
                setup_fee: import("@prisma/client/runtime/library").Decimal;
            };
        };
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        period: string | null;
        invoice_number: string | null;
        amount: import("@prisma/client/runtime/library").Decimal;
        due_date: Date;
        paid_at: Date | null;
        description: string | null;
        plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
}
