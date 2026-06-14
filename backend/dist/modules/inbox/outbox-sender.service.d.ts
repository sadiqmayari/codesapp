import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxService } from './inbox.service';
export declare class OutboxSenderService implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly inbox;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, inbox: InboxService);
    onModuleInit(): void;
    private process;
    private markFailed;
}
