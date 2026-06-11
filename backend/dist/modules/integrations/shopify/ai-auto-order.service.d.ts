import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { PlatformSettingService } from '../../../common/services/platform-setting.service';
import { CompanyStatusService } from '../../../common/services/company-status.service';
import { AiService } from '../../ai/ai.service';
import { InboxService } from '../../inbox/inbox.service';
import { InboxGateway } from '../../inbox/inbox.gateway';
import { ShopifyService } from './shopify.service';
interface AutoOrderJob {
    companyId: number;
    conversationId: number;
    messageId: number;
}
export declare class AiAutoOrderService implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly ai;
    private readonly shopify;
    private readonly inbox;
    private readonly gateway;
    private readonly platformSetting;
    private readonly companyStatus;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, ai: AiService, shopify: ShopifyService, inbox: InboxService, gateway: InboxGateway, platformSetting: PlatformSettingService, companyStatus: CompanyStatusService);
    onModuleInit(): void;
    enqueue(job: AutoOrderJob): Promise<void>;
    private process;
    private storePending;
    private send;
    private handleOrderStatus;
    private composeSummary;
    private cartSignature;
    private parsePendingItems;
    private latestInboundText;
    private isOrderAffirmation;
    private buildOrderSummary;
    private buildMissingPrompt;
    private fallbackReply;
    private handoff;
    private label;
}
export {};
