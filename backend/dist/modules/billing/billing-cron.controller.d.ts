import { BillingService } from './billing.service';
export declare class BillingCronController {
    private readonly billing;
    constructor(billing: BillingService);
    autoInvoice(): Promise<{
        created: number;
        skipped: number;
        ran: boolean;
    }>;
    enforce(): Promise<{
        ran: boolean;
        markedOverdue: number;
        suspended: number;
    }>;
}
