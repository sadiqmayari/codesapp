import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { JobQueueService } from '../../common/services/job-queue.service';
export interface WebhookJobPayload {
    webhookEndpointId: number;
    event: string;
    companyId: number;
    data: unknown;
    enqueuedAt: string;
}
export declare class WebhookDispatcherService {
    private readonly prisma;
    private readonly cache;
    private readonly jobQueue;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, jobQueue: JobQueueService);
    static cacheKey(companyId: number): string;
    invalidate(companyId: number): void;
    dispatch(companyId: number, event: string, data: unknown): Promise<void>;
    private loadActiveEndpoints;
}
