import { BillingService } from './billing.service';
import { LimitNotifierService } from './limit-notifier.service';
export declare class BillingAccountController {
    private readonly billing;
    private readonly limitNotifier;
    constructor(billing: BillingService, limitNotifier: LimitNotifierService);
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
            description: string | null;
            period: string | null;
            amount: import("@prisma/client/runtime/library").Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            plan_snapshot: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
    }>;
    usageWarnings(user: {
        companyId: number;
    }): Promise<{
        dim: "contacts" | "templates";
        threshold: "90" | "99" | "100";
        pct: number;
        current: number;
        limit: number;
        severity: "warn" | "critical";
    }[]>;
}
