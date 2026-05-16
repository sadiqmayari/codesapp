import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
export declare class WebhookWorker implements OnModuleInit {
    private readonly prisma;
    private readonly jobQueue;
    private readonly encryption;
    private readonly delivery;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, encryption: EncryptionService, delivery: WebhookDeliveryService);
    onModuleInit(): void;
    handle(rawPayload: unknown): Promise<void>;
}
