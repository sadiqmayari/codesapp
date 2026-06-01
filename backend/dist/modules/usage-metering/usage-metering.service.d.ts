import { PrismaService } from '../../prisma/prisma.service';
import { LimitWarningService } from '../billing/limit-warning.service';
import { LimitNotifierService } from '../billing/limit-notifier.service';
export declare class UsageMeteringService {
    private readonly prisma;
    private readonly limitWarning;
    private readonly limitNotifier;
    constructor(prisma: PrismaService, limitWarning: LimitWarningService, limitNotifier: LimitNotifierService);
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
        ai_requests: number;
        ai_input_tokens: number;
        ai_output_tokens: number;
        ai_cost_micros: bigint;
        thresholds_notified: import("@prisma/client/runtime/library").JsonValue | null;
    } | null>;
}
