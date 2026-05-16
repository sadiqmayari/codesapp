import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { DateRangeDto } from './dtos/date-range.dto';
export declare class AnalyticsService {
    private readonly prisma;
    private readonly cache;
    private readonly config;
    constructor(prisma: PrismaService, cache: CacheService, config: ConfigService);
    private resolveRange;
    private cached;
    overview(companyId: number): Promise<{
        totalContacts: number;
        activeConversations: number;
        openChats: number;
        messagesThisMonth: number;
        deliveryRate: number;
        readRate: number;
        replyRate: number;
        botHandledPct: number;
    }>;
    funnel(companyId: number, dto: DateRangeDto): Promise<{
        date: string;
        sent: number;
        delivered: number;
        read: number;
        replied: number;
    }[]>;
    agents(companyId: number, dto: DateRangeDto): Promise<{
        userId: number;
        name: string;
        conversationsHandled: number;
        avgResponseTimeMin: number;
        messagesSent: number;
    }[]>;
    broadcast(companyId: number, broadcastId: number): Promise<{
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
    conversationCost(companyId: number, dto: DateRangeDto): Promise<{
        totalConversations: number;
        estimatedCostUSD: number;
        rateUsed: number;
        note: string;
    }>;
    usage(companyId: number): Promise<{
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
}
