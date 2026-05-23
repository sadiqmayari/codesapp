import { BillingService } from './billing.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
export declare class BillingController {
    private readonly billing;
    constructor(billing: BillingService);
    listInvoices(user: {
        companyId: number;
    }, dto: ListInvoicesDto): Promise<{
        success: boolean;
        data: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            invoice_number: string | null;
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            period: string | null;
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
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        invoice_number: string | null;
        amount: import("@prisma/client/runtime/library").Decimal;
        due_date: Date;
        paid_at: Date | null;
        period: string | null;
        description: string | null;
        plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
}
