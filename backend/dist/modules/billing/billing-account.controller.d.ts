import { BillingService } from './billing.service';
export declare class BillingAccountController {
    private readonly billing;
    constructor(billing: BillingService);
    accountStatus(user: {
        companyId: number;
    }): Promise<{
        activationStatus: import(".prisma/client").$Enums.ActivationStatus;
        suspendedForBilling: boolean;
        suspendedAt: Date | null;
        graceUntil: Date | null;
        unpaidInvoices: {
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
        }[];
    }>;
}
