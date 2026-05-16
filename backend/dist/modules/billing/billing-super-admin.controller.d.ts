import { BillingService } from './billing.service';
export declare class BillingSuperAdminController {
    private readonly billing;
    constructor(billing: BillingService);
    overview(): Promise<{
        mrr: number;
        revenueByPlan: {
            plan: string;
            companies: number;
            mrr: number;
        }[];
        overdueCount: number;
    }>;
    markPaid(id: number): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        amount: import("@prisma/client/runtime/library").Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
        period: string | null;
        description: string | null;
        plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    generate(): Promise<{
        period: string;
        created: number;
        skipped: number;
    }>;
}
