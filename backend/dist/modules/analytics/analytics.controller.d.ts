import { AnalyticsService } from './analytics.service';
import { DateRangeDto } from './dtos/date-range.dto';
export declare class AnalyticsController {
    private readonly analytics;
    constructor(analytics: AnalyticsService);
    overview(user: {
        companyId: number;
    }): Promise<{
        totalContacts: number;
        activeConversations: number;
        openChats: number;
        messagesThisMonth: number;
        deliveryRate: number;
        readRate: number;
        replyRate: number;
        botHandledPct: number;
    }>;
    funnel(user: {
        companyId: number;
    }, dto: DateRangeDto): Promise<{
        date: string;
        sent: number;
        delivered: number;
        read: number;
        replied: number;
    }[]>;
    agents(user: {
        companyId: number;
    }, dto: DateRangeDto): Promise<{
        userId: number;
        name: string;
        conversationsHandled: number;
        avgResponseTimeMin: number;
        messagesSent: number;
    }[]>;
    conversationCost(user: {
        companyId: number;
    }, dto: DateRangeDto): Promise<{
        totalConversations: number;
        estimatedCostUSD: number;
        rateUsed: number;
        note: string;
    }>;
    usage(user: {
        companyId: number;
    }): Promise<{
        period: string;
        usage: {
            messagesSent: number;
            contactsStored: number;
            templatesUsed: number;
            webhookCalls: number;
            conversationsOpened: number;
        };
        limits: {
            contactLimit: number;
            templateLimit: number;
            userLimit: number;
        } | null;
    }>;
    broadcast(user: {
        companyId: number;
    }, id: number): Promise<{
        sent: number;
        delivered: number;
        read: number;
        failed: number;
        replyCount: number;
        deliveryByHour: {
            hour: number;
            count: number;
        }[];
    }>;
}
