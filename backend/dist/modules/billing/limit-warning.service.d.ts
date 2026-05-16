import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
export declare class LimitWarningService {
    private readonly prisma;
    private readonly cache;
    private readonly dispatcher;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, dispatcher: WebhookDispatcherService);
    private static msUntilMonthEnd;
    private loadSubAndUsage;
    check(companyId: number, dimension: string): Promise<void>;
}
