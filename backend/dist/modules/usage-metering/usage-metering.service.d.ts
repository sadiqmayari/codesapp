import { PrismaService } from '../../prisma/prisma.service';
import { LimitWarningService } from '../billing/limit-warning.service';
export declare class UsageMeteringService {
    private readonly prisma;
    private readonly limitWarning;
    constructor(prisma: PrismaService, limitWarning: LimitWarningService);
    private currentPeriod;
    private increment;
    incrementMessages(companyId: number): Promise<void>;
    incrementContacts(companyId: number): Promise<void>;
    incrementTemplates(companyId: number): Promise<void>;
    incrementWebhookCalls(companyId: number): Promise<void>;
    incrementConversations(companyId: number): Promise<void>;
    getUsage(companyId: number): Promise<{
        id: number;
        updated_at: Date;
        company_id: number;
        period: string;
        messages_sent: number;
        contacts_stored: number;
        templates_used: number;
        webhook_calls: number;
        conversations_opened: number;
    } | null>;
}
