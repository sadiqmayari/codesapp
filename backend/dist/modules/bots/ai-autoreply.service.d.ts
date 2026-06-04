import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { AiService } from '../ai/ai.service';
import { InboxService } from '../inbox/inbox.service';
export declare const AI_HANDOFF_LABEL = "needs-human";
interface AutoReplyJob {
    companyId: number;
    conversationId: number;
    messageId: number;
    force?: boolean;
    skipOrder?: boolean;
}
export declare class AiAutoReplyService implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly ai;
    private readonly inboxService;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, ai: AiService, inboxService: InboxService);
    onModuleInit(): void;
    enqueue(job: AutoReplyJob): Promise<void>;
    private process;
    private handoff;
}
export {};
