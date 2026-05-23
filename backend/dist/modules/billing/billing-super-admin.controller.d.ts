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
        invoice_number: string | null;
        amount: import("@prisma/client/runtime/library").Decimal;
        due_date: Date;
        paid_at: Date | null;
        period: string | null;
        description: string | null;
        plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    generate(): Promise<{
        created: number;
        skipped: number;
    }>;
    rewriteLegacy(body: {
        dryRun?: boolean;
        companyId?: number | null;
    }): Promise<{
        mode: "dry-run" | "apply";
        inspected: number;
        candidates: number;
        skipped: number;
        updated: number;
        collisions: Array<{
            id: number;
            collidesWith: number;
        }>;
        changes: Array<{
            id: number;
            companyId: number;
            companyName: string | null;
            oldNumber: string | null;
            newNumber: string;
            newDueDate: string;
            newPeriod: string;
        }>;
    }>;
}
