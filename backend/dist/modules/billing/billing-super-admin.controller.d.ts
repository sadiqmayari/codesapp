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
    generate(): Promise<{
        created: number;
        skipped: number;
    }>;
}
