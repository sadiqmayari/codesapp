import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { MetaClientService } from '../inbox/meta-client.service';
import { BroadcastsService } from './broadcasts.service';
interface BroadcastSendPayload {
    kind: 'send';
    broadcastId: number;
    companyId: number;
    contactId: number;
    templateId: number;
    variables?: Record<string, string>;
    total: number;
}
interface BroadcastDispatchPayload {
    kind: 'dispatch';
    broadcastId: number;
    companyId: number;
}
type BroadcastJobPayload = BroadcastSendPayload | BroadcastDispatchPayload;
export declare class BroadcastWorker implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly broadcasts;
    private readonly metaClient;
    private readonly gateway;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, broadcasts: BroadcastsService, metaClient: MetaClientService, gateway: InboxGateway);
    onModuleInit(): void;
    handle(payload: BroadcastJobPayload): Promise<void>;
    private buildComponents;
}
export {};
