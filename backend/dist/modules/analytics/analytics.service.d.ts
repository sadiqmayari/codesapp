import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { DateRangeDto } from './dtos/date-range.dto';
import { DashboardDto } from './dtos/dashboard.dto';
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
    dashboard(companyId: number, dto: DashboardDto): Promise<{
        range: {
            from: string;
            to: string;
            prevFrom: string | null;
            prevTo: string | null;
            granularity: "hour" | "day";
            spanDays: number;
        };
        kpis: {
            messagesSent: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            messagesReceived: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            activeConversations: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            uniqueContactsEngaged: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            newContacts: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            deliveryRate: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            readRate: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            replyRate: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            avgFirstResponseSec: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
            botHandledPct: {
                value: number;
                prev: number | null;
                deltaPct: number | null;
            };
        };
        trend: {
            bucket: string;
            sent: number;
            received: number;
            delivered: number;
            read: number;
        }[];
        funnel: {
            sent: number;
            delivered: number;
            read: number;
            replied: number;
        };
        statusBreakdown: Record<string, number>;
        hourlyHeatmap: {
            dow: number;
            hour: number;
            count: number;
        }[];
        agents: {
            userId: number;
            name: string;
            sent: number;
            conversations: number;
            avgResponseSec: number | null;
        }[];
        topContacts: {
            contactId: number;
            name: string;
            phone: string;
            messages: number;
            lastSeenAt: string | null;
        }[];
        cost: {
            totalConversations: number;
            estimatedCostUSD: number;
            rateUsed: number;
            note: string;
        };
        usage: {
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
        };
    }>;
    private kpisForWindow;
    private trendSeries;
    private funnelTotals;
    private statusBreakdown;
    private hourlyHeatmap;
    private agentLeaderboard;
    private topContacts;
    private cachedShort;
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
