import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { CompanyStatusService } from '../../common/services/company-status.service';
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
    private readonly companyStatus;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, jobQueue: JobQueueService, companyStatus: CompanyStatusService);
    static cacheKey(companyId: number): string;
    static featureKey(companyId: number): string;
    invalidate(companyId: number): void;
    isWebhookFeatureEnabled(companyId: number): Promise<boolean>;
    dispatch(companyId: number, event: string, data: unknown): Promise<void>;
    private loadActiveEndpoints;
}
