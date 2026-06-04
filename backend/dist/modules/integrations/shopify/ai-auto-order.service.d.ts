import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { AiService } from '../../ai/ai.service';
import { InboxService } from '../../inbox/inbox.service';
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
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, ai: AiService, shopify: ShopifyService, inbox: InboxService);
    onModuleInit(): void;
    enqueue(job: AutoOrderJob): Promise<void>;
    private process;
    private fallbackReply;
    private handoff;
    private label;
}
export {};
