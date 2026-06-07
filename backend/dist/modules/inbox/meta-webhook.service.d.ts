import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { BotEngineService } from '../bots/bot-engine.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
export declare class MetaWebhookService implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly metering;
    private readonly metaClient;
    private readonly gateway;
    private readonly botEngine;
    private readonly webhookDispatcher;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, metering: UsageMeteringService, metaClient: MetaClientService, gateway: InboxGateway, botEngine: BotEngineService, webhookDispatcher: WebhookDispatcherService);
    onModuleInit(): void;
    handle(payload: unknown): Promise<void>;
    private resolveCompany;
    private handleInbound;
    private handleStatus;
    private handleReaction;
    private normalizeType;
    private extractMediaId;
}
