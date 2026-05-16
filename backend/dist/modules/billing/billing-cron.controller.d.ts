import { BillingService } from './billing.service';
export declare class BillingCronController {
    private readonly billing;
    constructor(billing: BillingService);
    autoInvoice(): Promise<{
        ran: boolean;
        reason: string;
        day: number;
    } | {
        period: string;
        created: number;
        skipped: number;
        ran: boolean;
        reason?: undefined;
        day?: undefined;
    }>;
}
