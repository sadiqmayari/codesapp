import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { AiService } from '../ai/ai.service';
import { InboxService } from '../inbox/inbox.service';
import { InboxGateway } from '../inbox/inbox.gateway';
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
    private readonly platformSetting;
    private readonly inboxService;
    private readonly gateway;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, ai: AiService, platformSetting: PlatformSettingService, inboxService: InboxService, gateway: InboxGateway);
    onModuleInit(): void;
    enqueue(job: AutoReplyJob): Promise<void>;
    private process;
    private handoff;
}
export {};
